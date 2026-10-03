/**
 * PR loop, app side: kind "pr" results → card state / incident status,
 * needs_human reasons (PR closed, revision cap, no lab method, unknown
 * target), "Skip lab" → draft PR job, "Open the PR now", PR-loop validation
 * route. Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-prloop-app-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_LAB = "true";
process.env.OPS_AUTOFIX_PR = "true";
process.env.OPS_TARGETS = JSON.stringify([
  { upstream: "madebydamo/neo", baseRef: "master" },
  { upstream: "madebydamo/highsea.neo", baseRef: "master", lab: "none" },
]);
delete process.env.ADMIN_READ_ONLY;

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { applyResult } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");
const B = await import("../lib/board.js");
const Q = await import("../lib/queue.js");
const { buildCardModel, buildDrawerModel, renderCard, renderDrawer } = await import("../lib/board-view.js");

for (const d of ["triage", "fix", "push", "lab", "pr", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(tmpDir, "queue", d), { recursive: true });

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CAPS = { readOnly: false, triage: true, fix: true, push: true, lab: true, pr: true, protectedWatchdogSec: 600 };
const redact = (s) => String(s ?? "");
const events = (id) => db.listIncidentEvents(id);
const card = (id) => buildCardModel(db.getIncident(id), events(id), db.listFixAttempts(id), redact, { labAuto: true, prAuto: true });
const hi = (id) => B.needsHumanInput(db.getIncident(id), events(id), [], { prAuto: true });
const jobs = (kind, id) => fs.readdirSync(path.join(tmpDir, "queue", kind)).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".json"));
let n = 0;
function incident(extra = {}) {
  n += 1;
  return db.upsertIncident({ report_hash: `prapp-${n}`, unit: "docker-searxng.service", severity: "warning", logs_excerpt: "engine x failed", ...extra }).incident;
}
const prResult = (id, event, extra = {}) =>
  applyResult({
    kind: "pr",
    via: "pr",
    pr_event: event,
    incident_id: id,
    target_repo: "madebydamo/neo",
    branch: "fix/searxng",
    pr_number: 12,
    pr_url: "https://github.com/madebydamo/neo/pull/12",
    pr_state: "open",
    pr_draft: false,
    review_state: "open",
    round: 0,
    max_rounds: 3,
    last_feedback_at: null,
    revise_pending: null,
    stopped: false,
    halted: null,
    summary: `PR ${event}`,
    ...extra,
  });
function labPassed(id, extra = {}) {
  applyResult({
    kind: "fix",
    incident_id: id,
    status: "compare_ready",
    lab: "passed",
    branch: "fix/searxng",
    head_sha: "a".repeat(40),
    compare_url: "https://github.com/madebydamo/neo/compare/master...heimcloud:neo:fix/searxng?expand=1",
    pr_title: "fix(searxng): drop stale engines",
    pr_body: "body",
    target_repo: "madebydamo/neo",
    summary: "Lab test passed; open the compare link to create the upstream PR.",
    ...extra,
  });
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
function request(port, method, p, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/json", accept: "application/json", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* html */
        }
        resolve({ status: res.statusCode, json, body: data });
      });
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

test("PR opened → PR open column, PR #/link on the card, no badge while the PR is tracked", () => {
  const inc = incident();
  labPassed(inc.id);
  prResult(inc.id, "opened", { summary: "Opened PR #12 on madebydamo/neo." });
  const cur = db.getIncident(inc.id);
  assert.equal(cur.status, "pr_opened");
  assert.equal(cur.draft_pr_number, 12);
  assert.equal(cur.draft_pr_url, "https://github.com/madebydamo/neo/pull/12");
  assert.equal(B.columnForStatus("pr_opened"), "pr_opened");
  assert.equal(B.STATUS_LABELS.pr_opened, "PR open");
  assert.equal(hi(inc.id).needed, false);
  const pr = B.prInfo(cur, events(inc.id));
  assert.equal(pr.number, 12);
  assert.equal(pr.label, "open");
  const html = renderCard(card(inc.id), "/admin", CAPS);
  assert.match(html, /class="kc-pr pr-open"/);
  assert.match(html, /href="https:\/\/github\.com\/madebydamo\/neo\/pull\/12"/);
  assert.match(html, /round 0\/3/);
  // Feedback → Fixing (revise round queued) → revised → PR open again.
  prResult(inc.id, "feedback", { round: 1, revise_pending: "fix-1-r1", last_feedback_at: "2026-10-01T08:00:00Z", review_state: "changes_requested" });
  assert.equal(db.getIncident(inc.id).status, "fixing");
  assert.match(renderCard(card(inc.id), "/admin", CAPS), /changes requested/);
  assert.match(renderCard(card(inc.id), "/admin", CAPS), /revision running/);
  prResult(inc.id, "revised", { round: 1, review_state: "changes_requested" });
  assert.equal(db.getIncident(inc.id).status, "pr_opened");
  assert.equal(hi(inc.id).needed, false);
  const drawer = renderDrawer(buildDrawerModel(db.getIncident(inc.id), events(inc.id), db.listFixAttempts(inc.id), redact, { labAuto: true }), "/admin", CAPS);
  assert.match(drawer, /PR loop/);
  assert.match(drawer, /round 1\/3/);
  // Merged → resolved.
  prResult(inc.id, "merged", { pr_state: "merged", review_state: "merged" });
  assert.equal(db.getIncident(inc.id).status, "resolved");
  assert.ok(events(inc.id).some((e) => e.kind === "pr_merged"));
});

test("PR URL outside the allowlist is never stored on the incident", () => {
  const inc = incident();
  prResult(inc.id, "opened", { pr_url: "https://github.com/someone/neo/pull/12" });
  assert.equal(db.getIncident(inc.id).draft_pr_url, null);
});

test("closed without merge → needs_human 'PR closed'; revision cap → needs_human; a manual close is never undone", () => {
  const a = incident();
  labPassed(a.id);
  prResult(a.id, "opened");
  prResult(a.id, "closed", { pr_state: "closed", review_state: "closed", summary: "PR #12 was closed without merge." });
  assert.equal(db.getIncident(a.id).status, "needs_human");
  assert.equal(hi(a.id).reasons[0].code, "pr_closed");
  assert.deepEqual(hi(a.id).reasons[0].actions, ["open_pr", "start_fix", "close"]);

  const b = incident();
  labPassed(b.id);
  prResult(b.id, "opened");
  prResult(b.id, "halted", { halted: "revision_cap", round: 3, summary: "Revision cap reached (3/3)." });
  assert.equal(db.getIncident(b.id).status, "needs_human");
  assert.equal(hi(b.id).reasons[0].code, "revision_cap");
  assert.match(hi(b.id).reasons[0].label, /Revision cap reached \(3\/3\)/);
  assert.match(renderCard(card(b.id), "/admin", CAPS), /halted: revision cap/);

  const c = incident();
  labPassed(c.id);
  prResult(c.id, "opened");
  db.updateIncident(c.id, { status: "closed" });
  prResult(c.id, "closed", { pr_state: "closed" });
  prResult(c.id, "merged", { pr_state: "merged" });
  assert.equal(db.getIncident(c.id).status, "closed");

  const d = incident();
  labPassed(d.id);
  prResult(d.id, "blocked", { summary: "PR not opened: the redaction gate blocked the title/body." });
  assert.equal(hi(d.id).reasons[0].code, "pr_redaction_blocked");
});

test("compare-only lab pass: 'Open the PR now' queues a kind pr job (no badge while queued); cross-origin refused", async () => {
  const inc = incident();
  labPassed(inc.id);
  assert.deepEqual(hi(inc.id).reasons[0].actions, ["create_pr", "open_compare", "mark_resolved"]);
  await withAdmin(async (port) => {
    const x = await request(port, "POST", `/admin/incidents/${inc.id}/open-pr`, { headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } });
    assert.equal(x.status, 403);
    assert.deepEqual(jobs("pr", inc.id), []);
    const r = await request(port, "POST", `/admin/incidents/${inc.id}/open-pr`);
    assert.equal(r.status, 200, r.body);
    const again = await request(port, "POST", `/admin/incidents/${inc.id}/open-pr`);
    assert.equal(again.status, 409);
  });
  const [file] = jobs("pr", inc.id);
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "pr", file), "utf8"));
  assert.equal(job.kind, "pr");
  assert.equal(job.mode, "open");
  assert.equal(job.branch, "fix/searxng");
  assert.equal(job.target_repo, "madebydamo/neo");
  assert.ok(events(inc.id).some((e) => e.kind === "pr_enqueued"));
  assert.equal(hi(inc.id).needed, false);
});

test("target without a lab method: lab_unavailable → 'No lab method' badge → Skip lab queues a draft PR job (NOT lab-tested)", async () => {
  const inc = incident({ unit: "docker-highsea.service" });
  db.updateIncident(inc.id, { target_repo: "madebydamo/highsea.neo" });
  applyResult({
    kind: "fix",
    incident_id: inc.id,
    status: "lab_unavailable",
    lab: "no_method",
    branch: "fix/highsea-x",
    fix_job: `fix-${inc.id}-2026-01-01T00-00-00-000Z`,
    head_sha: "b".repeat(40),
    pending_compare_url: "https://github.com/madebydamo/highsea.neo/compare/master...heimcloud:highsea.neo:fix/highsea-x?expand=1",
    target_repo: "madebydamo/highsea.neo",
    pr_title: "fix(highsea): x",
    pr_body: "body",
    summary: 'No lab method for madebydamo/highsea.neo (lab = "none")',
  });
  assert.equal(db.getIncident(inc.id).status, "needs_human");
  const r0 = hi(inc.id).reasons[0];
  assert.equal(r0.code, "no_lab_method");
  assert.deepEqual(r0.actions, ["skip_lab", "close"]);
  assert.equal(B.ACTIONS.skip_lab, "Skip lab (NOT lab-tested)");
  await withAdmin(async (port) => {
    const r = await request(port, "POST", `/admin/incidents/${inc.id}/skip-lab`);
    assert.equal(r.status, 200, r.body);
    // Approve makes no sense without a lab method.
    assert.equal((await request(port, "POST", `/admin/incidents/${inc.id}/approve-lab`)).status >= 400, true);
  });
  assert.equal(db.getIncident(inc.id).status, "pr_opened");
  const [file] = jobs("pr", inc.id);
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "pr", file), "utf8"));
  assert.equal(job.mode, "untested");
  assert.equal(job.target_repo, "madebydamo/highsea.neo");
  assert.equal(job.branch, "fix/highsea-x");
  assert.deepEqual(jobs("lab", inc.id), []);
  assert.equal(hi(inc.id).needed, false, "draft PR job pending: no badge");
});

test("unknown target: triage naming a repo outside the allowlist → needs_human; enqueue refuses; the worker's unknown_target result shows", () => {
  const inc = incident();
  applyResult({ kind: "triage", incident_id: inc.id, status: "triaged", class: "software", target_repo: "someone/else", summary: "x" });
  const cur = db.getIncident(inc.id);
  assert.equal(cur.status, "needs_human");
  assert.notEqual(cur.target_repo, "someone/else");
  assert.equal(hi(inc.id).reasons[0].code, "unknown_target");
  assert.throws(() => Q.enqueueJob("fix", { ...cur, target_repo: "someone/else" }), /allowlist|unknown/i);
  // An allowlisted target goes on the job.
  const ok = incident();
  db.updateIncident(ok.id, { target_repo: "madebydamo/highsea.neo", class: "software" });
  const { job } = Q.enqueueJob("fix", db.getIncident(ok.id));
  assert.equal(job.target_repo, "madebydamo/highsea.neo");

  const w = incident();
  applyResult({ kind: "fix", incident_id: w.id, status: "needs_human", unknown_target: "madebydamo/other", summary: "Unknown target repo" });
  assert.equal(hi(w.id).reasons[0].code, "unknown_target");
});

test("PR-loop validation: board button + 'PR loop on'; route creates a synthetic incident with a validation fix job on neo", async () => {
  await withAdmin(async (port) => {
    const board = await request(port, "GET", "/admin/", { headers: { accept: "text/html" } });
    assert.match(board.body, /PR loop on/);
    assert.match(board.body, /action="\/admin\/validation\/pr-loop"/);
    const x = await request(port, "POST", "/admin/validation/pr-loop", { headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } });
    assert.equal(x.status, 403);
    const r = await request(port, "POST", "/admin/validation/pr-loop");
    assert.equal(r.status, 200, r.body);
    const id = r.json.incident_id;
    const inc = db.getIncident(id);
    assert.match(inc.report_hash, /^validation-pr-loop-/);
    assert.equal(inc.status, "fixing");
    assert.equal(inc.target_repo, "madebydamo/neo");
    const [file] = jobs("fix", id);
    const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "fix", file), "utf8"));
    assert.equal(job.validation, true);
    assert.equal(job.target_repo, "madebydamo/neo");
    assert.ok(events(id).some((e) => e.kind === "fix_enqueued" && JSON.parse(e.meta_json).validation === true));
  });
  // PR automation off → refused, nothing created.
  process.env.OPS_AUTOFIX_PR = "false";
  try {
    const { startPrLoopValidation } = await import("../lib/validation.js");
    assert.throws(() => startPrLoopValidation(), /PR automation is not enabled/);
  } finally {
    process.env.OPS_AUTOFIX_PR = "true";
  }
});
