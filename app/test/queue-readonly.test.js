/**
 * ADMIN_READ_ONLY on the queue view / worker panel: no controls rendered,
 * every queue action refused (JSON + form), control files untouched. Live
 * endpoints (read-only by nature) keep working.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-queue-ro-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.ADMIN_READ_ONLY = "true";

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { createAdminRouter } = await import("../lib/admin.js");

after(() => {
  db._resetDbForTests();
  delete process.env.ADMIN_READ_ONLY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function request(port, method, p, { json, form } = {}) {
  return new Promise((resolve, reject) => {
    const body = json !== undefined ? JSON.stringify(json) : new URLSearchParams(form || {}).toString();
    const headers = json !== undefined ? { "content-type": "application/json", accept: "application/json" } : { "content-type": "application/x-www-form-urlencoded" };
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}

test("read-only: queue page + worker panel have no controls; every queue action is refused", async () => {
  const Q = path.join(tmpDir, "queue");
  for (const d of ["triage", "fix", "push", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(Q, d), { recursive: true });
  const inc = db.upsertIncident({ report_hash: "qro-1", unit: "docker-x", severity: "high", logs_excerpt: "x" }).incident;
  const pend = `${inc.id}-2026-09-30T10-00-01-000Z.json`;
  fs.writeFileSync(path.join(Q, "fix", pend), JSON.stringify({ incident_id: inc.id }));
  const failed = `triage-${inc.id}-2026-09-30T09-00-01-000Z.json`;
  fs.writeFileSync(path.join(Q, "failed", failed), JSON.stringify({ incident_id: inc.id }));
  const proc = `triage-${inc.id}-2026-09-30T10-00-02-000Z.json`;
  fs.writeFileSync(path.join(Q, "processing", proc), JSON.stringify({ incident_id: inc.id, _claims: 1 }));
  fs.writeFileSync(path.join(Q, "worker-status.json"), JSON.stringify({ version: 2, state: "running", heartbeat_at: new Date().toISOString(), job: { kind: "triage", incident_id: inc.id, processing: proc, stage: "hermes", started_at: new Date().toISOString() } }));

  const app = express();
  app.use("/admin", createAdminRouter());
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const port = server.address().port;
  try {
    for (const p of ["/admin/queue", "/admin/"]) {
      const page = await request(port, "GET", p);
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.body, /data-qaction/, `${p}: no queue action forms`);
      assert.doesNotMatch(page.body, /Pause queue|Cancel running|>Retry</, `${p}: no control labels`);
    }
    const q = await request(port, "GET", "/admin/queue");
    assert.match(q.body, /Read-only/);
    assert.match(q.body, /chip prio p-normal/, "priority is shown as text");
    const w = await request(port, "GET", "/admin/worker.json?variant=full");
    assert.doesNotMatch(JSON.parse(w.body).queue_html, /<form/);

    const actions = [
      ["pause", {}],
      ["resume", {}],
      ["priority", { kind: "fix", job: pend, priority: "high" }],
      ["move", { kind: "fix", job: pend, direction: "top" }],
      ["cancel", { kind: "fix", job: pend }],
      ["cancel-running", { job: proc }],
      ["retry", { job: failed }],
    ];
    for (const [a, body] of actions) {
      assert.equal((await request(port, "POST", `/admin/queue/${a}`, { json: body })).status, 403, `${a} json`);
      assert.equal((await request(port, "POST", `/admin/queue/${a}`, { form: body })).status, 403, `${a} form`);
    }
    assert.deepEqual(fs.readdirSync(path.join(Q, "control")), [], "no control files written");
    assert.ok(fs.existsSync(path.join(Q, "fix", pend)));
    assert.equal(fs.readdirSync(path.join(Q, "failed")).length, 1);
    assert.equal(db.listIncidentEvents(inc.id).filter((e) => /^job_/.test(e.kind)).length, 0);
    // Live endpoints are read-only and stay available.
    assert.equal((await request(port, "GET", "/admin/live.json")).status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
