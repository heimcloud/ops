/**
 * Kanban board pure logic: transition table, needsHumanInput rules (real
 * triage_result / fix_result payload shapes), triage verdict (new + legacy),
 * filters, display redaction, Zurich time. Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.OPS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ops-board-logic-")), "ops.sqlite");

const B = await import("../lib/board.js");

test("transition table: worker-owned targets refused, Done reopens, needs_human exits", () => {
  for (const from of Object.keys(B.TRANSITIONS)) {
    for (const to of ["fixing", "testing"]) {
      if (from === to) continue;
      const r = B.checkTransition(from, to);
      assert.equal(r.ok, false, `${from} -> ${to}`);
      assert.equal(r.code, "worker_owned");
      assert.match(r.message, /host worker/);
    }
  }
  for (const done of ["resolved", "closed"]) {
    assert.ok(B.checkTransition(done, "open").ok);
    assert.ok(B.checkTransition(done, "triaged").ok);
    assert.equal(B.checkTransition(done, "needs_human").code, "invalid_transition");
    assert.equal(B.checkTransition(done, "pr_opened").code, "invalid_transition");
  }
  assert.ok(B.checkTransition("resolved", "closed").ok);
  assert.ok(B.checkTransition("closed", "resolved").ok);
  for (const to of ["triaged", "closed", "resolved"]) assert.ok(B.checkTransition("needs_human", to).ok, to);
  assert.equal(B.checkTransition("needs_human", "open").ok, false);
  assert.equal(B.checkTransition("needs_human", "pr_opened").ok, false);
  assert.deepEqual(B.TRANSITIONS.fixing, ["needs_human"], "only unstick a dead job");
  assert.ok(B.checkTransition("testing", "pr_opened").ok, "manual lab test passed");
  assert.equal(B.checkTransition("open", "pr_opened").ok, false);
  assert.equal(B.checkTransition("open", "bogus").code, "invalid_status");
  assert.ok(B.checkTransition("open", "open").ok, "no-op");
  // Every status has a row, and no row targets itself or an unknown status.
  for (const s of ["open", "triaged", "fixing", "testing", "needs_human", "pr_opened", "resolved", "closed"]) {
    assert.ok(Array.isArray(B.TRANSITIONS[s]), s);
    for (const t of B.TRANSITIONS[s]) {
      assert.notEqual(t, s);
      assert.ok(B.TRANSITIONS[t], t);
      assert.equal(B.WORKER_OWNED.includes(t), false, `${s} -> ${t} must not be worker-owned`);
    }
  }
});

test("columns: Done groups resolved + closed; every status has a column", () => {
  assert.deepEqual(B.COLUMNS.map((c) => c.key), ["open", "triaged", "fixing", "testing", "needs_human", "pr_opened", "done"]);
  assert.equal(B.columnForStatus("resolved"), "done");
  assert.equal(B.columnForStatus("closed"), "done");
  assert.equal(B.columnForStatus("pr_opened"), "pr_opened");
});

let evId = 0;
const ev = (kind, meta) => ({ id: ++evId, kind, message: meta?.summary || kind, meta_json: meta ? JSON.stringify(meta) : null });
const inc = (status, extra = {}) => ({ id: 7, status, class: "unknown", compare_url: null, ...extra });
const codes = (r) => r.reasons.map((x) => x.code);
const JOB = "fix-7-2026-01-01T00-00-00-000Z";

test("needsHumanInput: triage verdicts (new contract)", () => {
  const t = (meta) => B.needsHumanInput(inc("triaged"), [ev("triage_result", { kind: "triage", status: "triaged", ...meta })], []);
  let r = t({ class: "unknown", verdict: "uncertain", confidence: 0.5, fixable: false });
  assert.equal(r.needed, true);
  assert.deepEqual(codes(r), ["triage_uncertain"]);
  assert.deepEqual(r.reasons[0].actions, ["start_fix", "mark_config_error"]);
  r = t({ class: "software", verdict: "code_fix", confidence: 0.3, fixable: true });
  assert.deepEqual(codes(r), ["triage_uncertain"], "low confidence code_fix = uncertain");
  assert.match(r.reasons[0].label, /low confidence \(30%\)/);
  r = t({ class: "human_config", verdict: "config_error", confidence: 0.9 });
  assert.deepEqual(codes(r), ["triage_config_error"]);
  assert.equal(r.reasons[0].action, "mark_config_error");
  r = t({ class: "software", verdict: "not_actionable", confidence: 0.8, fixable: false });
  assert.deepEqual(codes(r), ["triage_not_actionable"]);
  r = t({ class: "software", verdict: "code_fix", confidence: 0.9, fixable: true });
  assert.deepEqual(codes(r), ["fix_ready"]);
  assert.equal(r.reasons[0].action, "start_fix");
});

test("needsHumanInput: old triage results (no verdict/confidence) still handled", () => {
  const t = (meta) => codes(B.needsHumanInput(inc("triaged"), [ev("triage_result", { kind: "triage", status: "triaged", ...meta })], []));
  assert.deepEqual(t({ class: "unknown", fixable: false }), ["triage_uncertain"]);
  assert.deepEqual(t({ class: "human_config", fixable: false }), ["triage_config_error"]);
  assert.deepEqual(t({ class: "software", fixable: false }), ["triage_not_actionable"]);
  assert.deepEqual(t({ class: "software", fixable: true }), ["fix_ready"]);
  assert.equal(B.interpretTriage({ class: "software", fixable: true }).legacy, true);
  assert.equal(B.interpretTriage({ verdict: "code_fix", confidence: "high" }).confidence, 0.9);
  assert.equal(B.interpretTriage({ verdict: "code_fix", confidence: 85 }).confidence, 0.85);
});

test("needsHumanInput: open / triage failed / triage running", () => {
  assert.deepEqual(codes(B.needsHumanInput(inc("open"), [ev("ingest")], [])), ["not_triaged"]);
  const failed = B.needsHumanInput(inc("open"), [ev("triage_result", { kind: "triage", status: "triage_failed", summary: "no JSON" })], []);
  assert.deepEqual(codes(failed), ["triage_failed"]);
  assert.equal(failed.reasons[0].action, "start_triage");
  const running = B.needsHumanInput(inc("open"), [ev("ingest"), ev("triage_enqueued", {})], []);
  assert.equal(running.needed, false, "triage job queued: nothing to do yet");
});

test("needsHumanInput: ready_no_token / push_failed → Retry push", () => {
  const events = [
    ev("triage_result", { kind: "triage", status: "triaged", class: "software", fixable: true }),
    ev("fix_result", { kind: "fix", status: "ready_no_token", job: JOB, branch: "fix/x", summary: "waiting for token" }),
  ];
  let r = B.needsHumanInput(inc("triaged"), events, []);
  assert.deepEqual(codes(r), ["ready_no_token"]);
  assert.equal(r.reasons[0].action, "retry_push");
  r = B.needsHumanInput(inc("triaged"), [...events, ev("fix_result", { kind: "fix", status: "push_failed", push_error: "auth", job: JOB, summary: "push failed" })], []);
  assert.deepEqual(codes(r), ["push_failed"]);
  assert.match(r.reasons[0].label, /auth/);
  assert.equal(r.reasons[0].action, "retry_push");
  // Legacy needs_human "git push to fork failed" with the job in the evidence path.
  r = B.needsHumanInput(inc("needs_human"), [ev("fix_result", { kind: "fix", status: "needs_human", summary: "git push to fork failed: x", evidence_path: `/h/workspace/autofix/${JOB}/fix-hermes-1.log` })], [{ attempt: 1 }]);
  assert.deepEqual(codes(r), ["push_failed"]);
  assert.equal(r.reasons[0].action, "retry_push");
  // Retry already queued → not waiting on Damo.
  r = B.needsHumanInput(inc("triaged"), [...events, ev("push_enqueued", { job: JOB })], []);
  assert.equal(r.needed, false);
});

test("needsHumanInput: compare link ready, lab test needed, lab failed", () => {
  let r = B.needsHumanInput(
    inc("pr_opened", { compare_url: "https://github.com/madebydamo/neo/compare/dev...heimcloud:neo:fix/x?expand=1" }),
    [ev("fix_result", { kind: "fix", status: "compare_ready", lab: "passed" })],
    [{ attempt: 1 }],
  );
  assert.deepEqual(codes(r), ["compare_ready"]);
  assert.deepEqual(r.reasons[0].actions, ["open_compare", "mark_resolved"]);
  r = B.needsHumanInput(inc("testing", { compare_url: "https://github.com/x/y" }), [ev("fix_result", { kind: "fix", status: "awaiting_lab_test", lab: "skipped" })], [{ attempt: 1 }]);
  assert.deepEqual(codes(r), ["awaiting_lab_test"]);
  assert.equal(r.reasons[0].label, "Lab test needed");
  r = B.needsHumanInput(inc("testing"), [], []);
  assert.deepEqual(codes(r), ["awaiting_lab_test"], "testing with no lab result at all");
  r = B.needsHumanInput(
    inc("needs_human"),
    [ev("fix_result", { kind: "fix", status: "needs_human", lab: "failed", attempts: 2, max_attempts: 2, summary: "Lab test failed after 2 attempt(s): x" })],
    [{ attempt: 1 }, { attempt: 2 }],
  );
  assert.deepEqual(codes(r), ["lab_failed"]);
  assert.match(r.reasons[0].label, /after 2 attempt/);
});

test("needsHumanInput: needs_human after retries / redaction_blocked / denied show the reason", () => {
  const nh = (meta, attempts = []) => B.needsHumanInput(inc("needs_human"), [ev("fix_result", { kind: "fix", ...meta })], attempts);
  let r = nh({ status: "needs_human", attempts: 2, max_attempts: 2, summary: "Hermes gave up: flaky" }, [{ attempt: 1 }, { attempt: 2 }]);
  assert.deepEqual(codes(r), ["needs_human_after_retries"]);
  assert.match(r.reasons[0].detail, /Hermes gave up/);
  r = nh({ status: "redaction_blocked", summary: "redaction_fail_closed:diff:email" });
  assert.deepEqual(codes(r), ["redaction_blocked"]);
  assert.match(r.reasons[0].detail, /redaction_fail_closed/);
  r = nh({ status: "denied", summary: "diff touches deny-listed path nix/services/ops" });
  assert.deepEqual(codes(r), ["denied"]);
  r = nh({ status: "needs_human", summary: "git clone failed" });
  assert.deepEqual(codes(r), ["needs_human"]);
  r = B.needsHumanInput(inc("needs_human"), [], []);
  assert.deepEqual(codes(r), ["needs_human"], "moved by hand: still flagged");
});

test("needsHumanInput: fixing / resolved / closed need nothing", () => {
  for (const s of ["fixing", "resolved", "closed"]) {
    assert.deepEqual(B.needsHumanInput(inc(s), [ev("fix_result", { status: "needs_human" })], []), { needed: false, reasons: [], labQueued: false });
  }
});

test("filters: URL parse (cols, legacy status) and matching over redacted card fields", () => {
  const f = B.parseFilters({ q: " searx ", sev: "high", mine: "1", cols: ["open,triaged", "bogus"] });
  assert.deepEqual(f, { q: "searx", sev: "high", class: "", unit: "", repo: "", mine: true, cols: ["open", "triaged"] });
  assert.deepEqual(B.parseFilters({ status: "closed" }).cols, ["done"]);
  assert.equal(B.parseFilters({}).cols, null);
  assert.equal(B.hasActiveFilters(B.parseFilters({})), false);
  const card = { severity: "high", klass: "software", unit: "docker-searxng.service", repo: "madebydamo/neo", needed: true, searchText: "#7 engine list stale docker-searxng.service" };
  assert.ok(B.cardMatches(card, f));
  assert.equal(B.cardMatches(card, { ...f, q: "#7 stale" }), true);
  assert.equal(B.cardMatches(card, { ...f, q: "nope" }), false);
  assert.equal(B.cardMatches({ ...card, needed: false }, f), false);
  assert.equal(B.cardMatches(card, { ...f, unit: "docker-shop" }), false);
});

test("display redactor: unit suffixes readable, identifiers still redacted", () => {
  const r = B.makeDisplayRedactor(["ZZTEST0000"]);
  assert.equal(r("docker-searxng.service failed"), "docker-searxng.service failed");
  assert.equal(r("see push-pending.json"), "see push-pending.json");
  const out = r("zztest0000 on box1.example-customer.net 198.51.100.23 ops@example-customer.net /home/zzuser/x hattori.service cust.example.org.json");
  for (const bad of ["zztest0000", "example-customer", "198.51.100", "ops@", "zzuser", "hattori", "example.org"]) {
    assert.equal(out.toLowerCase().includes(bad), false, bad);
  }
  assert.equal(r("login failed for user alice7 (username: bob_x, user='carol')"), "login failed for user [redacted-user] (username: [redacted-user], user='[redacted-user]')");
  assert.equal(r("user facing error"), "user facing error");
  const cmp = "https://github.com/madebydamo/neo/compare/dev...heimcloud:neo:fix/searxng-engines?expand=1";
  assert.equal(B.safeLink(cmp, r), cmp);
  assert.equal(B.safeLink("https://github.com/madebydamo/neo/compare/dev...heimcloud:neo:fix/ZZTEST0000", r), null);
  assert.equal(B.safeLink("https://evil.example.net/x", r), null);
});

test("Zurich time + age", () => {
  assert.equal(B.formatZurich("2026-09-30 10:00:00"), "2026-09-30 12:00", "SQLite UTC → CEST");
  assert.equal(B.formatZurich("2026-01-15T10:00:00.000Z"), "2026-01-15 11:00", "CET");
  assert.equal(B.ageLabel("2026-09-30T10:00:00Z", new Date("2026-09-30T10:30:00Z")), "30m");
  assert.equal(B.ageLabel("2026-09-27T10:00:00Z", new Date("2026-09-30T10:00:00Z")), "3d");
  assert.equal(B.incidentSummary({ logs_excerpt: "\n  first line\nsecond" }, []), "first line");
  assert.equal(B.incidentSummary({}, [{ id: 1, kind: "triage_result", meta_json: JSON.stringify({ summary: "from triage" }) }]), "from triage");
});
