/**
 * Host-shared job queue under OPS_DATA_DIR (default dirname(OPS_DB_PATH)).
 * Jobs never include customer_repo_slug or unredacted logs.
 */
import fs from "node:fs";
import path from "node:path";
import {
  redactIdentifyingDetails,
  mergeKnownSlugs,
  getExtraRedactSlugs,
} from "./redact.js";
import { listDistinctCustomerRepoSlugs } from "./db.js";

export function getDataDir() {
  if (process.env.OPS_DATA_DIR) return process.env.OPS_DATA_DIR;
  const db = process.env.OPS_DB_PATH || "/data/ops.sqlite";
  return path.dirname(path.resolve(db));
}

export function queueDir(kind) {
  return path.join(getDataDir(), "queue", kind);
}

export function resultsDir() {
  return path.join(getDataDir(), "results");
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

/**
 * Build a redacted job payload for the worker.
 * @param {'triage'|'fix'} kind
 * @param {object} incident
 */
export function buildJobPayload(kind, incident) {
  const knownSlugs = mergeKnownSlugs(
    listDistinctCustomerRepoSlugs(),
    ...getExtraRedactSlugs(),
    incident.customer_repo_slug,
  );
  const redact = (s) => redactIdentifyingDetails(s, { knownSlugs });
  return {
    kind,
    incident_id: incident.id,
    report_hash: String(incident.report_hash || ""),
    unit: redact(incident.unit || ""),
    severity: redact(incident.severity || ""),
    class: redact(incident.class || "unknown"),
    neo_version: redact(incident.neo_version || ""),
    logs_excerpt: redact(incident.logs_excerpt || ""),
    enqueued_at: new Date().toISOString(),
  };
}

/**
 * Atomic enqueue: write tmp then rename into queue/<kind>/.
 * @returns {{ path: string, job: object }}
 */
export function enqueueJob(kind, incident) {
  if (kind !== "triage" && kind !== "fix") {
    throw new Error("invalid_job_kind");
  }
  const job = buildJobPayload(kind, incident);
  // Defense: never allow slug field
  if ("customer_repo_slug" in job) delete job.customer_repo_slug;

  const dir = queueDir(kind);
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${incident.id}-${ts}.json`;
  const dest = path.join(dir, name);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  fs.renameSync(tmp, dest);
  return { path: dest, job };
}

export function listQueuedJobs(kind) {
  const dir = queueDir(kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))
    .map((f) => path.join(dir, f))
    .sort();
}
