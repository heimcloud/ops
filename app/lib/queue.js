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

const TRUE = ["1", "true", "yes", "on"];

/**
 * Host worker for this job kind is installed (autofix.<kind>.enable via Nix env).
 * "push" (retry pushing a saved fix) is handled by the fix worker.
 */
export function isAutofixKindEnabled(kind) {
  const key = kind === "triage" ? "OPS_AUTOFIX_TRIAGE" : "OPS_AUTOFIX_FIX";
  return TRUE.includes(String(process.env[key] || "").toLowerCase());
}

/**
 * Fork-push token availability as last seen by the host worker
 * (queue/worker-status.json), else the Nix hint OPS_AUTOFIX_TOKEN_CONFIGURED.
 * @returns {{ known: boolean, ok: boolean, source: string, reason?: string, checked_at?: string }}
 */
export function getForkPushTokenState() {
  try {
    const st = JSON.parse(
      fs.readFileSync(path.join(getDataDir(), "queue", "worker-status.json"), "utf8"),
    );
    if (typeof st.fork_push_token === "boolean") {
      return {
        known: true,
        ok: st.fork_push_token,
        source: "worker",
        reason: st.reason || undefined,
        checked_at: st.checked_at,
      };
    }
  } catch {
    /* fall through to the Nix hint */
  }
  const hint = String(process.env.OPS_AUTOFIX_TOKEN_CONFIGURED || "").toLowerCase();
  if (TRUE.includes(hint)) return { known: true, ok: true, source: "config" };
  if (["0", "false", "no", "off"].includes(hint)) return { known: true, ok: false, source: "config" };
  return { known: false, ok: false, source: "unknown" };
}

export const NO_TOKEN_WARNING =
  "Fork-push token not available on the host: the fix will be coded, gated and committed locally, " +
  "but the push will be skipped (result ready_no_token, incident back to triaged).";

export class QueueError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.status = code === "autofix_disabled" || code === "already_queued" ? 409 : 503;
    if (cause) this.cause = cause;
  }
}

function whoami() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "?";
  const gid = typeof process.getgid === "function" ? process.getgid() : "?";
  return `${uid}:${gid}`;
}

/**
 * mkdir -p that turns EACCES/EPERM/EROFS into an operator-readable error
 * (the raw Node error only says "permission denied, mkdir").
 */
export function ensureDir(d) {
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    if (["EACCES", "EPERM", "EROFS"].includes(err.code)) {
      throw new QueueError(
        "queue_dir_not_writable",
        `Autofix queue directory ${d} is not writable by the ops container (uid:gid ${whoami()}, ${err.code}). ` +
          "Host fix: the queue/ and results/ dirs under the ops AppData must be owned by the Neo core user with mode 2770 " +
          "(created by the ops module; restart docker-ops or re-run activation).",
        err,
      );
    }
    throw err;
  }
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
    job_version: 1,
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
  if (!isAutofixKindEnabled(kind)) {
    throw new QueueError(
      "autofix_disabled",
      `Autofix ${kind} is not enabled on this host (neo.services.ops.autofix.enable + autofix.${kind}.enable); no worker would pick up the job.`,
    );
  }
  const pending = findPendingJobs(kind, incident.id);
  if (pending.length) {
    throw new QueueError(
      "already_queued",
      `A ${kind} job for incident #${incident.id} is already queued or running (${path.basename(pending[0])}).`,
    );
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

/** Scratch job name of a saved fix: fix-<incident id>-<suffix>. */
export const PUSH_JOB_RE = /^fix-(\d+)-[A-Za-z0-9-]+$/;

/**
 * Retry pushing a saved fix (push-pending state in the worker scratch dir)
 * without a new Hermes run. Payload carries only the incident id + job name.
 */
export function enqueuePushJob(incident, jobName) {
  const m = PUSH_JOB_RE.exec(String(jobName || ""));
  if (!m || Number(m[1]) !== Number(incident.id)) {
    throw new QueueError("invalid_push_job", `No saved fix job found for incident #${incident.id}.`);
  }
  if (!isAutofixKindEnabled("push")) {
    throw new QueueError(
      "autofix_disabled",
      "Autofix fix is not enabled on this host (neo.services.ops.autofix.enable + autofix.fix.enable); no worker would push the saved fix.",
    );
  }
  const pending = findPendingJobs("push", incident.id);
  if (pending.length) {
    throw new QueueError(
      "already_queued",
      `A push job for incident #${incident.id} is already queued or running (${path.basename(pending[0])}).`,
    );
  }
  const job = {
    job_version: 1,
    kind: "push",
    incident_id: incident.id,
    job: jobName,
    enqueued_at: new Date().toISOString(),
  };
  const dir = queueDir("push");
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${incident.id}-${ts}.json`);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  fs.renameSync(tmp, dest);
  return { path: dest, job };
}

/** Jobs for one incident still waiting in queue/<kind> or being processed. */
export function findPendingJobs(kind, incidentId) {
  const prefix = `${incidentId}-`;
  const out = [];
  const dirs = [
    [queueDir(kind), prefix],
    [path.join(getDataDir(), "queue", "processing"), `${kind}-${prefix}`],
  ];
  for (const [dir, pre] of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (f.startsWith(pre) && f.endsWith(".json")) out.push(path.join(dir, f));
    }
  }
  return out;
}

export function listQueuedJobs(kind) {
  const dir = queueDir(kind);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))
    .map((f) => path.join(dir, f))
    .sort();
}
