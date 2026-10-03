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
import { normalizeProtected } from "./lab-checks.js";
import { resolveTargetRepo, isRepoAllowed } from "./github.js";

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
  const on = (k) => TRUE.includes(String(process.env[k] || "").toLowerCase());
  if (kind === "lab") return on("OPS_AUTOFIX_FIX") && on("OPS_AUTOFIX_LAB");
  // pr (open the upstream PR / post a revise reply) rides on fix + autofix.pr.enable,
  // and is off while the worker found the token unable to open upstream PRs
  // (fine-grained token: compare-link fallback, not a half-working loop).
  if (kind === "pr") return on("OPS_AUTOFIX_FIX") && on("OPS_AUTOFIX_PR") && getPrTokenState().pr_ok !== false;
  return on(kind === "triage" ? "OPS_AUTOFIX_TRIAGE" : "OPS_AUTOFIX_FIX");
}

/**
 * PR capability of the token as last checked by the host worker
 * (worker-status.json `pr_token`, from `heimcloud-autofix-pr --check`).
 * pr_ok false only on a real verdict (fine-grained token, no public_repo, wrong
 * account); a network error during the check leaves it unknown (null).
 * @returns {{ known: boolean, pr_ok: boolean|null, token_kind?: string, reason?: string, checked_at?: string }}
 */
export function getPrTokenState() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(getDataDir(), "queue", "worker-status.json"), "utf8"));
    const t = st.pr_token;
    if (t && typeof t === "object" && typeof t.pr_ok === "boolean") {
      return {
        known: true,
        pr_ok: t.check_error && !t.pr_ok ? null : t.pr_ok,
        token_kind: typeof t.token_kind === "string" ? t.token_kind.slice(0, 20) : undefined,
        reason: typeof t.reason === "string" ? t.reason.slice(0, 300) : undefined,
        checked_at: t.checked_at,
      };
    }
  } catch {
    /* unknown */
  }
  return { known: false, pr_ok: null };
}

/** Board status line for the PR loop: on / off (setting) / disabled (token). */
export function prLoopState() {
  const on = (k) => TRUE.includes(String(process.env[k] || "").toLowerCase());
  if (!(on("OPS_AUTOFIX_FIX") && on("OPS_AUTOFIX_PR"))) return { on: false, label: "PR loop off" };
  const t = getPrTokenState();
  if (t.pr_ok === false) {
    return {
      on: false,
      token: true,
      label:
        t.token_kind === "fine-grained"
          ? "PR loop disabled: token kind fine-grained, cannot open upstream PRs (needs a classic PAT with public_repo); compare links"
          : `PR loop disabled: the token cannot open upstream PRs${t.reason ? ` (${t.reason})` : ""}; compare links`,
    };
  }
  return { on: true, label: `PR loop on${t.token_kind ? ` (token ${t.token_kind})` : ""}` };
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

/** The incident fields every job carries, redacted like buildJobPayload. */
export function redactedIncidentFields(incident) {
  const p = buildJobPayload("pr", incident);
  return { report_hash: p.report_hash, unit: p.unit, severity: p.severity, class: p.class, neo_version: p.neo_version, logs_excerpt: p.logs_excerpt };
}

/**
 * Build a redacted job payload for the worker.
 * @param {'triage'|'fix'} kind
 * @param {object} incident
 */
export function buildJobPayload(kind, incident, extra = {}) {
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
    // Allowlisted target (fix jobs): the worker clones / pushes / tests it.
    ...(kind === "fix" ? { target_repo: resolveTargetRepo(incident) } : {}),
    ...(extra.validation ? { validation: true } : {}),
    enqueued_at: new Date().toISOString(),
  };
}

/**
 * Atomic enqueue: write tmp then rename into queue/<kind>/.
 * @returns {{ path: string, job: object }}
 */
export function enqueueJob(kind, incident, extra = {}) {
  if (kind !== "triage" && kind !== "fix") {
    throw new Error("invalid_job_kind");
  }
  if (!isAutofixKindEnabled(kind)) {
    throw new QueueError(
      "autofix_disabled",
      `Autofix ${kind} is not enabled on this host (neo.services.ops.autofix.enable + autofix.${kind}.enable); no worker would pick up the job.`,
    );
  }
  // A fix never runs next to a lab test of the same incident.
  const pending = [...findPendingJobs(kind, incident.id), ...(kind === "fix" ? findPendingJobs("lab", incident.id) : [])];
  if (pending.length) {
    throw new QueueError(
      "already_queued",
      `A ${kind} job for incident #${incident.id} is already queued or running (${path.basename(pending[0])}).`,
    );
  }
  if (kind === "fix" && incident.target_repo && !isRepoAllowed(incident.target_repo)) {
    throw new QueueError(
      "unknown_target",
      `Target repo ${String(incident.target_repo).slice(0, 120)} is not allowlisted (services.ops.targets); set an allowlisted target on the incident first.`,
    );
  }
  const job = buildJobPayload(kind, incident, extra);
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

const LAB_BRANCH = /^(fix|ops)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * Re-enqueue a lab test from a previous lab job's payload (failed/ bucket).
 * Only whitelisted fields are copied; the plan is re-derived by the worker.
 */
export function enqueueLabRetry(incident, prev) {
  if (!isAutofixKindEnabled("lab")) {
    throw new QueueError("autofix_disabled", "Automated lab testing is not enabled on this host (autofix.lab.enable).");
  }
  if (!prev || Number(prev.incident_id) !== Number(incident.id)) throw new QueueError("invalid_lab_job", "The lab job does not belong to this incident.");
  const branch = String(prev.branch || "");
  if (!LAB_BRANCH.test(branch) || branch.includes("..")) throw new QueueError("invalid_lab_job", "The lab job has no valid fix branch.");
  const pending = [...findPendingJobs("lab", incident.id), ...findPendingJobs("fix", incident.id)];
  if (pending.length) throw new QueueError("already_queued", `A job for incident #${incident.id} is already queued or running (${path.basename(pending[0])}).`);
  const pick = (k, re) => (typeof prev[k] === "string" && re.test(prev[k]) ? prev[k] : undefined);
  const job = {
    job_version: 1,
    kind: "lab",
    incident_id: incident.id,
    ...redactedIncidentFields(incident),
    branch,
    fix_job: pick("fix_job", /^fix-\d+-[A-Za-z0-9-]+$/),
    attempt: Math.max(1, Math.floor(Number(prev.attempt) || 1)),
    max_attempts: Number(prev.max_attempts) || undefined,
    compare_url: pick("compare_url", /^https:\/\/github\.com\/[^\s]+$/),
    pr_title: typeof prev.pr_title === "string" ? prev.pr_title.slice(0, 300) : undefined,
    pr_body: typeof prev.pr_body === "string" ? prev.pr_body.slice(0, 20000) : undefined,
    base_sha: pick("base_sha", /^[0-9a-f]{7,64}$/),
    head_sha: pick("head_sha", /^[0-9a-f]{7,64}$/),
    target_repo: isRepoAllowed(prev.target_repo) ? prev.target_repo : prev.target_repo ? "(not allowlisted)" : undefined,
    pr_number: Number.isInteger(prev.pr_number) && Number.isInteger(prev.revise_round) ? prev.pr_number : undefined,
    revise_round: Number.isInteger(prev.pr_number) && Number.isInteger(prev.revise_round) ? prev.revise_round : undefined,
    // A protected job keeps its flag but never its approval: the worker turns
    // it back into "approve lab test" (fresh admin approval, fresh signature).
    protected: prev.protected || prev.approval ? normalizeProtected(prev.protected) || { areas: ["unverified"], paths: [], core: false, label: "unverified" } : undefined,
    enqueued_at: new Date().toISOString(),
    enqueued_by: "admin",
  };
  const dir = queueDir("lab");
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${incident.id}-${ts}.json`);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  fs.renameSync(tmp, dest);
  return { path: dest, job };
}

/** Failed lab job (queue/failed/<lab_job>.json) named by the latest lab fix_result, if retryable. */
export function labRetrySource(incident, latestFixEvent, latestCancelEvent = null) {
  if (!incident) return null;
  // A lab job cancelled while still pending (admin queue) never produced a
  // result: it sits in failed/lab-<name>.json.
  const c = latestCancelEvent?.meta;
  if (c && c.job_kind === "lab" && (!latestFixEvent || latestCancelEvent.id > latestFixEvent.id)) {
    const jf = String(c.job_file || "");
    if (!/^\d+-[A-Za-z0-9-]+\.json$/.test(jf) || Number(jf.split("-")[0]) !== Number(incident.id)) return null;
    try {
      return { name: `lab-${jf}`, job: JSON.parse(fs.readFileSync(path.join(getDataDir(), "queue", "failed", `lab-${jf}`), "utf8")) };
    } catch {
      return null;
    }
  }
  const m = latestFixEvent?.meta;
  if (!m || m.via !== "lab") return null;
  if (!(m.status === "lab_error" || (m.status === "awaiting_lab_test" && m.lab === "cancelled"))) return null;
  const name = String(m.lab_job || "");
  if (!/^lab-\d+-[A-Za-z0-9-]+$/.test(name) || Number(name.split("-")[1]) !== Number(incident.id)) return null;
  const file = path.join(getDataDir(), "queue", "failed", `${name}.json`);
  try {
    return { name: `${name}.json`, job: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return null;
  }
}

/**
 * "Open PR" (admin) after a lab pass that ended with the compare link only
 * (token added later, PR automation switched on, API error): a kind "pr" job
 * from the DB's latest lab-passed fix_result, never from the form.
 */
export function enqueueOpenPrJob(incident, fixMeta, { skipped = null } = {}) {
  if (!isAutofixKindEnabled("pr")) {
    throw new QueueError("autofix_disabled", "PR automation is not enabled on this host (autofix.pr.enable), or the token cannot open upstream PRs.");
  }
  const branch = String(fixMeta?.branch || "");
  // Lab passed, or the admin skipped the lab test (retry of a draft "NOT lab-tested" PR).
  const untested = Boolean(skipped && skipped.branch === branch);
  if (!fixMeta || (fixMeta.lab !== "passed" && !untested) || !LAB_BRANCH.test(branch) || branch.includes("..")) {
    throw new QueueError("no_tested_branch", `Incident #${incident.id} has no lab-passed (or lab-skipped) fix branch to open a PR from.`);
  }
  if (findPendingJobs("pr", incident.id).length) throw new QueueError("already_queued", `A PR job for incident #${incident.id} is already queued.`);
  const target = fixMeta.target_repo || resolveTargetRepo(incident);
  if (!isRepoAllowed(target)) throw new QueueError("unknown_target", `Target repo ${String(target).slice(0, 120)} is not allowlisted.`);
  const job = {
    job_version: 1,
    kind: "pr",
    mode: untested ? "untested" : "open",
    protected: untested && skipped.protected ? normalizeProtected(skipped.protected) || undefined : undefined,
    incident_id: incident.id,
    ...redactedIncidentFields(incident),
    target_repo: target,
    branch,
    head_sha: /^[0-9a-f]{40}$/.test(String(fixMeta.head_sha || "")) ? fixMeta.head_sha : undefined,
    pr_title: typeof fixMeta.pr_title === "string" ? fixMeta.pr_title.slice(0, 300) : incident.prepared_pr_title || undefined,
    pr_body: typeof fixMeta.pr_body === "string" ? fixMeta.pr_body.slice(0, 20000) : incident.prepared_pr_body || undefined,
    lab_report: fixMeta.lab_report && typeof fixMeta.lab_report === "object" ? fixMeta.lab_report : undefined,
    enqueued_at: new Date().toISOString(),
    enqueued_by: "admin",
  };
  const dir = queueDir("pr");
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${incident.id}-${ts}.json`);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  fs.renameSync(tmp, dest);
  return { path: dest, job };
}

/**
 * Admin "Adopt PR": a kind "pr" job (mode adopt) for an existing open PR on
 * the incident's target upstream. The worker verifies it is a PR from the
 * heimcloud fork (fix/* | ops/*) before tracking it.
 */
export function enqueueAdoptPrJob(incident, prNumber) {
  if (!isAutofixKindEnabled("pr")) {
    throw new QueueError("autofix_disabled", "PR automation is not enabled on this host (autofix.pr.enable), or the token cannot open upstream PRs.");
  }
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n < 1 || n > 1e9) throw new QueueError("bad_pr_number", "Give the number of the open PR to adopt.");
  if (findPendingJobs("pr", incident.id).length) throw new QueueError("already_queued", `A PR job for incident #${incident.id} is already queued.`);
  const target = resolveTargetRepo(incident);
  if (!isRepoAllowed(target)) throw new QueueError("unknown_target", `Target repo ${String(target).slice(0, 120)} is not allowlisted.`);
  const job = {
    job_version: 1,
    kind: "pr",
    mode: "adopt",
    pr_number: n,
    incident_id: incident.id,
    ...redactedIncidentFields(incident),
    target_repo: target,
    enqueued_at: new Date().toISOString(),
    enqueued_by: "admin",
  };
  const dir = queueDir("pr");
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${incident.id}-${ts}.json`);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  fs.renameSync(tmp, dest);
  return { path: dest, job };
}
