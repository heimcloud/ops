/**
 * Board endpoints: server-rendered board, the admin update path (form +
 * JSON variant used by drag and drop), transition guard, event row, stale
 * guard, same-origin guard, board actions, and anonymization of the board
 * HTML, the drawer HTML and the JSON. Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-board-admin-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_REDACT_EXTRA_SLUGS = "YYBURNED01";
delete process.env.ADMIN_READ_ONLY;

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { applyResult } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let n = 0;
function incident(extra = {}) {
  n += 1;
  return db.upsertIncident({
    report_hash: `board-hash-${n}`,
    unit: "docker-searxng.service",
    severity: "warning",
    logs_excerpt: "engine adobe_stock failed",
    ...extra,
  }).incident;
}
function setStatus(id, status) {
  return db.updateIncident(id, { status });
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
const adminEvents = (id) => db.listIncidentEvents(id).filter((e) => e.kind === "admin_update");

test("board renders every column with per-column counts instead of tiles", async () => {
  const a = incident();
  const b = incident();
  setStatus(b.id, "closed");
  await withAdmin(async (port) => {
    const res = await request(port, "GET", "/admin/");
    assert.equal(res.status, 200);
    for (const col of ["open", "triaged", "fixing", "testing", "needs_human", "pr_opened", "done"]) {
      assert.match(res.body, new RegExp(`data-col="${col}"`), col);
    }
    assert.match(res.body, /Awaiting PR/);
    assert.match(res.body, /\d+ resolved · \d+ closed/);
    assert.match(res.body, new RegExp(`id="incident-${a.id}"[^>]*data-status="open"`));
    assert.match(res.body, /draggable="true"/);
    assert.match(res.body, /<script src="\/js\/board\.js" defer><\/script>/);
    assert.doesNotMatch(res.body, /https?:\/\/(?!github\.com)[a-z0-9.-]+\.[a-z]{2,}\/[^"]*\.(js|css)/i, "no external assets");
    assert.doesNotMatch(res.body, /class="grid grid-2"/, "old tiles gone");
  });
});

test("JSON move persists, writes admin_update 'status X -> Y' with from/to, returns the card", async () => {
  const inc = incident();
  await withAdmin(async (port) => {
    const res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: "triaged", expect_from: "open" } });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.incident.status, "triaged");
    assert.match(res.json.card_html, new RegExp(`id="incident-${inc.id}"[^>]*data-status="triaged"`));
    assert.equal(db.getIncident(inc.id).status, "triaged");
    const evs = adminEvents(inc.id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].message, "status open -> triaged");
    const meta = JSON.parse(evs[0].meta_json);
    assert.equal(meta.from, "open");
    assert.equal(meta.to, "triaged");
  });
});

test("invalid transitions are rejected server-side (worker-owned, table) and nothing is written", async () => {
  const inc = incident();
  await withAdmin(async (port) => {
    for (const to of ["fixing", "testing"]) {
      const res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: to } });
      assert.equal(res.status, 409);
      assert.equal(res.json.error, "worker_owned");
      assert.match(res.json.message, /host worker/);
      assert.match(res.json.card_html, /data-status="open"/, "card for rollback");
    }
    setStatus(inc.id, "needs_human");
    let res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: "open" } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "invalid_transition");
    res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: "nonsense" } });
    assert.equal(res.status, 400);
    assert.equal(db.getIncident(inc.id).status, "needs_human");
    assert.equal(adminEvents(inc.id).length, 0);
    // Legacy form path is guarded by the same table.
    res = await request(port, "POST", `/admin/incidents/${inc.id}`, { form: { _action: "update", status: "fixing", class: "software" } });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.location), /host worker/);
    assert.equal(db.getIncident(inc.id).status, "needs_human");
    assert.equal(db.getIncident(inc.id).class, "unknown");
  });
});

test("stale drag (status changed elsewhere) is refused with the current card", async () => {
  const inc = incident();
  setStatus(inc.id, "triaged");
  await withAdmin(async (port) => {
    const res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: "closed", expect_from: "open" } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "stale_status");
    assert.match(res.json.card_html, /data-status="triaged"/);
    assert.equal(db.getIncident(inc.id).status, "triaged");
  });
});

test("cross-origin POSTs are refused (Sec-Fetch-Site / Origin); same-origin passes", async () => {
  const inc = incident();
  await withAdmin(async (port) => {
    let res = await request(port, "POST", `/admin/incidents/${inc.id}`, {
      json: { action: "move", status: "triaged" },
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "cross_origin");
    res = await request(port, "POST", `/admin/incidents/${inc.id}/start-fix`, { form: {}, headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(db.getIncident(inc.id).status, "open");
    res = await request(port, "POST", `/admin/incidents/${inc.id}`, {
      json: { action: "move", status: "triaged" },
      headers: { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(res.status, 200);
  });
});

test("board forms (no JS): move / Mark config error & close / Mark resolved redirect back to the board", async () => {
  const inc = incident();
  await withAdmin(async (port) => {
    let res = await request(port, "POST", `/admin/incidents/${inc.id}`, { form: { _action: "move", status: "triaged", return_to: "board", expect_from: "open" } });
    assert.equal(res.status, 303);
    assert.match(res.headers.location, new RegExp(`^/admin/\\?msg=.*#incident-${inc.id}$`));
    res = await request(port, "POST", `/admin/incidents/${inc.id}`, { form: { _action: "mark_config_error", return_to: "board" } });
    assert.equal(res.status, 303);
    let now = db.getIncident(inc.id);
    assert.equal(now.status, "closed");
    assert.equal(now.class, "human_config");
    let last = adminEvents(inc.id).pop();
    assert.equal(last.message, "status triaged -> closed (marked as config error)");
    assert.equal(JSON.parse(last.meta_json).note, "marked as config error");
    // Done can be reopened; then Mark resolved.
    res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: "open" } });
    assert.equal(res.status, 200);
    res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "mark_resolved" } });
    assert.equal(res.status, 200);
    now = db.getIncident(inc.id);
    assert.equal(now.status, "resolved");
    last = adminEvents(inc.id).pop();
    assert.equal(JSON.parse(last.meta_json).from, "open");
    res = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "drop_table" } });
    assert.equal(res.status, 400);
  });
});

test("legacy detail form still updates class/target without a status change (event written)", async () => {
  const inc = incident();
  await withAdmin(async (port) => {
    const page = await request(port, "GET", `/admin/incidents/${inc.id}`);
    assert.doesNotMatch(page.body, /<option value="fixing"/, "status select only offers allowed moves");
    const res = await request(port, "POST", `/admin/incidents/${inc.id}`, { form: { _action: "update", class: "software", status: "open", target_repo: "heimcloud/neo" } });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.location), /Incident updated/);
    const now = db.getIncident(inc.id);
    assert.equal(now.class, "software");
    assert.equal(now.target_repo, "heimcloud/neo");
    assert.equal(adminEvents(inc.id).pop().message, "Class/status/target updated");
  });
});

test("Start fix via JSON (board button) enqueues and returns the refreshed card", async () => {
  const inc = incident();
  setStatus(inc.id, "triaged");
  await withAdmin(async (port) => {
    const res = await request(port, "POST", `/admin/incidents/${inc.id}/start-fix`, { json: {} });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.ok, true);
    assert.match(res.json.card_html, /data-status="fixing"/);
    const dup = await request(port, "POST", `/admin/incidents/${inc.id}/start-fix`, { json: {} });
    assert.equal(dup.status, 409);
    assert.match(dup.json.message, /already queued/);
  });
});

test("human-input badges and card actions come from real result payloads", async () => {
  const push = incident();
  const job = `fix-${push.id}-2026-01-01T00-00-00-000Z`;
  applyResult({ kind: "fix", incident_id: push.id, status: "ready_no_token", job, branch: "fix/x", summary: "waiting for the fork-push token" });
  const cmp = incident();
  applyResult({ kind: "fix", incident_id: cmp.id, status: "compare_ready", lab: "passed", branch: "fix/y", compare_url: "https://github.com/madebydamo/neo/compare/dev...heimcloud:neo:fix/y?expand=1", attempts: 1 });
  await withAdmin(async (port) => {
    const res = await request(port, "GET", "/admin/board.json");
    const byId = new Map(res.json.cards.map((c) => [c.id, c]));
    assert.equal(byId.get(push.id).reasons[0].code, "ready_no_token");
    assert.equal(byId.get(cmp.id).reasons[0].code, "compare_ready");
    const html = (await request(port, "GET", "/admin/")).body;
    const pushCard = html.slice(html.indexOf(`id="incident-${push.id}"`), html.indexOf("</article>", html.indexOf(`id="incident-${push.id}"`)));
    assert.match(pushCard, /retry-push/);
    assert.match(pushCard, /Push pending/);
    const cmpCard = html.slice(html.indexOf(`id="incident-${cmp.id}"`), html.indexOf("</article>", html.indexOf(`id="incident-${cmp.id}"`)));
    assert.match(cmpCard, /href="https:\/\/github\.com\/madebydamo\/neo\/compare\/dev\.\.\.heimcloud:neo:fix\/y\?expand=1" target="_blank" rel="noopener"/);
    const filtered = await request(port, "GET", "/admin/?mine=1&cols=triaged,pr_opened");
    assert.match(filtered.body, /data-col="open" [^>]*hidden/, "column visibility from the URL");
    assert.match(filtered.body, /name="mine" value="1" checked/);
  });
});

test("ANONYMIZATION: slug, hostname, IP, email, username never reach board HTML, drawer HTML or JSON", async () => {
  const SLUG = "ZZTEST0000";
  const BAD = [SLUG, "zztest0000", "YYBURNED01", "box7.example-customer.net", "example-customer", "198.51.100.23", "2001:db8::17", "ops-user@", "zzuser", "hattori"];
  const inc = db.upsertIncident({
    report_hash: "anon-hash-1",
    unit: `docker-${SLUG}.service`,
    severity: "high",
    logs_excerpt: `nginx upstream box7.example-customer.net (198.51.100.23) refused for ${SLUG}; mail ops-user@example-customer.net`,
    customer_repo_slug: SLUG,
    plugin_urls: [`github:heimcloud/cust-${SLUG}`],
    target_hint: "madebydamo/neo",
  }).incident;
  applyResult({
    kind: "triage",
    incident_id: inc.id,
    status: "triaged",
    class: "unknown",
    verdict: "uncertain",
    confidence: 0.4,
    summary: `Could be config on box7.example-customer.net for ${SLUG.toLowerCase()} or a code bug; as user zzuser at 2001:db8::17`,
  });
  applyResult({
    kind: "fix",
    incident_id: inc.id,
    status: "needs_human",
    attempts: 2,
    max_attempts: 2,
    branch: `fix/${SLUG}`,
    summary: `Hermes gave up: /home/zzuser/workspace log on hattori mentions YYBURNED01 and ops-user@example-customer.net`,
  });
  db.addIncidentEvent(inc.id, "note", `ssh zzuser@box7.example-customer.net 198.51.100.23 ${SLUG}`, { host: "box7.example-customer.net" });
  db.updateIncident(inc.id, { compare_url: `https://github.com/madebydamo/neo/compare/dev...heimcloud:neo:fix/${SLUG}?expand=1`, draft_branch: `fix/${SLUG}` });

  await withAdmin(async (port) => {
    const surfaces = {
      board: (await request(port, "GET", "/admin/")).body,
      boardFiltered: (await request(port, "GET", "/admin/?q=config&mine=1")).body,
      boardJson: (await request(port, "GET", "/admin/board.json")).body,
      drawer: (await request(port, "GET", `/admin/incidents/${inc.id}/drawer?fragment=1`)).body,
      drawerPage: (await request(port, "GET", `/admin/incidents/${inc.id}/drawer`)).body,
      drawerJson: (await request(port, "GET", `/admin/incidents/${inc.id}/drawer.json`)).body,
      moveJson: (await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: "triaged" } })).body,
    };
    for (const [name, body] of Object.entries(surfaces)) {
      assert.ok(body.length > 200, `${name} rendered`);
      for (const bad of BAD) {
        assert.equal(body.toLowerCase().includes(bad.toLowerCase()), false, `${name} leaks ${bad}`);
      }
    }
    // Still useful after redaction.
    assert.match(surfaces.drawer, /\[redacted-slug\]/);
    assert.match(surfaces.drawer, /Hermes stuck after 2 attempt/);
    assert.match(surfaces.drawer, /Europe\/Zurich/);
    assert.match(surfaces.board, /redacted-host|redacted-slug/);
    assert.doesNotMatch(surfaces.drawer, /href="https:\/\/github\.com\/madebydamo\/neo\/compare[^"]*redacted/, "slug-bearing compare URL is not linked");
  });
});
