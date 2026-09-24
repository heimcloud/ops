import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-autofix-"));
const dbPath = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DB_PATH = dbPath;
process.env.OPS_DATA_DIR = tmpDir;
delete process.env.OPS_AUTOTRIAGE;
delete process.env.OPS_REDACT_EXTRA_SLUGS;

// Build an OLD schema DB before importing the app.
{
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_hash TEXT NOT NULL UNIQUE,
      neo_version TEXT,
      plugin_urls TEXT,
      unit TEXT,
      logs_excerpt TEXT,
      customer_repo_slug TEXT,
      severity TEXT,
      target_hint TEXT,
      target_repo TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'triaged', 'pr_opened', 'resolved', 'closed')),
      class TEXT NOT NULL DEFAULT 'unknown'
        CHECK (class IN ('software', 'human_config', 'unknown')),
      draft_pr_url TEXT,
      draft_pr_number INTEGER,
      draft_branch TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO incidents (report_hash, unit, severity, status, class, customer_repo_slug)
    VALUES ('hash-old-1', 'docker-searxng', 'warning', 'open', 'unknown', 'ZZTEST0000');
  `);
  old.close();
}

const {
  getDb,
  _resetDbForTests,
  SCHEMA_VERSION,
  upsertIncident,
  updateIncident,
  getIncident,
} = await import("../lib/db.js");
const { enqueueJob, listQueuedJobs, buildJobPayload } = await import("../lib/queue.js");
const { applyResult, ingestResultsDir } = await import("../lib/results.js");
const { buildCompareUrl } = await import("../lib/compare.js");
const { findIdentifierHits, assertNoIdentifyingDetails } = await import(
  "../lib/redact.js"
);

before(() => {
  _resetDbForTests();
  getDb();
});

after(() => {
  _resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("migrates old CHECK schema to v2 and accepts fixing status", () => {
  const database = getDb();
  const v = database.pragma("user_version", { simple: true });
  assert.equal(v, SCHEMA_VERSION);
  const row = database.prepare(`SELECT * FROM incidents WHERE report_hash = ?`).get("hash-old-1");
  assert.ok(row);
  updateIncident(row.id, { status: "fixing" });
  assert.equal(getIncident(row.id).status, "fixing");
  const attempts = database
    .prepare(`SELECT name FROM sqlite_master WHERE name='fix_attempts'`)
    .get();
  assert.ok(attempts);
});

test("enqueueJob writes redacted job without slug field", () => {
  const { incident } = upsertIncident({
    report_hash: "hash-new-2",
    unit: "docker-searxng",
    severity: "warning",
    logs_excerpt: "Image docker.io/searxng/searxng:latest on ZZTEST0000",
    customer_repo_slug: "ZZTEST0000",
  });
  const { path: jobPath, job } = enqueueJob("fix", incident);
  assert.equal(job.kind, "fix");
  assert.equal(job.incident_id, incident.id);
  assert.equal("customer_repo_slug" in job, false);
  assert.equal(job.logs_excerpt.includes("ZZTEST0000"), false);
  assert.match(job.logs_excerpt, /docker\.io\/searxng\/searxng:latest/);
  const disk = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  assert.deepEqual(disk.incident_id, job.incident_id);
  assert.ok(listQueuedJobs("fix").length >= 1);
});

test("ingestResultsDir applies triage and fix results", () => {
  const { incident } = upsertIncident({
    report_hash: "hash-new-3",
    unit: "docker-searxng",
    severity: "warning",
  });
  const results = path.join(tmpDir, "results");
  fs.mkdirSync(results, { recursive: true });
  fs.writeFileSync(
    path.join(results, `${incident.id}-triage.json`),
    JSON.stringify({
      kind: "triage",
      incident_id: incident.id,
      status: "triaged",
      class: "software",
      summary: "engines stale vs image",
      target_repo: "madebydamo/neo",
    }),
  );
  let r = ingestResultsDir();
  assert.equal(r.ingested, 1);
  assert.equal(getIncident(incident.id).class, "software");
  assert.equal(getIncident(incident.id).status, "triaged");

  const branch = "fix/searxng-engines-limiter";
  fs.writeFileSync(
    path.join(results, `${incident.id}-fix.json`),
    JSON.stringify({
      kind: "fix",
      incident_id: incident.id,
      status: "awaiting_lab_test",
      branch,
      compare_url: buildCompareUrl(branch),
      pr_title: "ops: incident test",
      pr_body: "anonymous body",
      summary: "pushed",
    }),
  );
  r = ingestResultsDir();
  assert.equal(r.ingested, 1);
  const updated = getIncident(incident.id);
  assert.equal(updated.status, "testing");
  assert.equal(updated.draft_branch, branch);
  assert.match(updated.compare_url, /compare\/master\.\.\.heimcloud:neo:fix\/searxng-engines-limiter/);
});

test("buildCompareUrl rejects bad branch names", () => {
  assert.throws(() => buildCompareUrl("evil;rm"), /branch_name_rejected/);
  const url = buildCompareUrl("ops/incident-10");
  assert.equal(
    url,
    "https://github.com/madebydamo/neo/compare/master...heimcloud:neo:ops/incident-10?expand=1",
  );
});

test("redaction fail-closed on sample diff with identifiers", () => {
  const dirty = [
    "diff --git a/x b/x",
    "+ contact ops@example.com from 203.0.113.9",
    "+ host hattori",
    "+ slug ZZTEST9999",
  ].join("\n");
  const hits = findIdentifierHits(dirty, { knownSlugs: ["ZZTEST9999"] });
  assert.ok(hits.length >= 3);
  assert.throws(() => assertNoIdentifyingDetails(dirty, { knownSlugs: ["ZZTEST9999"] }));
  const clean = "diff --git a/nix/services/searxng/default.nix b/nix/services/searxng/default.nix\n+ limiter.toml\n";
  assert.equal(findIdentifierHits(clean, { knownSlugs: [] }).length, 0);
});

test("buildJobPayload never includes slug key", () => {
  const payload = buildJobPayload("triage", {
    id: 42,
    report_hash: "abc",
    unit: "u",
    severity: "low",
    class: "unknown",
    neo_version: "0.1",
    logs_excerpt: "ok",
    customer_repo_slug: "ZZTEST0000",
  });
  assert.equal(Object.hasOwn(payload, "customer_repo_slug"), false);
});
