/**
 * ADMIN_READ_ONLY: the board renders without drag handles, move menus or
 * action buttons, and every mutating path (form + JSON) is refused.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-board-ro-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.ADMIN_READ_ONLY = "true";

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { applyResult } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");

after(() => {
  db._resetDbForTests();
  delete process.env.ADMIN_READ_ONLY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function request(port, method, p, { json, form } = {}) {
  return new Promise((resolve, reject) => {
    const body = json !== undefined ? JSON.stringify(json) : new URLSearchParams(form || {}).toString();
    const headers = json !== undefined
      ? { "content-type": "application/json", accept: "application/json" }
      : { "content-type": "application/x-www-form-urlencoded" };
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}

test("read-only: no dragging, no action buttons, server refuses every mutation", async () => {
  const inc = db.upsertIncident({ report_hash: "ro-1", unit: "docker-searxng", severity: "high", logs_excerpt: "x" }).incident;
  const job = `fix-${inc.id}-2026-01-01T00-00-00-000Z`;
  applyResult({ kind: "fix", incident_id: inc.id, status: "push_failed", push_error: "auth", job, summary: "push failed" });
  const app = express();
  app.use("/admin", createAdminRouter());
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const port = server.address().port;
  try {
    const board = await request(port, "GET", "/admin/");
    assert.equal(board.status, 200);
    assert.match(board.body, /Read-only/);
    assert.match(board.body, /"readOnly":true/);
    assert.doesNotMatch(board.body, /draggable=/);
    assert.doesNotMatch(board.body, /class="move-form"/);
    assert.doesNotMatch(board.body, /class="act-form"/);
    assert.match(board.body, /Push failed/, "badge still shown");
    const drawer = await request(port, "GET", `/admin/incidents/${inc.id}/drawer?fragment=1`);
    assert.doesNotMatch(drawer.body, /<form/);

    const before = db.getIncident(inc.id).status;
    const evs = db.listIncidentEvents(inc.id).length;
    const j = await request(port, "POST", `/admin/incidents/${inc.id}`, { json: { action: "move", status: "closed" } });
    assert.equal(j.status, 403);
    assert.equal(JSON.parse(j.body).error, "read_only");
    const f = await request(port, "POST", `/admin/incidents/${inc.id}`, { form: { _action: "mark_resolved", return_to: "board" } });
    assert.equal(f.status, 403);
    for (const p of ["start-fix", "start-triage", "retry-push", "retry-lab"]) {
      const r = await request(port, "POST", `/admin/incidents/${inc.id}/${p}`, { json: {} });
      assert.equal(r.status, 403, p);
    }
    assert.equal(db.getIncident(inc.id).status, before);
    assert.equal(db.listIncidentEvents(inc.id).length, evs);
    assert.equal(fs.existsSync(path.join(tmpDir, "queue", "fix")), false, "nothing enqueued");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("read-only: protected-lab approval / skip refused (JSON + form), nothing signed or queued", async () => {
  const inc = db.upsertIncident({ report_hash: "ro-2", unit: "docker-hermes.service", severity: "high", logs_excerpt: "x" }).incident;
  applyResult({
    kind: "fix",
    incident_id: inc.id,
    status: "lab_approval_needed",
    lab: "awaiting_approval",
    branch: "fix/hermes-x",
    fix_job: `fix-${inc.id}-2026-01-01T00-00-00-000Z`,
    head_sha: "d".repeat(40),
    pending_compare_url: "https://github.com/example/neo/compare/dev...fork:neo:fix/hermes-x?expand=1",
    protected: { areas: ["hermes"], paths: ["nix/services/hermes"], core: false },
    summary: "Protected path (hermes): approve lab test.",
  });
  const app = express();
  app.use("/admin", createAdminRouter());
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const port = server.address().port;
  try {
    const board = await request(port, "GET", "/admin/");
    assert.match(board.body, /Protected path \(hermes\): approve lab test/, "badge shown read-only");
    assert.doesNotMatch(board.body, /approve-lab|skip-lab/, "no buttons read-only");
    const evs = db.listIncidentEvents(inc.id).length;
    for (const p of ["approve-lab", "skip-lab"]) {
      const j = await request(port, "POST", `/admin/incidents/${inc.id}/${p}`, { json: {} });
      assert.equal(j.status, 403, p);
      assert.equal(JSON.parse(j.body).error, "read_only");
      const f = await request(port, "POST", `/admin/incidents/${inc.id}/${p}`, { form: { return_to: "board" } });
      assert.equal(f.status, 403, `${p} form`);
    }
    assert.equal(db.getIncident(inc.id).status, "needs_human");
    assert.equal(db.listIncidentEvents(inc.id).length, evs);
    assert.equal(fs.existsSync(path.join(tmpDir, "queue", "lab")), false, "no lab job");
    assert.equal(fs.existsSync(path.join(tmpDir, "private")), false, "no approval key minted");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("read-only: open-pr and PR-loop validation refused (JSON + form), nothing created or queued", async () => {
  process.env.OPS_AUTOFIX_PR = "true";
  const inc = db.upsertIncident({ report_hash: "ro-3", unit: "docker-searxng", severity: "high", logs_excerpt: "x" }).incident;
  const app = express();
  app.use("/admin", createAdminRouter());
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const port = server.address().port;
  try {
    const board = await request(port, "GET", "/admin/");
    assert.doesNotMatch(board.body, /validation\/pr-loop/, "no validation button read-only");
    const n = db.getDb().prepare("SELECT COUNT(*) AS n FROM incidents").get().n;
    for (const p of [`/admin/incidents/${inc.id}/open-pr`, "/admin/validation/pr-loop"]) {
      const j = await request(port, "POST", p, { json: {} });
      assert.equal(j.status, 403, p);
      assert.equal(JSON.parse(j.body).error, "read_only");
      const f = await request(port, "POST", p, { form: {} });
      assert.equal(f.status, 403, `${p} form`);
    }
    assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM incidents").get().n, n);
    assert.equal(fs.existsSync(path.join(tmpDir, "queue", "pr")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "queue", "fix")), false);
  } finally {
    delete process.env.OPS_AUTOFIX_PR;
    await new Promise((r) => server.close(r));
  }
});
