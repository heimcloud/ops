/**
 * App-side autofix hardening: disabled gate, clear EACCES message, duplicate
 * guard, non-throwing results ingest, status mapping, copy sync, Nix path match.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-hardening-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
delete process.env.OPS_AUTOFIX_FIX;
delete process.env.OPS_AUTOFIX_TRIAGE;
delete process.env.OPS_REDACT_EXTRA_SLUGS;

const { upsertIncident, getIncident, _resetDbForTests } = await import("../lib/db.js");
const { enqueueJob, queueDir, isAutofixKindEnabled, findPendingJobs } = await import(
  "../lib/queue.js"
);
const { ingestResultsDir, fixStatusToIncidentStatus, applyResult } = await import(
  "../lib/results.js"
);

after(() => {
  _resetDbForTests();
  for (const d of [path.join(tmpDir, "queue"), path.join(tmpDir, "results")]) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function incident(hash) {
  return upsertIncident({
    report_hash: hash,
    unit: "docker-searxng",
    severity: "warning",
    logs_excerpt: "engine failed on ZZTEST0000",
    customer_repo_slug: "ZZTEST0000",
  }).incident;
}

test("Start fix refuses with a clear message when autofix fix is disabled", () => {
  assert.equal(isAutofixKindEnabled("fix"), false);
  const inc = incident("hash-disabled");
  assert.throws(
    () => enqueueJob("fix", inc),
    (err) => err.code === "autofix_disabled" && /not enabled on this host/.test(err.message),
  );
  assert.equal(fs.existsSync(queueDir("fix")), false, "no dir created when disabled");
});

test("unwritable queue dir yields an operator-readable error, not raw EACCES", { skip: process.getuid?.() === 0 }, () => {
  process.env.OPS_AUTOFIX_FIX = "true";
  const q = path.join(tmpDir, "queue");
  fs.mkdirSync(path.join(q, "fix"), { recursive: true });
  fs.chmodSync(q, 0o000); // like root:root 0770 seen from the container uid
  try {
    const inc = incident("hash-eacces");
    assert.throws(
      () => enqueueJob("fix", inc),
      (err) =>
        err.code === "queue_dir_not_writable" &&
        /not writable by the ops container/.test(err.message) &&
        /2770/.test(err.message),
    );
  } finally {
    fs.chmodSync(q, 0o700);
  }
});

test("duplicate fix job for the same incident is refused (queued or processing)", () => {
  process.env.OPS_AUTOFIX_FIX = "true";
  const inc = incident("hash-dup");
  const { path: p } = enqueueJob("fix", inc);
  assert.throws(() => enqueueJob("fix", inc), (e) => e.code === "already_queued");
  // Worker claimed it into processing/: still refused.
  const proc = path.join(tmpDir, "queue", "processing");
  fs.mkdirSync(proc, { recursive: true });
  fs.renameSync(p, path.join(proc, `fix-${path.basename(p)}`));
  assert.equal(findPendingJobs("fix", inc.id).length, 1);
  assert.throws(() => enqueueJob("fix", inc), (e) => e.code === "already_queued");
  const job = JSON.parse(fs.readFileSync(path.join(proc, `fix-${path.basename(p)}`), "utf8"));
  assert.equal(job.job_version, 1);
  assert.equal(JSON.stringify(job).includes("ZZTEST0000"), false);
});

test("ingestResultsDir never throws on missing or unreadable results dir", { skip: process.getuid?.() === 0 }, () => {
  const r = path.join(tmpDir, "results");
  fs.rmSync(r, { recursive: true, force: true });
  assert.deepEqual(ingestResultsDir().ingested, 0);
  fs.mkdirSync(r);
  fs.chmodSync(r, 0o000);
  let out;
  assert.doesNotThrow(() => {
    out = ingestResultsDir();
  });
  assert.equal(out.skipped, "unreadable");
  fs.chmodSync(r, 0o770);
});

test("bad result files are parked as .rejected.json instead of retried forever", () => {
  const r = path.join(tmpDir, "results");
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "fix-999999-x.json"), JSON.stringify({ kind: "fix", incident_id: 999999, status: "needs_human" }));
  const out = ingestResultsDir();
  assert.equal(out.errors.length, 1);
  assert.ok(fs.existsSync(path.join(r, "fix-999999-x.rejected.json")));
  assert.equal(ingestResultsDir().errors.length, 0);
});

test("fix status mapping never leaves an incident stuck in fixing", () => {
  assert.equal(fixStatusToIncidentStatus("awaiting_lab_test"), "testing");
  assert.equal(fixStatusToIncidentStatus("compare_ready"), "pr_opened");
  assert.equal(fixStatusToIncidentStatus("no_token"), "triaged");
  for (const s of ["needs_human", "redaction_blocked", "denied", "failed", "weird", undefined]) {
    assert.equal(fixStatusToIncidentStatus(s), "needs_human", String(s));
  }
  const inc = incident("hash-map");
  applyResult({ kind: "fix", incident_id: inc.id, status: "redaction_blocked", summary: "x" });
  assert.equal(getIncident(inc.id).status, "needs_human");
});

test("triage result only promotes open incidents", () => {
  const inc = incident("hash-triage");
  applyResult({ kind: "triage", incident_id: inc.id, status: "triaged", class: "software" });
  assert.equal(getIncident(inc.id).status, "triaged");
  const inc2 = incident("hash-triage-2");
  applyResult({ kind: "fix", incident_id: inc2.id, status: "awaiting_lab_test", branch: "fix/x" });
  applyResult({ kind: "triage", incident_id: inc2.id, status: "triaged", class: "software" });
  assert.equal(getIncident(inc2.id).status, "testing");
});

test("worker copies of redact.js / compare.js / queue-control.js / lab-checks.js are byte-identical to app/lib", () => {
  for (const f of ["redact.js", "compare.js", "queue-control.js", "lab-checks.js"]) {
    const a = fs.readFileSync(path.join(repo, "app", "lib", f), "utf8");
    const b = fs.readFileSync(path.join(repo, "scripts", "autofix", f), "utf8");
    assert.equal(a, b, `${f} drifted: cp app/lib/${f} scripts/autofix/${f}`);
  }
});

test("Nix path unit watches the host dir the container writes to", () => {
  const def = fs.readFileSync(path.join(repo, "modules/services/ops/default.nix"), "utf8");
  const af = fs.readFileSync(path.join(repo, "modules/services/ops/autofix.nix"), "utf8");
  assert.match(def, /"\$\{opsAppdata\}:\/data"/, "container /data = host opsAppdata");
  assert.match(def, /OPS_DATA_DIR = "\/data"/);
  assert.match(af, /queueRoot = "\$\{opsAppdata\}\/queue"/);
  // PathChanged on the kind dirs (not PathExistsGlob: a paused or disabled
  // queue with jobs would re-trigger in a loop and hit the start limit).
  assert.match(af, /PathChanged =/);
  assert.doesNotMatch(af, /PathExistsGlob =/);
  assert.match(af, /"\$\{queueRoot\}\/fix"/);
  assert.match(af, /"\$\{queueRoot\}\/triage"/);
  assert.match(af, /heimcloud-ops-worker-kick/);
  assert.match(af, /StartLimitIntervalSec/);
  for (const f of [def, af]) assert.match(f, /"queue\/control"|queue\/control"/, "control dir is an exchange dir");
  assert.equal(path.relative(tmpDir, queueDir("fix")), path.join("queue", "fix"));
  // Exchange dirs must never be created root-owned again.
  assert.doesNotMatch(def, /mkdir -p \$\{opsAppdata\}\/queue/);
  assert.match(def, /install -d -m 2770 -o \$\{uid\} -g \$\{gid\}/);
});
