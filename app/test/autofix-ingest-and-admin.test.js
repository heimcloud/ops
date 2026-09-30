/**
 * Background results ingest (no double apply) and the admin button path:
 * Start fix / Start triage enqueue the incident's real (redacted) DB fields,
 * and Start fix warns (without blocking) when the fork-push token is missing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-ingest-admin-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_TOKEN_CONFIGURED = "false";
delete process.env.OPS_REDACT_EXTRA_SLUGS;

const express = (await import("express")).default;
const { upsertIncident, getIncident, listIncidentEvents, listFixAttempts, _resetDbForTests } = await import("../lib/db.js");
const { startResultsIngestLoop, ingestResultsDir, countsAsHermesAttempt, pushRetryJob } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");
const { getForkPushTokenState } = await import("../lib/queue.js");

const results = path.join(tmpDir, "results");
fs.mkdirSync(results, { recursive: true });

after(() => {
  _resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function incident(hash) {
  return upsertIncident({
    report_hash: hash,
    unit: "docker-searxng",
    severity: "warning",
    logs_excerpt: "engine adobe_stock failed for ZZTEST0000 at 203.0.113.9",
    customer_repo_slug: "ZZTEST0000",
  }).incident;
}

test("background loop ingests without an admin page load and never double-applies", async () => {
  const inc = incident("hash-loop");
  const loop = startResultsIngestLoop({ intervalMs: 50, watch: true });
  try {
    const f = path.join(results, `fix-${inc.id}-a.json`);
    fs.writeFileSync(f, JSON.stringify({ kind: "fix", incident_id: inc.id, status: "ready_no_token", branch: "fix/x", summary: "ready locally" }));
    for (let i = 0; i < 40 && fs.existsSync(f); i += 1) await new Promise((r) => setTimeout(r, 25));
    // Page-load path racing the loop: nothing left to apply.
    assert.equal(ingestResultsDir().ingested, 0);
    loop.tick();
    assert.ok(fs.existsSync(path.join(results, `fix-${inc.id}-a.ingested.json`)));
    assert.equal(listFixAttempts(inc.id).length, 0, "ready_no_token is not a Hermes fix attempt");
    const now = getIncident(inc.id);
    assert.equal(now.status, "triaged");
    assert.equal(now.draft_branch, "fix/x");
    assert.equal(listIncidentEvents(inc.id).filter((e) => e.kind === "fix_result").length, 1);
  } finally {
    loop.stop();
  }
});

test("background loop survives a missing results dir and picks it up later", () => {
  const moved = `${results}.away`;
  fs.renameSync(results, moved);
  const loop = startResultsIngestLoop({ intervalMs: 0, watch: true });
  try {
    assert.doesNotThrow(() => loop.tick());
    fs.renameSync(moved, results);
    const inc = incident("hash-late");
    fs.writeFileSync(path.join(results, `triage-${inc.id}-b.json`), JSON.stringify({ kind: "triage", incident_id: inc.id, status: "triaged", class: "software" }));
    loop.tick();
    assert.equal(getIncident(inc.id).status, "triaged");
  } finally {
    loop.stop();
  }
});

async function withAdmin(fn) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
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

function request(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/x-www-form-urlencoded" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "" : undefined);
  });
}

test("Start fix / Start triage buttons enqueue the incident's real redacted fields", async () => {
  const inc = incident("hash-button");
  await withAdmin(async (port) => {
    for (const kind of ["fix", "triage"]) {
      const res = await request(port, "POST", `/admin/incidents/${inc.id}/start-${kind}`);
      assert.equal(res.status, 303);
      const dir = path.join(tmpDir, "queue", kind);
      const file = fs.readdirSync(dir).find((f) => f.startsWith(`${inc.id}-`));
      assert.ok(file, `${kind} job written`);
      const job = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      assert.equal(job.kind, kind);
      assert.equal(job.incident_id, inc.id);
      assert.equal(job.unit, "docker-searxng");
      assert.equal(job.severity, "warning");
      assert.equal(job.class, "unknown");
      assert.match(job.logs_excerpt, /engine adobe_stock failed/);
      assert.equal(job.logs_excerpt.includes("ZZTEST0000"), false);
      assert.equal(job.logs_excerpt.includes("203.0.113.9"), false);
      assert.equal("customer_repo_slug" in job, false);
    }
  });
});

test("Start fix warns (not blocks) when the fork-push token is unavailable", async () => {
  const inc = incident("hash-warn");
  // Worker's runtime check wins over the Nix hint.
  fs.writeFileSync(path.join(tmpDir, "queue", "worker-status.json"), JSON.stringify({ fork_push_token: false, reason: "missing", checked_at: "2026-01-01T00:00:00Z" }));
  assert.deepEqual(
    { known: getForkPushTokenState().known, ok: getForkPushTokenState().ok, source: getForkPushTokenState().source },
    { known: true, ok: false, source: "worker" },
  );
  await withAdmin(async (port) => {
    const page = await request(port, "GET", `/admin/incidents/${inc.id}`);
    assert.match(page.body, /push will be skipped/);
    assert.match(page.body, /Start fix<\/button>/);
    const res = await request(port, "POST", `/admin/incidents/${inc.id}/start-fix`);
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.location), /Fix job enqueued\. .*push will be skipped/);
    assert.equal(getIncident(inc.id).status, "fixing");
  });
  fs.writeFileSync(path.join(tmpDir, "queue", "worker-status.json"), JSON.stringify({ fork_push_token: true }));
  await withAdmin(async (port) => {
    const page = await request(port, "GET", `/admin/incidents/${inc.id}`);
    assert.doesNotMatch(page.body, /push will be skipped/);
  });
});

test("push_failed → triaged, event only (no fix_attempts row); Hermes attempts still counted", () => {
  const inc = incident("hash-pushfail");
  fs.writeFileSync(path.join(results, `fix-${inc.id}-h.json`), JSON.stringify({ kind: "fix", incident_id: inc.id, status: "needs_human", attempts: 1, summary: "Hermes gave up" }));
  const job = `fix-${inc.id}-2026-01-01T00-00-00-000Z`;
  fs.writeFileSync(
    path.join(results, `fix-${inc.id}-p.json`),
    JSON.stringify({ kind: "fix", incident_id: inc.id, status: "push_failed", push_error: "auth", job, branch: "fix/x", summary: `push failed (auth). Retry: heimcloud-ops-worker-push@${job}.service` }),
  );
  fs.writeFileSync(path.join(results, `push-${inc.id}-q.json`), JSON.stringify({ kind: "fix", via: "push-pending", incident_id: inc.id, status: "push_failed", job, summary: "again" }));
  ingestResultsDir();
  assert.equal(listFixAttempts(inc.id).length, 1, "only the Hermes attempt");
  assert.equal(getIncident(inc.id).status, "triaged");
  const ev = listIncidentEvents(inc.id).filter((e) => e.kind === "fix_result");
  assert.equal(ev.length, 3);
  assert.equal(countsAsHermesAttempt({ status: "compare_ready", via: "push-pending" }), false);
  assert.equal(countsAsHermesAttempt({ status: "needs_human" }), true);
});

test("pushRetryJob: new push_failed/ready_no_token results and the legacy push-failure needs_human", () => {
  const job = "fix-7-2026-01-01T00-00-00-000Z";
  const ev = (meta) => ({ meta });
  assert.equal(pushRetryJob({ id: 7, status: "triaged" }, ev({ status: "push_failed", job })), job);
  assert.equal(pushRetryJob({ id: 7, status: "triaged" }, ev({ status: "ready_no_token", pending_path: `/h/workspace/autofix/${job}/push-pending.json` })), job);
  assert.equal(
    pushRetryJob({ id: 7, status: "needs_human" }, ev({ status: "needs_human", summary: "git push to fork failed: x", evidence_path: `/h/workspace/autofix/${job}/fix-hermes-1.log` })),
    job,
  );
  assert.equal(pushRetryJob({ id: 7, status: "needs_human" }, ev({ status: "needs_human", summary: "Hermes gave up", evidence_path: `/h/workspace/autofix/${job}/fix-hermes-1.log` })), null);
  assert.equal(pushRetryJob({ id: 8, status: "triaged" }, ev({ status: "push_failed", job })), null, "job must match incident");
  assert.equal(pushRetryJob({ id: 7, status: "pr_opened" }, ev({ status: "push_failed", job })), null);
});

test("Retry push button enqueues a push job for the saved fix (no Hermes job)", async () => {
  const inc = incident("hash-retry");
  const job = `fix-${inc.id}-2026-01-01T00-00-00-000Z`;
  fs.writeFileSync(
    path.join(results, `fix-${inc.id}-r.json`),
    JSON.stringify({ kind: "fix", incident_id: inc.id, status: "push_failed", push_error: "auth", job, branch: "fix/x", summary: "push failed" }),
  );
  await withAdmin(async (port) => {
    const page = await request(port, "GET", `/admin/incidents/${inc.id}`);
    assert.match(page.body, /Retry push<\/button>/);
    const res = await request(port, "POST", `/admin/incidents/${inc.id}/retry-push`);
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.location), /Push retry enqueued/);
    const dir = path.join(tmpDir, "queue", "push");
    const file = fs.readdirSync(dir).find((f) => f.startsWith(`${inc.id}-`));
    const pj = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    assert.deepEqual({ kind: pj.kind, incident_id: pj.incident_id, job: pj.job }, { kind: "push", incident_id: inc.id, job });
    assert.equal(Object.keys(pj).some((k) => /slug|logs/.test(k)), false);
    const dup = await request(port, "POST", `/admin/incidents/${inc.id}/retry-push`);
    assert.match(decodeURIComponent(dup.headers.location), /already queued/);
    assert.ok(listIncidentEvents(inc.id).some((e) => e.kind === "push_enqueued"));
  });
  const other = incident("hash-noretry");
  await withAdmin(async (port) => {
    const page = await request(port, "GET", `/admin/incidents/${other.id}`);
    assert.doesNotMatch(page.body, /Retry push<\/button>/);
    const res = await request(port, "POST", `/admin/incidents/${other.id}/retry-push`);
    assert.match(decodeURIComponent(res.headers.location), /no saved fix/);
  });
});
