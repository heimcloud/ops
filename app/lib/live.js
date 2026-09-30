/**
 * Live updates for the admin board / queue page.
 *
 * Revision = DB watermarks (max event id, max fix attempt id, latest incident
 * update, incident count) + a signature of the exchange dirs (mtime/size of
 * queue/<kind>, processing, done, failed, control, worker-status.json,
 * systemd-status.json). It is self-describing (base64url JSON), so the diff
 * between any client revision and now is computed statelessly:
 *   { incidents: [ids] | "all", worker: bool }
 *
 * Transports:
 *  - GET <admin>/events    Server-Sent Events. "change" events, ": hb"
 *                          comment every 15 s, X-Accel-Buffering: no so nginx
 *                          (SWAG) streams instead of buffering.
 *  - GET <admin>/live.json Polling fallback. ETag = revision; an unchanged
 *                          poll with If-None-Match is a bodiless 304.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getWatermarks, incidentIdsChangedSince } from "./db.js";
import { getDataDir } from "./queue.js";

const FS_PARTS = [
  "queue/triage",
  "queue/fix",
  "queue/push",
  "queue/processing",
  "queue/done",
  "queue/failed",
  "queue/control",
  "queue/worker-status.json",
  "queue/systemd-status.json",
];

export function fsSignature() {
  const root = getDataDir();
  const h = crypto.createHash("sha1");
  for (const p of FS_PARTS) {
    try {
      const st = fs.statSync(path.join(root, p));
      h.update(`${p}:${st.mtimeMs}:${st.size};`);
    } catch {
      h.update(`${p}:-;`);
    }
  }
  // control/ file contents change without touching the dir mtime on some fs.
  try {
    const c = path.join(root, "queue", "control");
    for (const f of fs.readdirSync(c).sort()) {
      const st = fs.statSync(path.join(c, f));
      h.update(`c/${f}:${st.mtimeMs};`);
    }
  } catch {
    /* none */
  }
  return h.digest("base64url").slice(0, 12);
}

export function currentRevision() {
  return { ...getWatermarks(), fs: fsSignature() };
}

export function encodeRev(r) {
  return Buffer.from(JSON.stringify([r.ev, r.fa, r.up, r.n, r.fs])).toString("base64url");
}

export function decodeRev(s) {
  try {
    const a = JSON.parse(Buffer.from(String(s || ""), "base64url").toString("utf8"));
    if (!Array.isArray(a) || a.length !== 5) return null;
    return { ev: Number(a[0]) || 0, fa: Number(a[1]) || 0, up: String(a[2] || ""), n: Number(a[3]) || 0, fs: String(a[4] || "") };
  } catch {
    return null;
  }
}

/** What changed between two revisions (old may be null = unknown client). */
export function diffRev(old, cur) {
  if (!old) return { incidents: "all", worker: true };
  const dbChanged = old.ev !== cur.ev || old.fa !== cur.fa || old.up !== cur.up || old.n !== cur.n;
  let incidents = [];
  if (dbChanged) {
    const ids = incidentIdsChangedSince(old);
    incidents = ids.length > 200 || cur.n < old.n ? "all" : ids;
  }
  return { incidents, worker: old.fs !== cur.fs };
}

export function sameRev(a, b) {
  return Boolean(a && b) && a.ev === b.ev && a.fa === b.fa && a.up === b.up && a.n === b.n && a.fs === b.fs;
}

/** Payload for one client: { rev, incidents, worker }. */
export function changePayload(oldRev, cur = currentRevision()) {
  return { rev: encodeRev(cur), ...diffRev(oldRev, cur) };
}

// ------------------------------------------------------------------ SSE hub

const clients = new Set();
let ticker = null;
let hbTimer = null;

function tickMs() {
  const v = Number(process.env.OPS_LIVE_TICK_MS || 1500);
  return Number.isFinite(v) && v >= 100 ? v : 1500;
}
function heartbeatMs() {
  const v = Number(process.env.OPS_LIVE_HEARTBEAT_MS || 15000);
  return Number.isFinite(v) && v >= 100 ? v : 15000;
}

function send(c, event, data) {
  try {
    // id = revision: EventSource resends it as Last-Event-ID on reconnect.
    c.res.write(`${data.rev ? `id: ${data.rev}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    drop(c);
  }
}

function drop(c) {
  clients.delete(c);
  if (!clients.size) {
    clearInterval(ticker);
    clearInterval(hbTimer);
    ticker = null;
    hbTimer = null;
  }
}

function tick() {
  let cur;
  try {
    cur = currentRevision();
  } catch (err) {
    console.error("[live] revision", err.message);
    return;
  }
  for (const c of clients) {
    if (sameRev(c.rev, cur)) continue;
    let payload;
    try {
      payload = changePayload(c.rev, cur);
    } catch (err) {
      console.error("[live] diff", err.message);
      payload = { rev: encodeRev(cur), incidents: "all", worker: true };
    }
    c.rev = cur;
    send(c, "change", payload);
  }
}

/** Express handler for GET <admin>/events. */
export function sseHandler(req, res) {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx / SWAG: disable proxy buffering for this response only.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  req.socket?.setTimeout?.(0);
  req.socket?.setNoDelay?.(true);
  const fromQuery = decodeRev(req.query.rev);
  const fromHeader = decodeRev(req.get("last-event-id"));
  const c = { res, rev: fromHeader || fromQuery };
  clients.add(c);
  res.write(`retry: 3000\n: connected\n\n`);
  // Catch up at once (page older than the stream, or a reconnect).
  const cur = currentRevision();
  if (!sameRev(c.rev, cur)) {
    const payload = changePayload(c.rev, cur);
    c.rev = cur;
    send(c, "change", payload);
  } else {
    send(c, "hello", { rev: encodeRev(cur) });
  }
  if (!ticker) {
    ticker = setInterval(tick, tickMs());
    ticker.unref?.();
    hbTimer = setInterval(() => {
      for (const cl of clients) {
        try {
          // Comment keeps proxies from timing out; the ping event lets the
          // client notice a silent (buffered) stream.
          cl.res.write(`: hb ${Date.now()}\n\nevent: ping\ndata: {}\n\n`);
        } catch {
          drop(cl);
        }
      }
    }, heartbeatMs());
    hbTimer.unref?.();
  }
  const bye = () => drop(c);
  req.on("close", bye);
  res.on("error", bye);
}

/** Express handler for GET <admin>/live.json (polling fallback). */
export function pollHandler(req, res) {
  const cur = currentRevision();
  const tag = `"${encodeRev(cur)}"`;
  res.set("Cache-Control", "no-cache");
  res.set("ETag", tag);
  const inm = String(req.get("if-none-match") || "");
  if (inm && inm.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(tag)) {
    return res.status(304).end();
  }
  const old = decodeRev(req.query.rev);
  return res.json(changePayload(old, cur));
}

export function _liveClientsForTests() {
  return clients.size;
}
