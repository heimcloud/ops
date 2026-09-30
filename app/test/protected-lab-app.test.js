/**
 * Protected-path fixes (ops / Hermes / swag / base system on the shared
 * ops/lab host), app side: needs_human badge "Protected path (…): approve lab
 * test", admin-only Approve (signed job + lab_approved DB event, verified by
 * the root runner's own verifyApproval) and Skip (Awaiting PR, NOT
 * lab-tested). Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-prot-app-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_LAB = "true";
process.env.OPS_LAB_PROTECTED_WATCHDOG_SEC = "600";
delete process.env.ADMIN_READ_ONLY;

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { applyResult } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");
const B = await import("../lib/board.js");
const Q = await import("../lib/queue.js");
const { buildCardModel, buildDrawerModel, renderCard, renderDrawer } = await import("../lib/board-view.js");
const LT = await import("../../scripts/autofix/labtest.mjs");

for (const d of ["triage", "fix", "push", "lab", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(tmpDir, "queue", d), { recursive: true });

// Fake sqlite3 CLI for the runner's DB lookup (same contract: -readonly -json db sql).
const sqliteBin = path.join(tmpDir, "sqlite3");
fs.writeFileSync(
  sqliteBin,
  `#!${process.execPath}
const Database = require(${JSON.stringify(path.join(repo, "app", "node_modules", "better-sqlite3"))});
const a = process.argv.slice(2);
if (a[0] !== "-readonly" || a[1] !== "-json") process.exit(2);
const db = new Database(a[2], { readonly: true, fileMustExist: true });
const rows = db.prepare(a[3]).all();
process.stdout.write(rows.length ? JSON.stringify(rows) : "");
`,
  { mode: 0o755 },
);
const runnerCfg = () => ({
  opsDir: tmpDir,
  opsUid: process.getuid(),
  stateDir: path.join(tmpDir, "labstate"),
  dbPath: process.env.OPS_DB_PATH,
  sqlite: sqliteBin,
  approvalMaxAgeSec: 3 * 86400,
});

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CAPS = { readOnly: false, triage: true, fix: true, push: true, lab: true, protectedWatchdogSec: 600 };
const redact = (s) => String(s ?? "");
let n = 0;
function protectedIncident({ areas = ["hermes"], paths = ["nix/services/hermes"], core = false } = {}) {
  n += 1;
  const inc = db.upsertIncident({ report_hash: `prot-${n}`, unit: "docker-hermes.service", severity: "high", logs_excerpt: "agent crashed" }).incident;
  applyResult({
    kind: "fix",
    incident_id: inc.id,
    status: "lab_approval_needed",
    lab: "awaiting_approval",
    branch: `fix/prot-${n}`,
    job: `fix-${inc.id}-2026-01-01T00-00-00-000Z`,
    fix_job: `fix-${inc.id}-2026-01-01T00-00-00-000Z`,
    attempt: 1,
    head_sha: "e".repeat(40),
    base_sha: "f".repeat(40),
    compare_url: undefined,
    pending_compare_url: `https://github.com/example/neo/compare/dev...fork:neo:fix/prot-${n}?expand=1`,
    pr_title: "fix: agent",
    pr_body: "body",
    protected: { areas, paths, core, label: areas.join(", ") },
    summary: `Protected path (${areas.join(", ")}): approve lab test. Branch fix/prot-${n} was pushed to the fork.`,
  });
  return db.getIncident(inc.id);
}
const events = (id) => db.listIncidentEvents(id);
const card = (id) => buildCardModel(db.getIncident(id), events(id), db.listFixAttempts(id), redact, { labAuto: true });

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
function post(port, p, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: p, headers: { "content-type": "application/json", accept: "application/json", ...headers } },
      (res) => {
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
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}
const labJobs = (id) => fs.readdirSync(path.join(tmpDir, "queue", "lab")).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".json"));

test("protected fix result → needs_human badge with Approve / Skip; no compare link yet; badge stays", () => {
  const inc = protectedIncident();
  assert.equal(inc.status, "needs_human");
  assert.equal(inc.compare_url, null, "pending compare link is not the incident's compare link");
  const hi = B.needsHumanInput(inc, events(inc.id), db.listFixAttempts(inc.id));
  assert.equal(hi.needed, true);
  assert.equal(hi.reasons[0].code, "lab_approval");
  assert.equal(hi.reasons[0].label, "Protected path (hermes): approve lab test");
  assert.deepEqual(hi.reasons[0].actions, ["approve_lab", "skip_lab", "close"]);
  // Still there on the next render (nothing times it out).
  assert.equal(B.needsHumanInput(db.getIncident(inc.id), events(inc.id), []).reasons[0].code, "lab_approval");
  const html = renderCard(card(inc.id), "/admin", CAPS);
  assert.match(html, /action="\/admin\/incidents\/\d+\/approve-lab"/);
  assert.match(html, /action="\/admin\/incidents\/\d+\/skip-lab"/);
  assert.match(html, />Approve lab test</);
  assert.doesNotMatch(html, /base system!/);
  const drawer = renderDrawer(buildDrawerModel(db.getIncident(inc.id), events(inc.id), [], redact, { labAuto: true }), "/admin", CAPS);
  assert.match(drawer, /approve-lab/);
  assert.match(drawer, /Protected change \(hermes\).*watchdog 10 min/);
  // No lab capability on the host: no Approve button (Skip still there).
  assert.doesNotMatch(renderCard(card(inc.id), "/admin", { ...CAPS, lab: false }), /approve-lab/);
});

test("base system: stronger warning on the approval button + card chip", () => {
  const inc = protectedIncident({ areas: ["base system"], paths: ["nix/modules/core"], core: true });
  const html = renderDrawer(buildDrawerModel(db.getIncident(inc.id), events(inc.id), [], redact, { labAuto: true }), "/admin", CAPS);
  assert.match(html, /class="kbtn kbtn-lg primary danger" type="submit">Approve lab test \(base system!\)</);
  assert.match(html, /BASE SYSTEM change \(base system\).*can cut network \/ SSH/);
  assert.match(html, /console access/);
  assert.match(renderCard(card(inc.id), "/admin", CAPS), /class="kc-warn"[^>]*>BASE SYSTEM change: lab test needs your approval/);
});

test("approve: cross-origin refused; admin approval writes a signed job + lab_approved event the root runner accepts", async () => {
  const inc = protectedIncident();
  await withAdmin(async (port) => {
    const x = await post(port, `/admin/incidents/${inc.id}/approve-lab`, { headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } });
    assert.equal(x.status, 403);
    assert.equal(x.json.error, "cross_origin");
    assert.deepEqual(labJobs(inc.id), []);
    assert.equal(events(inc.id).some((e) => e.kind === "lab_approved"), false);

    const r = await post(port, `/admin/incidents/${inc.id}/approve-lab`);
    assert.equal(r.status, 200, r.body);
    assert.match(r.json.message, /Lab test approved \(protected: hermes\)/);
  });
  const cur = db.getIncident(inc.id);
  assert.equal(cur.status, "testing");
  const ev = events(inc.id).filter((e) => e.kind === "lab_approved");
  assert.equal(ev.length, 1);
  const meta = JSON.parse(ev[0].meta_json);
  assert.equal(meta.approved_by, "admin");
  assert.equal(meta.head_sha, "e".repeat(40));
  const [file] = labJobs(inc.id);
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "lab", file), "utf8"));
  assert.equal(job.approved_by, "admin");
  assert.deepEqual(job.protected.paths, ["nix/services/hermes"]);
  assert.equal(job.approval.by, "admin");
  assert.equal(job.approval.event_id, ev[0].id);
  assert.match(job.approval.sig, /^[0-9a-f]{64}$/);
  assert.equal(meta.lab_job, `lab-${file.replace(/\.json$/, "")}`);
  // Busy (worker progress), no badge.
  const hi = B.needsHumanInput(cur, events(inc.id), []);
  assert.equal(hi.needed, false);
  assert.equal(hi.labQueued, true);
  // Key: only the ops uid, 0700 / 0400.
  assert.equal(fs.statSync(path.join(tmpDir, "private")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(tmpDir, "private", "lab-approval.key")).mode & 0o777, 0o400);

  // The worker claims it as processing/lab-<file>; the root runner verifies.
  const instance = `lab-${file.replace(/\.json$/, "")}`;
  fs.copyFileSync(path.join(tmpDir, "queue", "lab", file), path.join(tmpDir, "queue", "processing", `${instance}.json`));
  const spec = LT.loadSpec(runnerCfg(), instance);
  assert.deepEqual(await LT.verifyApproval(runnerCfg(), spec, instance), { ok: true, eventId: ev[0].id });
  // Tampered copies are refused.
  const bad = async (patch, inst = instance) => (await LT.verifyApproval(runnerCfg(), { ...spec, ...patch }, inst)).reason;
  assert.match(await bad({ headSha: "0".repeat(40) }), /signature invalid/);
  assert.match(await bad({ branch: "fix/other" }), /signature invalid/);
  assert.match(await bad({}, `lab-${inc.id}-other`), /signature invalid/);
  assert.match(await bad({ approval: { ...spec.approval, sig: "a".repeat(64) } }), /signature invalid/);
  assert.match(await bad({ approval: { ...spec.approval, by: "hermes" } }), /malformed/);
  assert.match(await bad({ approval: undefined }), /no admin approval/);
  // A self-made "approval" (worker/Hermes can write events in theory, but not sign).
  const forged = db.addIncidentEvent(inc.id, "lab_approved", "forged", { ...meta, lab_job: instance });
  assert.match(await bad({ approval: { ...spec.approval, event_id: forged.id } }), /signature invalid/);
  // Second click: nothing waits for an approval any more.
  await withAdmin(async (port) => {
    const again = await post(port, `/admin/incidents/${inc.id}/approve-lab`);
    assert.equal(again.status, 409);
    assert.equal(again.json.error, "no_lab_approval");
  });
  assert.equal(labJobs(inc.id).length, 1);
});

test("retrying a cancelled approved lab job keeps the protected flag but never the approval", () => {
  const inc = protectedIncident();
  const r = Q.enqueueLabRetry(inc, {
    incident_id: inc.id,
    branch: "fix/prot-x",
    head_sha: "e".repeat(40),
    protected: { areas: ["hermes"], paths: ["nix/services/hermes"] },
    approved_by: "admin",
    approval: { v: 1, by: "admin", event_id: 1, approved_at: new Date().toISOString(), sig: "a".repeat(64) },
  });
  assert.deepEqual(r.job.protected.paths, ["nix/services/hermes"]);
  assert.equal(r.job.approval, undefined);
  assert.equal(r.job.approved_by, undefined);
  fs.rmSync(r.path);
});

test("approve refused: not waiting for an approval, lab stage off, key dir with a wrong mode", async () => {
  const plain = db.upsertIncident({ report_hash: "prot-plain", unit: "docker-x.service", severity: "low", logs_excerpt: "x" }).incident;
  applyResult({ kind: "fix", incident_id: plain.id, status: "needs_human", summary: "Hermes gave up" });
  const inc = protectedIncident();
  await withAdmin(async (port) => {
    const a = await post(port, `/admin/incidents/${plain.id}/approve-lab`);
    assert.equal(a.status, 409);
    assert.equal(a.json.error, "no_lab_approval");
    const s = await post(port, `/admin/incidents/${plain.id}/skip-lab`);
    assert.equal(s.status, 409);

    process.env.OPS_AUTOFIX_LAB = "false";
    try {
      const off = await post(port, `/admin/incidents/${inc.id}/approve-lab`);
      assert.equal(off.status, 409);
      assert.equal(off.json.error, "autofix_disabled");
    } finally {
      process.env.OPS_AUTOFIX_LAB = "true";
    }

    fs.chmodSync(path.join(tmpDir, "private"), 0o755);
    try {
      const k = await post(port, `/admin/incidents/${inc.id}/approve-lab`);
      assert.equal(k.status, 500);
      assert.equal(k.json.error, "approval_key");
    } finally {
      fs.chmodSync(path.join(tmpDir, "private"), 0o700);
    }
  });
  assert.equal(db.getIncident(inc.id).status, "needs_human", "badge stays");
  assert.equal(events(inc.id).some((e) => e.kind === "lab_approved"), false, "no event without a usable key");
  assert.deepEqual(labJobs(inc.id), []);
});

test("skip: Awaiting PR with the compare link and a NOT lab-tested warning", async () => {
  const inc = protectedIncident({ areas: ["ops"], paths: ["nix/services/ops"] });
  await withAdmin(async (port) => {
    const r = await post(port, `/admin/incidents/${inc.id}/skip-lab`);
    assert.equal(r.status, 200, r.body);
    assert.match(r.json.message, /NOT lab-tested/);
  });
  const cur = db.getIncident(inc.id);
  assert.equal(cur.status, "pr_opened");
  assert.match(cur.compare_url, /^https:\/\/github\.com\/example\/neo\/compare\//);
  const ev = events(inc.id).find((e) => e.kind === "lab_skipped");
  assert.equal(JSON.parse(ev.meta_json).warning, "not lab-tested");
  const hi = B.needsHumanInput(cur, events(inc.id), []);
  assert.equal(hi.reasons[0].code, "compare_untested");
  assert.match(hi.reasons[0].label, /NOT lab-tested/);
  assert.match(hi.reasons[0].detail, /protected change \(ops\) was NOT lab-tested/);
  assert.deepEqual(hi.reasons[0].actions, ["open_compare", "mark_resolved"]);
  assert.match(renderCard(card(inc.id), "/admin", CAPS), /class="kc-warn"[^>]*>NOT lab-tested/);
  assert.deepEqual(labJobs(inc.id), [], "no lab job");
});

test("drawer lab report: protected run, approval event, watchdog deadline, services after rollback", () => {
  const inc = protectedIncident({ areas: ["ops"], paths: ["nix/services/ops"] });
  applyResult({
    kind: "lab",
    via: "lab",
    incident_id: inc.id,
    status: "needs_human",
    lab: "error",
    services_unhealthy: true,
    summary: "Lab test fail and rolled back, but ops /health is still down after a restart: check the host now.",
    lab_report: {
      verdict: "fail",
      reason: "protected run: ops /health down after activation; rolled back immediately",
      checks: [],
      generation: { before: 41, after: 41, restored: true, booted_unchanged: true },
      watchdog: { armed: true, disarmed: true, deadline_sec: 600 },
      protected: { areas: ["ops"], paths: ["nix/services/ops"], approved: true, approval_event_id: 12 },
      protected_probe: { ops_health: false, ops_detail: "HTTP 503", hermes_active: true, hermes_detail: "active" },
      post_rollback_services: { ops_health: { ok: false, detail: "HTTP 503", restarted: true }, hermes_active: { ok: true, detail: "active" }, ok: false },
      services_unhealthy: true,
    },
  });
  const hi = B.needsHumanInput(db.getIncident(inc.id), events(inc.id), []);
  assert.equal(hi.reasons[0].code, "services_unhealthy");
  const html = renderDrawer(buildDrawerModel(db.getIncident(inc.id), events(inc.id), [], redact, { labAuto: true }), "/admin", CAPS);
  assert.match(html, /<dt>Protected<\/dt><dd><span class="warnv">ops<\/span> · approved by admin \(event #12\)/);
  assert.match(html, /deadline 10 min/);
  assert.match(html, /<dt>Ops \/ Hermes after activation<\/dt><dd>ops \/health <span class="badv">down<\/span>/);
  assert.match(html, /<dt>Services after rollback<\/dt><dd>ops \/health <span class="badv">down<\/span> \(restarted\).*STILL DOWN: check the host/);
});
