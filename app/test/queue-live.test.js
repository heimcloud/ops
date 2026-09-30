/**
 * Queue view + worker panel + live updates (app side): claim-order listing,
 * priority / reorder / cancel / retry / pause actions with incident events,
 * stale heartbeat display, SSE change events + heartbeat, ETag polling, and
 * redaction of every queue/worker surface. Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-queue-live-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_REDACT_EXTRA_SLUGS = "YYBURNED01";
process.env.OPS_LIVE_TICK_MS = "100";
process.env.OPS_LIVE_HEARTBEAT_MS = "300";
delete process.env.ADMIN_READ_ONLY;

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { createAdminRouter } = await import("../lib/admin.js");
const { applyResult } = await import("../lib/results.js");
const QC = await import("../lib/queue-control.js");

const Q = path.join(tmpDir, "queue");
for (const d of ["triage", "fix", "push", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(Q, d), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "results"), { recursive: true });

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let n = 0;
function incident(extra = {}) {
  n += 1;
  return db.upsertIncident({ report_hash: `ql-${n}`, unit: "docker-searxng.service", severity: "warning", logs_excerpt: "x", ...extra }).incident;
}
function job(kind, id, sec, extra = {}) {
  const name = `${id}-2026-09-30T10-00-${String(sec).padStart(2, "0")}-000Z.json`;
  fs.writeFileSync(path.join(Q, kind, name), JSON.stringify({ job_version: 1, kind, incident_id: id, ...extra }));
  return name;
}
function writeStatus(st) {
  fs.writeFileSync(path.join(Q, "worker-status.json"), JSON.stringify({ version: 2, fork_push_token: true, reason: null, checked_at: new Date().toISOString(), hermes_timeout_sec: 2700, lab_timeout_sec: 1800, max_attempts: 2, kinds: ["triage", "fix", "push"], ...st }));
}

async function withAdmin(fn) {
  const app = express();
  app.use("/admin", createAdminRouter());
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  try {
    return await fn(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function request(port, method, p, { json, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : "";
    const h = {
      ...(json !== undefined ? { "content-type": "application/json", accept: "application/json" } : {}),
      ...(form !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...headers,
    };
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* html */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json: parsed });
      });
    });
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}
const events = (id) => db.listIncidentEvents(id, { limit: 50 });
function clear() {
  for (const d of ["triage", "fix", "push", "processing", "done", "failed", "control"]) {
    for (const f of fs.readdirSync(path.join(Q, d))) fs.rmSync(path.join(Q, d, f), { force: true });
  }
}

test("queue view lists pending in claim order; priority, move, cancel, retry and pause work and write events", async () => {
  clear();
  const a = incident();
  const b = incident();
  const c = incident();
  db.updateIncident(c.id, { status: "fixing" });
  const ja = job("fix", a.id, 1);
  const jb = job("triage", b.id, 2);
  const jc = job("fix", c.id, 3);
  await withAdmin(async (port) => {
    let q = (await request(port, "GET", "/admin/queue.json")).json.queue;
    // Default: triage before fix, then age.
    assert.deepEqual(q.pending.map((j) => j.incidentId), [b.id, a.id, c.id]);

    let r = await request(port, "POST", "/admin/queue/priority", { json: { kind: "fix", job: jc, priority: "high" } });
    assert.equal(r.status, 200, r.body);
    q = (await request(port, "GET", "/admin/queue.json")).json.queue;
    assert.deepEqual(q.pending.map((j) => j.incidentId), [c.id, b.id, a.id]);
    assert.ok(events(c.id).some((e) => e.kind === "job_priority" && /normal -> high/.test(e.message)));

    r = await request(port, "POST", "/admin/queue/move", { json: { kind: "fix", job: ja, direction: "up" } });
    assert.equal(r.status, 200, r.body);
    q = (await request(port, "GET", "/admin/queue.json")).json.queue;
    assert.deepEqual(q.pending.map((j) => j.incidentId), [c.id, a.id, b.id]);
    assert.ok(events(a.id).some((e) => e.kind === "job_reordered" && /position 3 -> 2/.test(e.message)));
    // The worker reads the same sidecar and gets the same order.
    assert.deepEqual(QC.listPending(Q).map((j) => j.name), [jc, ja, jb]);

    // Cancel pending fix: job -> failed with a reason, incident fixing -> triaged, event.
    r = await request(port, "POST", "/admin/queue/cancel", { json: { kind: "fix", job: jc } });
    assert.equal(r.status, 200, r.body);
    assert.ok(fs.existsSync(path.join(Q, "failed", `fix-${jc}`)));
    assert.equal(db.getIncident(c.id).status, "triaged");
    const ev = events(c.id).find((e) => e.kind === "job_cancelled");
    assert.match(ev.message, /fixing -> triaged/);
    // Cancelling the same job again: 409, nothing else happens.
    r = await request(port, "POST", "/admin/queue/cancel", { json: { kind: "fix", job: jc } });
    assert.equal(r.status, 409);

    // Retry the cancelled job: fresh pending job, event, marked retried.
    q = (await request(port, "GET", "/admin/queue.json")).json.queue;
    const f = q.failed.find((x) => x.name === `fix-${jc}`);
    assert.equal(f.code, "cancelled");
    assert.equal(f.canRetry, true);
    r = await request(port, "POST", "/admin/queue/retry", { json: { job: `fix-${jc}` } });
    assert.equal(r.status, 200, r.body);
    assert.equal(fs.readdirSync(path.join(Q, "fix")).filter((x) => x.startsWith(`${c.id}-`)).length, 1);
    assert.equal(db.getIncident(c.id).status, "fixing");
    assert.ok(events(c.id).some((e) => e.kind === "fix_enqueued" && /retry of failed job/.test(e.message)));
    r = await request(port, "POST", "/admin/queue/retry", { json: { job: `fix-${jc}` } });
    assert.equal(r.status, 409, "second retry refused");

    // Pause / resume = flag file only.
    r = await request(port, "POST", "/admin/queue/pause", { json: {} });
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(path.join(Q, "control", "paused.json")));
    const page = await request(port, "GET", "/admin/queue");
    assert.match(page.body, /Resume queue/);
    assert.match(page.body, /Queue paused/);
    r = await request(port, "POST", "/admin/queue/resume", { form: { return_to: "board" } });
    assert.equal(r.status, 303);
    assert.match(r.headers.location, /^\/admin\/\?msg=/);
    assert.equal(fs.existsSync(path.join(Q, "control", "paused.json")), false);

    // Bad input + cross-origin.
    assert.equal((await request(port, "POST", "/admin/queue/priority", { json: { kind: "fix", job: "../../etc/passwd", priority: "high" } })).status, 400);
    assert.equal((await request(port, "POST", "/admin/queue/pause", { json: {}, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal(fs.existsSync(path.join(Q, "control", "paused.json")), false);
  });
});

test("cancel running job raises the flag and records an event", async () => {
  clear();
  const a = incident();
  const pname = `triage-${a.id}-2026-09-30T10-00-09-000Z.json`;
  fs.writeFileSync(path.join(Q, "processing", pname), JSON.stringify({ incident_id: a.id, _claims: 1, _claimed_at: new Date().toISOString() }));
  writeStatus({ state: "running", heartbeat_at: new Date().toISOString(), job: { kind: "triage", incident_id: a.id, name: pname.slice(7), processing: pname, stage: "hermes", attempt: 1, max_attempts: 1, started_at: new Date().toISOString() } });
  await withAdmin(async (port) => {
    const r = await request(port, "POST", "/admin/queue/cancel-running", { json: { job: pname } });
    assert.equal(r.status, 200, r.body);
    assert.ok(fs.existsSync(path.join(Q, "control", `cancel-${pname}`)));
    assert.ok(events(a.id).some((e) => e.kind === "job_cancel_requested" && /Hermes/.test(e.message)));
    const page = await request(port, "GET", "/admin/queue");
    assert.match(page.body, /cancel requested/);
  });
  // The worker's cancelled result lands the incident in a sane status.
  db.updateIncident(a.id, { status: "open" });
  applyResult({ kind: "triage", incident_id: a.id, status: "triage_cancelled", summary: "Triage cancelled by admin during hermes." });
  assert.equal(db.getIncident(a.id).status, "open");
  const f = incident();
  db.updateIncident(f.id, { status: "fixing" });
  applyResult({ kind: "fix", incident_id: f.id, status: "cancelled", summary: "Fix cancelled by admin during hermes; nothing was pushed." });
  assert.equal(db.getIncident(f.id).status, "triaged");
  assert.equal(db.listFixAttempts(f.id).length, 0, "a cancelled run is not a Hermes attempt");
});

test("worker panel: running with a fresh heartbeat vs stale heartbeat vs idle/paused", async () => {
  clear();
  const a = incident();
  const now = Date.now();
  await withAdmin(async (port) => {
    writeStatus({ state: "running", heartbeat_at: new Date(now - 20_000).toISOString(), job: { kind: "fix", incident_id: a.id, name: `${a.id}-2026-09-30T10-00-00-000Z.json`, processing: `fix-${a.id}-2026-09-30T10-00-00-000Z.json`, stage: "hermes", attempt: 2, max_attempts: 2, started_at: new Date(now - 600_000).toISOString() } });
    let w = await request(port, "GET", "/admin/worker.json");
    assert.equal(w.json.display, "running");
    assert.match(w.json.worker_html, /data-display="running"/);
    assert.match(w.json.worker_html, /Hermes 2\/2/);
    assert.match(w.json.worker_html, /10m 0\ds/);
    assert.match(w.json.worker_html, /45 min/);
    // The card of the running incident shows the stage strip.
    const board = await request(port, "GET", "/admin/");
    assert.match(board.body, new RegExp(`id="incident-${a.id}"[\\s\\S]*?kc-run[\\s\\S]*?fix · Hermes 2/2`));
    assert.match(board.body, /data-live/);

    writeStatus({ state: "running", heartbeat_at: new Date(now - 11 * 60_000).toISOString(), job: { kind: "fix", incident_id: a.id, stage: "hermes", started_at: new Date(now - 3600_000).toISOString() } });
    w = await request(port, "GET", "/admin/worker.json");
    assert.equal(w.json.display, "stale");
    assert.match(w.json.worker_html, /data-state-text>Stale</);

    writeStatus({ state: "idle", heartbeat_at: new Date(now - 11 * 60_000).toISOString(), job: null, last_run: { finished_at: new Date(now - 60_000).toISOString(), kind: "triage", incident_id: a.id, status: "triaged", ok: true } });
    w = await request(port, "GET", "/admin/worker.json");
    assert.equal(w.json.display, "idle", "an old heartbeat is fine when idle");
    assert.match(w.json.worker_html, /triaged/);
    QC.setPaused(Q, true);
    w = await request(port, "GET", "/admin/worker.json");
    assert.equal(w.json.display, "paused");
    QC.setPaused(Q, false);

    // systemd report: start-limit shows as such.
    fs.writeFileSync(path.join(Q, "systemd-status.json"), JSON.stringify({ version: 1, checked_at: new Date().toISOString(), units: { path: { load_state: "loaded", active_state: "active", sub_state: "waiting", result: "success" }, service: { load_state: "loaded", active_state: "failed", sub_state: "failed", result: "start-limit-hit" } }, last_actions: [{ action: "reset-failed", units: ["heimcloud-ops-worker.service"], ok: true }], last_action_at: new Date().toISOString() }));
    const full = await request(port, "GET", "/admin/worker.json?variant=full");
    assert.match(full.json.worker_html, /start-limit-hit/);
    assert.match(full.json.worker_html, /reset-failed worker\.service/);
  });
});

function sse(port, p, headers = {}) {
  const chunks = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => chunks.push(c));
      resolve(res);
    });
    req.on("error", reject);
  });
  const text = () => chunks.join("");
  const waitFor = async (re, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = re.exec(text());
      if (m) return m;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${re} in ${JSON.stringify(text())}`);
  };
  return { ready, text, waitFor, close: () => req.destroy() };
}

test("SSE: headers for nginx, immediate hello, change event on DB and queue changes, heartbeat", async () => {
  clear();
  const a = incident();
  await withAdmin(async (port) => {
    const board = await request(port, "GET", "/admin/");
    const rev = /"rev":"([^"]+)"/.exec(board.body)[1];
    const s = sse(port, `/admin/events?rev=${rev}`);
    const res = await s.ready;
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /^text\/event-stream/);
    assert.equal(res.headers["x-accel-buffering"], "no");
    assert.match(res.headers["cache-control"], /no-cache/);
    await s.waitFor(/event: hello/);
    db.addIncidentEvent(a.id, "note", "something happened");
    const m = await s.waitFor(/event: change\ndata: (\{[^\n]*\})/);
    const payload = JSON.parse(m[1]);
    assert.deepEqual(payload.incidents, [a.id]);
    assert.ok(payload.rev);
    // Queue change (a new pending job) -> worker/queue refresh flag.
    const before = s.text().length;
    job("triage", a.id, 30);
    const t0 = Date.now();
    let got = null;
    while (!got && Date.now() - t0 < 4000) {
      const tail = s.text().slice(before);
      const mm = /event: change\ndata: (\{[^\n]*\})/.exec(tail);
      if (mm) got = JSON.parse(mm[1]);
      else await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(got && got.worker === true, "queue change is pushed");
    await s.waitFor(/: hb \d+/);
    await s.waitFor(/event: ping/);
    s.close();
    // Reconnect with a stale Last-Event-ID: catch-up diff at once.
    const s2 = sse(port, "/admin/events", { "last-event-id": rev });
    await s2.ready;
    const m2 = await s2.waitFor(/event: change\ndata: (\{[^\n]*\})/);
    assert.ok(JSON.parse(m2[1]).incidents.includes(a.id));
    s2.close();
  });
});

test("polling fallback: ETag + If-None-Match gives a bodiless 304 until something changes", async () => {
  const a = incident();
  await withAdmin(async (port) => {
    const r1 = await request(port, "GET", "/admin/live.json");
    assert.equal(r1.status, 200);
    const tag = r1.headers.etag;
    assert.ok(tag);
    const r2 = await request(port, "GET", `/admin/live.json?rev=${r1.json.rev}`, { headers: { "if-none-match": tag } });
    assert.equal(r2.status, 304);
    assert.equal(r2.body, "");
    db.addIncidentEvent(a.id, "note", "polled change");
    const r3 = await request(port, "GET", `/admin/live.json?rev=${r1.json.rev}`, { headers: { "if-none-match": tag } });
    assert.equal(r3.status, 200);
    assert.deepEqual(r3.json.incidents, [a.id]);
    const cards = await request(port, "GET", `/admin/cards?ids=${a.id}`);
    assert.equal(cards.json.cards[0].id, a.id);
    assert.match(cards.json.cards[0].html, /class="kcard/);
  });
});

test("ANONYMIZATION: queue view, worker panel and JSON never show slugs, hosts, IPs, emails or usernames", async () => {
  clear();
  const SLUG = "ZZTEST0000";
  const BAD = [SLUG, "zztest0000", "YYBURNED01", "box7.example-customer.net", "example-customer", "198.51.100.23", "ops-user@", "zzuser", "/run/heimcloud-autofix"];
  const inc = db.upsertIncident({ report_hash: "ql-anon", unit: "docker-x.service", severity: "high", logs_excerpt: "x", customer_repo_slug: SLUG }).incident;
  const leak = `on box7.example-customer.net (198.51.100.23) for ${SLUG} / YYBURNED01 mail ops-user@example-customer.net home /home/zzuser/x`;
  const fname = `fix-${inc.id}-2026-09-30T10-00-11-000Z.json`;
  fs.writeFileSync(path.join(Q, "failed", fname), "{}");
  fs.writeFileSync(path.join(Q, "failed", fname.replace(/\.json$/, ".reason.json")), JSON.stringify({ code: "worker_error", reason: `worker error: ${leak}` }));
  const dname = `triage-${inc.id}-2026-09-30T10-00-12-000Z.json`;
  fs.writeFileSync(path.join(Q, "done", dname), "{}");
  fs.writeFileSync(path.join(tmpDir, "results", dname.replace(/\.json$/, ".ingested.json")), JSON.stringify({ status: "triaged", summary: leak }));
  job("fix", inc.id, 13);
  writeStatus({
    state: "idle",
    fork_push_token: false,
    reason: "fork-push token /run/heimcloud-autofix/github-token missing or unreadable by hermes",
    heartbeat_at: new Date().toISOString(),
    last_run: { finished_at: new Date().toISOString(), kind: "fix", incident_id: inc.id, status: "needs_human", ok: true, summary: leak },
    issues: [{ code: "worker_error", message: `Worker run aborted: ${leak}`, at: new Date().toISOString(), incident_id: inc.id }],
  });
  await withAdmin(async (port) => {
    const surfaces = {
      queue: (await request(port, "GET", "/admin/queue")).body,
      board: (await request(port, "GET", "/admin/")).body,
      workerBoard: (await request(port, "GET", "/admin/worker.json")).body,
      workerFull: (await request(port, "GET", "/admin/worker.json?variant=full")).body,
      queueJson: (await request(port, "GET", "/admin/queue.json")).body,
    };
    for (const [name, body] of Object.entries(surfaces)) {
      for (const bad of BAD) assert.equal(body.toLowerCase().includes(bad.toLowerCase()), false, `${name} leaks ${bad}`);
    }
    assert.match(surfaces.queue, /worker error/);
    assert.match(surfaces.queue, /Fork token/);
    assert.match(surfaces.queue, /missing/);
    assert.doesNotMatch(surfaces.queue, /https?:\/\/(?!github\.com)[a-z0-9.-]+\.[a-z]{2,}\/[^"]*\.(js|css)/i, "no external assets");
  });
});
