/**
 * Automated lab stage, app side: check-plan schema, status transitions and
 * attempt counting on ingest, needsHumanInput (no badge while the lab runs),
 * redaction of lab evidence on card + drawer, queue kind/priority, retry-lab
 * and cancel. Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-lab-app-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_LAB = "true";
process.env.OPS_REDACT_EXTRA_SLUGS = "YYBURNED01";
delete process.env.ADMIN_READ_ONLY;

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { applyResult } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");
const L = await import("../lib/lab-checks.js");
const B = await import("../lib/board.js");
const QC = await import("../lib/queue-control.js");
const { buildCardModel, buildDrawerModel, renderCard, renderDrawer } = await import("../lib/board-view.js");

const Q = path.join(tmpDir, "queue");
for (const d of ["triage", "fix", "push", "lab", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(Q, d), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "results"), { recursive: true });

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let n = 0;
function incident(extra = {}) {
  n += 1;
  return db.upsertIncident({ report_hash: `lab-${n}`, unit: "docker-searxng.service", severity: "warning", logs_excerpt: "engine x failed", ...extra }).incident;
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
function request(port, method, p, { json } = {}) {
  return new Promise((resolve, reject) => {
    const body = json !== undefined ? JSON.stringify(json) : "";
    const headers = json !== undefined ? { "content-type": "application/json", accept: "application/json" } : {};
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* html */
        }
        resolve({ status: res.statusCode, body: data, json: parsed });
      });
    });
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}
const view = (id) => {
  const inc = db.getIncident(id);
  const events = db.listIncidentEvents(id, { limit: 100 });
  const attempts = db.listFixAttempts(id);
  return { inc, events, attempts, hi: B.needsHumanInput(inc, events, attempts, { labAuto: true }) };
};
function report(verdict, extra = {}) {
  return {
    verdict,
    failed_stage: verdict === "pass" ? "" : "checks",
    reason: verdict === "pass" ? "all checks passed" : "c1 failed: journal matched on 198.51.100.7 for YYBURNED01",
    checks: [
      { id: "g1", type: "activate_exit", generic: true, ok: true, label: "Activation exit 0", detail: "exit 0" },
      { id: "g2", type: "failed_units", generic: true, ok: true, label: "No failed units", detail: "none" },
      { id: "c1", type: "journal_absent", ok: verdict === "pass", label: "docker-searxng.service journal free of \"engine x failed\"", detail: verdict === "pass" ? "no match" : "matched: engine x failed at 198.51.100.7 (ops@example.org)" },
    ],
    generation: { before: 41, after: 41, restored: true, booted_unchanged: true, lab_toplevel: "/nix/store/zzzz-nixos-system-lab" },
    pins: { identical: true },
    watchdog: { armed: true, disarmed: true },
    activation: { exit_code: 0 },
    evidence: ["journal docker-searxng.service: engine x failed at 198.51.100.7 host lab01.example.net"],
    plan_source: "hermes",
    ...extra,
  };
}

// ---------------------------------------------------------------- schema

test("check plan schema: whitelisted types only, unknown fields/types dropped, bounded", () => {
  const ok = L.validateCheckPlan({
    checks: [
      { type: "unit_active", unit: "docker-searxng.service" },
      { type: "journal_absent", unit: "docker-searxng", pattern: "engine x failed" },
      { type: "http_status", url: "http://127.0.0.1:8080/healthz", expect_status: 200 },
      { type: "http_status", container: "searxng", port: 8080, path: "/healthz", contains: "ok" },
    ],
  });
  assert.equal(ok.errors.length, 0, ok.errors.join("; "));
  assert.deepEqual(ok.checks.map((c) => c.id), ["c1", "c2", "c3", "c4"]);
  assert.equal(ok.checks[1].unit, "docker-searxng.service", "unit normalized");

  const bad = L.validateCheckPlan({
    checks: [
      { type: "shell", cmd: "rm -rf /" },
      { type: "unit_active", unit: "x; reboot" },
      { type: "unit_active", unit: "ok.service", exec: "id" },
      { type: "http_status", url: "http://203.0.113.5/" },
      { type: "http_status", url: "file:///etc/shadow" },
      { type: "journal_absent", unit: "a.service", pattern: "" },
      { type: "http_status", container: "--privileged", port: 80, path: "/" },
    ],
  });
  assert.equal(bad.errors.length >= 6, true, bad.errors.join("; "));
  for (const c of bad.checks) assert.ok(L.LAB_CHECK_TYPES.includes(c.type));
  assert.equal(JSON.stringify(bad.checks).includes("rm -rf"), false);
  assert.equal(JSON.stringify(bad.checks).includes("203.0.113.5"), false, "non-loopback URL refused");
  assert.equal(JSON.stringify(bad.checks).includes("exec"), false, "unknown field dropped");

  const many = L.validateCheckPlan({ checks: Array.from({ length: 30 }, (_, i) => ({ type: "unit_active", unit: `u${i}.service` })) });
  assert.equal(many.checks.length, L.MAX_LAB_CHECKS);
  assert.ok(many.errors.some((e) => /more than 12/.test(e)));
  assert.deepEqual(L.validateCheckPlan("nope").checks, []);
  assert.deepEqual(L.defaultChecks("docker-searxng").map((c) => [c.type, c.unit]), [["unit_active", "docker-searxng.service"]]);
});

test("check ids: optional on every type, validated, kept or assigned; the worker's output re-validates unchanged", () => {
  const ids = L.validateCheckPlan({
    checks: [
      { type: "unit_active", unit: "chronyd.service", id: "c1" },
      { type: "journal_absent", unit: "chronyd", pattern: "no reachable server", id: "journal_1" },
      { type: "http_status", url: "http://127.0.0.1:8080/", id: "web-A" },
      { type: "unit_active", unit: "other.service", id: "c1" }, // duplicate id → reassigned
      { type: "unit_active", unit: "third.service", id: "activate" }, // generic id → reassigned
      { type: "unit_active", unit: "fourth.service" },
    ],
  });
  assert.deepEqual(ids.errors, []);
  assert.deepEqual(ids.checks.map((c) => c.id), ["c1", "journal_1", "web-A", "c2", "c3", "c4"]);
  // Round trip: what the worker writes into the job spec is exactly what the
  // root runner accepts (it re-validates with the same function).
  const again = L.validateCheckPlan({ checks: ids.checks });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.checks, ids.checks);
  const plain = L.validateCheckPlan([{ type: "unit_active", unit: "chronyd" }]);
  assert.deepEqual(L.validateCheckPlan(plain.checks), plain);
  assert.deepEqual(L.validateCheckPlan(L.defaultChecks("chronyd")).errors, []);
  // Same id, same check → still a duplicate (id/label are not part of the key).
  assert.equal(L.validateCheckPlan([{ type: "unit_active", unit: "a.service", id: "x" }, { type: "unit_active", unit: "a.service", id: "y" }]).checks.length, 1);
  for (const bad of ["a b", "x".repeat(33), "", "c1;id", "ü", 5, { x: 1 }]) {
    const r = L.validateCheck({ type: "unit_active", unit: "a.service", id: bad });
    assert.match(r.error || "", /id must be 1-32 chars/, JSON.stringify(bad));
  }
  assert.equal(L.validateCheck({ type: "unit_active", unit: "a.service", id: "x".repeat(32) }).check.id, "x".repeat(32));
  // Every type accepts id and label, and still rejects any other unknown field.
  for (const t of L.LAB_CHECK_TYPES) {
    const base = t === "http_status" ? { url: "http://127.0.0.1/" } : t === "journal_absent" ? { unit: "a.service", pattern: "boom!" } : { unit: "a.service" };
    assert.ok(L.validateCheck({ type: t, ...base, id: "k1", label: "L" }).check, t);
    assert.match(L.validateCheck({ type: t, ...base, idx: "k1" }).error, /unexpected field\(s\) idx/, t);
  }
});

test("skill doc: the documented check schema matches what the validator accepts", () => {
  const doc = fs.readFileSync(path.join(repo, "skills", "heimcloud-ops-labtest", "SKILL.md"), "utf8");
  assert.match(doc, /`id`/, "SKILL.md documents the optional id");
  assert.match(doc, /A-Za-z0-9_-\]\{1,32\}/);
  // Every JSON example in the doc validates without errors.
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(blocks.length >= 1);
  for (const b of blocks) assert.deepEqual(L.validateCheckPlan(b).errors, [], JSON.stringify(b));
});

test("branch and instance validation blocks injection", () => {
  for (const b of ["fix/labtest-pass", "fix/a/b.c_d-1", "ops/x"]) assert.ok(L.isValidBranch(b), b);
  for (const b of ["main", "fix/../x", "fix/x;reboot", "fix/$(id)", "-fix/x", "fix/x y", "fix/", "fix/x/"]) assert.equal(L.isValidBranch(b), false, b);
  assert.ok(L.isValidInstance("lab-12-2026-09-30T10-00-00-000Z"));
  for (const i of ["lab-12-x/../y", "fix-12-x", "lab-x-1", "lab-12-a b"]) assert.equal(L.isValidInstance(i), false, i);
});

test("keepUnitNames keeps unit / lock names readable, still redacts hosts and IPs", () => {
  const red = L.keepUnitNames((t) => B.makeDisplayRedactor([])(t));
  const out = red("docker-searxng.service failed at lab01.example.net 198.51.100.7, flake.lock ok");
  assert.match(out, /docker-searxng\.service/);
  assert.match(out, /flake\.lock/);
  assert.doesNotMatch(out, /example\.net|198\.51/);
});

// ---------------------------------------------------------------- ingest / status flow

test("status flow: lab_queued → testing (no badge) → lab_retry → fixing → pass → pr_opened; lab rows don't count as attempts", () => {
  const inc = incident();
  applyResult({ kind: "fix", incident_id: inc.id, status: "lab_queued", lab: "queued", branch: "fix/labtest-pass", attempts: 1, max_attempts: 2, lab_job: `lab-${inc.id}-a` });
  let v = view(inc.id);
  assert.equal(v.inc.status, "testing");
  assert.equal(v.hi.needed, false, "automated lab queued: no human badge");
  assert.equal(B.needsHumanInput(v.inc, v.events, v.attempts, { labAuto: false }).reasons[0].code, "awaiting_lab_test", "lab off: manual test needed");
  assert.equal(v.attempts.length, 1);

  applyResult({ kind: "fix", via: "lab", incident_id: inc.id, status: "lab_retry", lab: "failed", branch: "fix/labtest-pass", attempts: 1, max_attempts: 2, lab_report: report("fail") });
  v = view(inc.id);
  assert.equal(v.inc.status, "fixing");
  assert.equal(v.hi.needed, false);
  assert.equal(v.attempts.length, 1, "lab result is not a Hermes attempt");
  assert.equal(v.attempts[0].result, "lab_failed");

  applyResult({ kind: "fix", incident_id: inc.id, status: "lab_queued", lab: "queued", branch: "fix/labtest-pass", attempts: 2, max_attempts: 2 });
  applyResult({ kind: "fix", via: "lab", incident_id: inc.id, status: "compare_ready", lab: "passed", branch: "fix/labtest-pass", attempts: 2, max_attempts: 2, compare_url: "https://github.com/madebydamo/neo/compare/master...heimcloud:neo:fix/labtest-pass?expand=1", lab_report: report("pass") });
  v = view(inc.id);
  assert.equal(v.inc.status, "pr_opened");
  assert.equal(v.attempts.length, 2);
  assert.equal(v.attempts[1].result, "lab_passed");
  assert.match(v.inc.compare_url, /compare\/master\.\.\.heimcloud:neo:fix\/labtest-pass/);
  assert.equal(v.hi.reasons[0].code, "compare_ready");
});

test("needsHumanInput: badge on lab fail / error / rollback_unverified / cancel only", () => {
  const fail = incident();
  applyResult({ kind: "fix", incident_id: fail.id, status: "lab_queued", branch: "fix/x", attempts: 2, max_attempts: 2 });
  applyResult({ kind: "fix", via: "lab", incident_id: fail.id, status: "needs_human", lab: "failed", branch: "fix/x", attempts: 2, max_attempts: 2, summary: "Lab test failed after 2 attempt(s)", lab_report: report("fail") });
  let v = view(fail.id);
  assert.equal(v.inc.status, "needs_human");
  assert.equal(v.hi.reasons[0].code, "lab_failed");
  assert.match(v.hi.reasons[0].label, /after 2 attempt/);

  const err = incident();
  applyResult({ kind: "fix", incident_id: err.id, status: "lab_queued", branch: "fix/x", attempts: 1 });
  applyResult({ kind: "fix", via: "lab", incident_id: err.id, status: "lab_error", lab: "error", branch: "fix/x", summary: "Lab test error: rate limited", lab_job: `lab-${err.id}-x` });
  v = view(err.id);
  assert.equal(v.inc.status, "testing");
  assert.equal(v.hi.reasons[0].code, "lab_error");
  assert.deepEqual(v.hi.reasons[0].actions, ["retry_lab", "open_compare"]);

  const rb = incident();
  applyResult({ kind: "fix", incident_id: rb.id, status: "lab_queued", branch: "fix/x", attempts: 1 });
  applyResult({ kind: "fix", via: "lab", incident_id: rb.id, status: "needs_human", lab: "error", branch: "fix/x", summary: "ROLLBACK NOT VERIFIED after the lab test: check the host now." });
  assert.equal(view(rb.id).hi.reasons[0].code, "rollback_unverified");

  const running = incident();
  applyResult({ kind: "fix", incident_id: running.id, status: "lab_queued", branch: "fix/x", attempts: 1 });
  db.addIncidentEvent(running.id, "lab_enqueued", "Lab test re-enqueued", { job_kind: "lab" });
  assert.equal(view(running.id).hi.needed, false, "re-enqueued lab job: still no badge");
  assert.equal(view(running.id).hi.labQueued, true);
  const qcard = renderCard(buildCardModel(view(running.id).inc, view(running.id).events, [], B.makeDisplayRedactor([]), { labAuto: true }), "/admin", { lab: true });
  assert.match(qcard, /Automated lab test queued/);
  db.addIncidentEvent(running.id, "job_cancelled", "Pending lab job cancelled by admin", { job_kind: "lab", job_file: `${running.id}-2026-09-30T10-00-00-000Z.json`, stage: "pending" });
  v = view(running.id);
  assert.equal(v.hi.reasons[0].code, "lab_cancelled");
  assert.ok(v.hi.reasons[0].actions.includes("retry_lab"));
});

// ---------------------------------------------------------------- rendering + redaction

test("card + drawer: progress line, per-check list, evidence redacted (IPs, hosts, emails, burned slug)", () => {
  const inc = incident();
  applyResult({ kind: "fix", incident_id: inc.id, status: "lab_queued", branch: "fix/x", attempts: 1, max_attempts: 2 });
  applyResult({ kind: "fix", via: "lab", incident_id: inc.id, status: "lab_retry", lab: "failed", branch: "fix/x", attempts: 1, max_attempts: 2, lab_report: report("fail") });
  const inc2 = db.getIncident(inc.id);
  const events = db.listIncidentEvents(inc.id, { limit: 100 });
  const attempts = db.listFixAttempts(inc.id);
  const redact = B.makeDisplayRedactor(["YYBURNED01"]);
  const caps = { admin: true, fix: true, triage: true, lab: true, readOnly: false, runningJob: { kind: "lab", incidentId: inc.id, stageText: "Checks 3/8", elapsedSec: 42, startedAt: Date.now() - 42000 } };
  const card = buildCardModel(inc2, events, attempts, redact, { labAuto: true });
  const cardHtml = renderCard(card, "/admin", caps);
  assert.match(cardHtml, /class="kc-run" data-run data-lab/);
  assert.match(cardHtml, /lab · Checks 3\/8/);
  assert.match(cardHtml, /Lab failed/);
  assert.match(cardHtml, /✓ 2/);
  assert.match(cardHtml, /✗ 1/);
  assert.doesNotMatch(cardHtml, /class="kc-need"/, "retrying: no human badge");
  const d = buildDrawerModel(inc2, events, attempts, redact, { labAuto: true });
  const html = renderDrawer(d, "/admin", caps);
  assert.match(html, /data-lab-report/);
  assert.match(html, /<li class="ok">[\s\S]*Activation exit 0/);
  assert.match(html, /<li class="bad">[\s\S]*docker-searxng\.service journal free of/);
  assert.match(html, /41 → lab → 41/);
  assert.match(html, /byte-identical/);
  assert.match(html, /disarmed/);
  for (const leak of ["198.51.100.7", "lab01.example.net", "ops@example.org", "YYBURNED01"]) assert.equal(html.includes(leak) || cardHtml.includes(leak), false, leak);
});

test("card + drawer: dropped checks and a tolerated activation exit 4 are visible, not silent", () => {
  const inc = incident();
  applyResult({ kind: "fix", incident_id: inc.id, status: "lab_queued", branch: "fix/x", attempts: 1, max_attempts: 2 });
  const rep = report("fail", {
    plan_errors: ["#1: unit_active: unexpected field(s) idx"],
    plan_notes: ["check #3 dropped: unknown check type \"shell\" on 198.51.100.7"],
    activation: { exit_code: 4, tolerated_exit4: true, warning: "exit 4 tolerated: user bus unavailable" },
  });
  applyResult({ kind: "fix", via: "lab", incident_id: inc.id, status: "lab_retry", lab: "failed", branch: "fix/x", attempts: 1, max_attempts: 2, lab_report: rep });
  const inc2 = db.getIncident(inc.id);
  const events = db.listIncidentEvents(inc.id, { limit: 100 });
  const attempts = db.listFixAttempts(inc.id);
  const redact = B.makeDisplayRedactor(["YYBURNED01"]);
  const caps = { admin: true, fix: true, triage: true, lab: true, readOnly: false };
  const card = buildCardModel(inc2, events, attempts, redact, { labAuto: true });
  assert.deepEqual(card.labRun.dropped.length, 2);
  const cardHtml = renderCard(card, "/admin", caps);
  assert.match(cardHtml, /data-lab-dropped[^>]*>⚠ check #3 dropped: unknown check type/);
  assert.match(cardHtml, /\(\+1 more\)/);
  assert.match(cardHtml, /check #1 dropped: unit_active: unexpected field\(s\) idx/, "full list in the title");
  assert.match(cardHtml, /data-lab-actwarn>⚠ activation exit 4 tolerated: user bus unavailable/);
  const html = renderDrawer(buildDrawerModel(inc2, events, attempts, redact, { labAuto: true }), "/admin", caps);
  assert.match(html, /<dt>Dropped checks<\/dt>/);
  assert.match(html, /exit 4 <span class="warnv">\(exit 4 tolerated: user bus unavailable\)<\/span>/);
  assert.equal(html.includes("198.51.100.7") || cardHtml.includes("198.51.100.7"), false, "dropped notes are redacted");
  // No drops, clean exit: no extra lines.
  const plainHtml = renderCard(buildCardModel(db.getIncident(incident().id), [], [], redact, { labAuto: true }), "/admin", caps);
  assert.doesNotMatch(plainHtml, /data-lab-dropped|data-lab-actwarn/);
});

// ---------------------------------------------------------------- queue + admin

test("queue: lab kind listed, priority push › lab › triage › fix; fix refused while a lab job is pending", async () => {
  assert.deepEqual(QC.KINDS.slice().sort(), ["fix", "lab", "pr", "push", "triage"]);
  const a = incident();
  const b = incident();
  const c = incident();
  const d = incident();
  const w = (kind, id, sec) => {
    const name = `${id}-2026-09-30T10-00-${String(sec).padStart(2, "0")}-000Z.json`;
    fs.writeFileSync(path.join(Q, kind, name), JSON.stringify({ job_version: 1, kind, incident_id: id, branch: "fix/x" }));
    return name;
  };
  w("fix", a.id, 1);
  w("triage", b.id, 2);
  const lj = w("lab", c.id, 3);
  w("push", d.id, 4);
  await withAdmin(async (port) => {
    const q = (await request(port, "GET", "/admin/queue.json")).json.queue;
    assert.deepEqual(q.pending.map((j) => j.kind), ["push", "lab", "triage", "fix"]);
    const page = await request(port, "GET", "/admin/queue");
    assert.match(page.body, /k-lab/);
    db.updateIncident(c.id, { status: "testing" });
    const r = await request(port, "POST", `/admin/incidents/${c.id}/start-fix`, { json: {} });
    assert.notEqual(r.status, 200, "fix refused while lab pending");
    // Cancel the pending lab job; the card offers Retry lab; retry re-enqueues it.
    const cx = await request(port, "POST", "/admin/queue/cancel", { json: { kind: "lab", job: lj } });
    assert.equal(cx.status, 200, cx.body);
    assert.ok(fs.existsSync(path.join(Q, "failed", `lab-${lj}`)));
    assert.equal(view(c.id).hi.reasons[0].code, "lab_cancelled");
    const rl = await request(port, "POST", `/admin/incidents/${c.id}/retry-lab`, { json: {} });
    assert.equal(rl.status, 200, rl.body);
    const pend = fs.readdirSync(path.join(Q, "lab")).filter((f) => f.startsWith(`${c.id}-`));
    assert.equal(pend.length, 1);
    const job = JSON.parse(fs.readFileSync(path.join(Q, "lab", pend[0]), "utf8"));
    assert.equal(job.kind, "lab");
    assert.equal(job.branch, "fix/x");
    assert.equal(job.enqueued_by, "admin");
    assert.equal(view(c.id).hi.needed, false, "queued again: no badge");
    const again = await request(port, "POST", `/admin/incidents/${c.id}/retry-lab`, { json: {} });
    assert.equal(again.status, 409, "nothing to retry / already queued");
  });
});

test("retry-lab: lab_error job from failed/ re-enqueued with whitelisted fields only", async () => {
  const inc = incident();
  const name = `lab-${inc.id}-2026-09-30T11-00-00-000Z`;
  fs.writeFileSync(
    path.join(Q, "failed", `${name}.json`),
    JSON.stringify({ kind: "lab", incident_id: inc.id, branch: "fix/labtest-fail", attempt: 1, max_attempts: 2, lab_checks: [{ type: "shell", cmd: "id" }], evil: "x", compare_url: "javascript:alert(1)" }),
  );
  applyResult({ kind: "fix", via: "lab", incident_id: inc.id, status: "lab_error", lab: "error", branch: "fix/labtest-fail", lab_job: name, summary: "Lab test error: network" });
  await withAdmin(async (port) => {
    const r = await request(port, "POST", `/admin/incidents/${inc.id}/retry-lab`, { json: {} });
    assert.equal(r.status, 200, r.body);
    const f = fs.readdirSync(path.join(Q, "lab")).find((x) => x.startsWith(`${inc.id}-`));
    const job = JSON.parse(fs.readFileSync(path.join(Q, "lab", f), "utf8"));
    assert.equal(job.branch, "fix/labtest-fail");
    assert.equal(job.lab_checks, undefined, "plan re-derived, never copied");
    assert.equal(job.evil, undefined);
    assert.equal(job.compare_url, undefined);
    assert.ok(db.listIncidentEvents(inc.id).some((e) => e.kind === "lab_enqueued"));
  });
});
