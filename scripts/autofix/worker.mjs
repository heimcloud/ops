#!/usr/bin/env node
/**
 * heimcloud-ops-worker — drain the shared autofix queue (concurrency 1).
 * Runs as user hermes from heimcloud-ops-worker.service (triggered by the
 * .path unit). Default OFF; only installed when neo.services.ops.autofix is on.
 *
 * Job lifecycle (all under $OPS_DATA_DIR, dirs are core-uid:core-gid 2770):
 *   queue/<kind>/<id>-<ts>.json        written atomically by the ops container
 *   queue/processing/<kind>-<file>     claimed (atomic rename) by this worker
 *   queue/done/… | queue/failed/…      after handling (never left in queue/<kind>)
 *   results/<kind>-<file>              result the container ingests into the DB
 *
 * Final flow this phase: Hermes codes + commits locally, the worker runs the
 * fail-closed redaction/deny gates, pushes the branch to the heimcloud/neo fork
 * with heimcloud-autofix-env, and posts a compare link. No PR is opened.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  redactIdentifyingDetails,
  findIdentifierHits,
  getExtraRedactSlugs,
  mergeKnownSlugs,
} from "./redact.js";
import { buildCompareUrl } from "./compare.js";
import {
  listPending,
  readPause,
  cancelFile,
  cancelRequested,
  reasonFile,
  atomicWriteJson,
  controlDir,
} from "./queue-control.js";
import {
  validateCheckPlan,
  defaultChecks,
  isValidBranch,
  isValidInstance,
  keepUnitNames,
  normalizeLabReport,
  checkLabel,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_BASE_PATHS,
  normalizePathPrefixes,
  protectedPrefixesHit,
  describeProtected,
  normalizeProtected,
} from "./lab-checks.js";
import { guardedPush } from "./push-guard.mjs";
import { loadTargets, findTarget, compareOpts, targetHints, routeTarget } from "./targets.js";
import {
  wrapperEnv as prWrapperEnv,
  prConfig,
  prTokenPresent,
  buildPrText,
  buildReplyText,
  outboundHits,
  openOrAdoptPr,
  postComment,
  readRecord,
  writeRecord,
  newRecord,
  withPrLock,
  pollPrs,
  feedbackBlock,
  prStateResult,
} from "./pr.mjs";

const WORKER_FILE = fileURLToPath(import.meta.url);
/** A job whose run died this many times (claims without a finish) is quarantined. */
export const POISON_CLAIMS = 2;

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];
const KINDS = ["triage", "fix", "push", "lab", "pr"];
const JOB_NAME_RE = /^fix-(\d+)-[A-Za-z0-9-]+$/;
const BRANCH_RE = /^(fix|ops)\/[A-Za-z0-9._/-]+$/;
const CLASSES = ["software", "human_config", "unknown"];

export const GIT_IDENTITY = {
  name: "heimcloud",
  email: "heimcloud@users.noreply.github.com",
};

/** Read env lazily so tests can reconfigure between calls. */
export function config() {
  const e = process.env;
  const dataDir = e.OPS_DATA_DIR || "/var/neo/DATA/AppData/ops";
  return {
    dataDir,
    queue: path.join(dataDir, "queue"),
    results: path.join(dataDir, "results"),
    lock: e.OPS_AUTOFIX_LOCK || "/run/heimcloud-ops-worker/lock",
    maxAttempts: Math.max(1, Number(e.OPS_AUTOFIX_MAX_ATTEMPTS || 2)),
    maxJobs: Math.max(1, Number(e.OPS_AUTOFIX_MAX_JOBS || 10)),
    // Protected paths (formerly "deny list"): fixes touching them are written
    // and pushed, but the automated lab test waits for an admin approval.
    deny: normalizePathPrefixes(String(e.OPS_AUTOFIX_DENY_PATHS || DEFAULT_PROTECTED_PATHS.join(",")).split(",")),
    basePaths: normalizePathPrefixes(String(e.OPS_AUTOFIX_BASE_PATHS || DEFAULT_BASE_PATHS.join(",")).split(",")),
    labSharesOps: !FALSE.includes(
      String(e.OPS_AUTOFIX_LAB_SHARES_OPS_HOST || "true").toLowerCase(),
    ),
    triageOn: TRUE.includes(String(e.OPS_AUTOFIX_TRIAGE || "").toLowerCase()),
    fixOn: TRUE.includes(String(e.OPS_AUTOFIX_FIX || "").toLowerCase()),
    hermesBin: e.HERMES_BIN || "hermes",
    envBin: e.OPS_AUTOFIX_ENV_BIN || "heimcloud-autofix-env",
    labBin: e.OPS_AUTOFIX_LAB_TEST_BIN || "heimcloud-lab-test",
    hermesTimeoutMs: Math.max(1, Number(e.OPS_AUTOFIX_HERMES_TIMEOUT_SEC || 2700)) * 1000,
    // Heartbeat into worker-status.json while a long child (Hermes, clone, lab) runs.
    heartbeatMs: Math.max(200, Number(e.OPS_AUTOFIX_HEARTBEAT_SEC || 30) * 1000),
    // SIGTERM -> SIGKILL grace for a timed-out / cancelled process group.
    killGraceMs: Math.max(100, Number(e.OPS_AUTOFIX_KILL_GRACE_SEC || 10) * 1000),
    cancelPollMs: Math.max(50, Number(e.OPS_AUTOFIX_CANCEL_POLL_MS || 2000)),
    labTimeoutMs: Math.max(60, Number(e.OPS_AUTOFIX_LAB_TIMEOUT_SEC || 1800)) * 1000,
    // Automated lab stage (lab job kind + root heimcloud-ops-labtest@ unit).
    labAuto: TRUE.includes(String(e.OPS_AUTOFIX_LAB || "").toLowerCase()),
    labUnitPrefix: /^[a-z0-9-]+$/.test(e.OPS_AUTOFIX_LAB_UNIT || "") ? e.OPS_AUTOFIX_LAB_UNIT : "heimcloud-ops-labtest",
    labStateDir: e.OPS_AUTOFIX_LAB_STATE_DIR || "/var/lib/heimcloud-ops-labtest",
    labWaitMs: Math.max(1, Number(e.OPS_AUTOFIX_LAB_WAIT_SEC || 7200)) * 1000,
    labPlanTimeoutMs: Math.max(1, Number(e.OPS_AUTOFIX_LAB_PLAN_TIMEOUT_SEC || 600)) * 1000,
    labPollMs: Math.max(10, Number(e.OPS_AUTOFIX_LAB_POLL_MS || 3000)),
    systemctlBin: e.OPS_SYSTEMCTL_BIN || "systemctl",
    scratchRoot: e.OPS_AUTOFIX_SCRATCH || path.join(os.homedir(), "workspace", "autofix"),
    forkUrl: e.OPS_AUTOFIX_FORK_URL || "https://github.com/heimcloud/neo.git",
    upstreamUrl: e.OPS_AUTOFIX_UPSTREAM_URL || "https://github.com/madebydamo/neo.git",
    baseRef: readNeoBaseRef(),
    dbPath: e.OPS_DB_PATH || path.join(dataDir, "ops.sqlite"),
    // Allowlisted upstream targets (OPS_TARGETS; built-in neo entry without it).
    targets: loadTargets(e),
    // Tests only: clone/push URLs <base>/<owner>/<repo>.git instead of github.com.
    githubBase: e.OPS_AUTOFIX_GITHUB_BASE || "",
    denyFromEnv: Boolean(e.OPS_AUTOFIX_DENY_PATHS),
    ...prConfig(e),
  };
}

/**
 * Config for one allowlisted target: clone/push URLs, base ref, protected
 * paths, compare-link parts. The neo entry keeps the legacy env overrides
 * (OPS_AUTOFIX_UPSTREAM_URL / _FORK_URL / _DENY_PATHS).
 */
export function targetCfg(cfg, target) {
  const isNeo = target.upstream.toLowerCase() === "madebydamo/neo";
  const url = (slug) => (cfg.githubBase ? `${cfg.githubBase.replace(/\/+$/, "")}/${slug}.git` : `https://github.com/${slug}.git`);
  const e = process.env;
  return {
    ...cfg,
    target,
    upstreamUrl: isNeo && e.OPS_AUTOFIX_UPSTREAM_URL ? e.OPS_AUTOFIX_UPSTREAM_URL : url(target.upstream),
    forkUrl: isNeo && e.OPS_AUTOFIX_FORK_URL ? e.OPS_AUTOFIX_FORK_URL : url(target.fork),
    baseRef: target.baseRef,
    deny: isNeo && cfg.denyFromEnv ? cfg.deny : normalizePathPrefixes(target.protectedPaths),
    basePaths: isNeo ? cfg.basePaths : [],
    compare: compareOpts(target),
  };
}

/** Target of a job: its target_repo (must be allowlisted), else the first entry. */
export function jobTarget(cfg, job) {
  if (job && job.target_repo != null && job.target_repo !== "") return findTarget(cfg.targets, job.target_repo);
  return cfg.targets[0];
}

function log(...a) {
  console.log("heimcloud-ops-worker:", ...a);
}

export function readNeoBaseRef() {
  const v = String(process.env.OPS_NEO_BASE_REF || "").trim();
  if (v && /^[A-Za-z0-9._/-]+$/.test(v) && !v.includes("..")) return v;
  return "master";
}

// ---------------------------------------------------------------- lock

export function tryLock(lockPath, info = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      return fd;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Stale lock (SIGKILL / timeout)? Reclaim when the holder is gone.
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      } catch {
        /* ignore */
      }
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code === "EPERM";
        }
      }
      if (alive) return null;
      info.reclaimed = pid || true;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function unlock(fd, lockPath) {
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- queue

function mkdirs(cfg) {
  for (const d of [
    ...KINDS.map((k) => path.join(cfg.queue, k)),
    path.join(cfg.queue, "processing"),
    path.join(cfg.queue, "done"),
    path.join(cfg.queue, "failed"),
    controlDir(cfg.queue),
    cfg.results,
  ]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (err) {
      // ExecStartPre (root) owns dir creation; report instead of dying silently.
      console.error(`heimcloud-ops-worker: cannot create ${d}: ${err.code || err.message}`);
    }
  }
}

export function enabledKinds(cfg) {
  // push (retry a saved fix) rides on autofix.fix.enable; lab needs fix + lab automation.
  return KINDS.filter((k) => (k === "triage" ? cfg.triageOn : k === "lab" ? cfg.fixOn && cfg.labAuto : k === "pr" ? cfg.fixOn && cfg.prOn : cfg.fixOn));
}

/**
 * Pending jobs of enabled kinds in claim order: priority (control/priority.json,
 * written by the admin), then manual rank, then kind (push > triage > fix),
 * then enqueue time. Re-read before every claim.
 */
export function listJobs(cfg) {
  return listPending(cfg.queue, enabledKinds(cfg));
}

/** Atomic claim: rename into queue/processing. Returns processing path or null. */
export function claimJob(cfg, job) {
  const dest = path.join(cfg.queue, "processing", `${job.kind}-${job.name}`);
  try {
    fs.renameSync(job.file, dest);
    return dest;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function finish(cfg, processingFile, bucket, reason = null) {
  const name = path.basename(processingFile);
  const dir = path.join(cfg.queue, bucket);
  const dest = path.join(dir, name);
  try {
    fs.renameSync(processingFile, dest);
  } catch {
    try {
      fs.unlinkSync(processingFile);
    } catch {
      /* ignore */
    }
  }
  if (reason) {
    // Best effort (the disk may be full): the admin queue view shows it.
    try {
      atomicWriteJson(reasonFile(dir, name), { ...reason, at: new Date().toISOString() });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(cancelFile(cfg.queue, name), { force: true });
  } catch {
    /* ignore */
  }
}

export function writeResult(cfg, processingFile, result) {
  fs.mkdirSync(cfg.results, { recursive: true });
  const dest = path.join(cfg.results, path.basename(processingFile));
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...result, finished_at: new Date().toISOString() }, null, 2), {
      mode: 0o660,
    });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
  return dest;
}

/** Result/bucket bookkeeping that must never throw out of the job loop. */
function safeWriteResult(cfg, processingFile, result) {
  if (!result?.incident_id) return { ok: true };
  try {
    writeResult(cfg, processingFile, result);
    return { ok: true };
  } catch (err) {
    const code = err.code || "error";
    log(`cannot write result for ${path.basename(processingFile)}: ${code}`);
    addIssue(cfg, "results_unwritable", `Result for incident #${result.incident_id} could not be written (${code}); job moved to failed.`, {
      incident_id: result.incident_id,
      job: path.basename(processingFile),
    });
    return { ok: false, code };
  }
}

function failureStatus(kind) {
  return kind === "triage" ? "triage_failed" : kind === "push" ? "push_failed" : kind === "lab" ? "lab_error" : "needs_human";
}

function failureResult(kind, incidentId, summary, extra = {}) {
  if (kind === "pr") return { kind: "pr", via: "pr", pr_event: "error", incident_id: incidentId, summary, ...extra };
  return {
    kind: kind === "push" || kind === "lab" ? "fix" : kind,
    incident_id: incidentId,
    status: failureStatus(kind),
    ...(kind === "push" ? { via: "push-pending" } : kind === "lab" ? { via: "lab", lab: "error" } : {}),
    summary,
    ...extra,
  };
}

/**
 * Jobs left in processing/ by a run that died (lock is ours now, so anything
 * here is stale). Claims are counted in the job file: the first crash puts the
 * job back into its queue, the POISON_CLAIMS-th quarantines it in failed/
 * ("crashed worker") so one bad job cannot crash-loop the worker.
 */
export function recoverStale(cfg) {
  const dir = path.join(cfg.queue, "processing");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { requeued: 0, quarantined: 0, failed: 0 };
  }
  const out = { requeued: 0, quarantined: 0, failed: 0 };
  for (const f of names) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const full = path.join(dir, f);
    try {
      const m = /^(triage|fix|push|lab)-((\d+)-[A-Za-z0-9-]+\.json)$/.exec(f);
      let job = null;
      try {
        job = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        job = null;
      }
      const incidentId = Number(job?.incident_id || m?.[3] || 0);
      if (!m || !job || typeof job !== "object") {
        if (m) safeWriteResult(cfg, full, failureResult(m[1], incidentId, "Worker was interrupted on a malformed job file; re-enqueue from the admin UI."));
        finish(cfg, full, "failed", { code: "malformed_job", reason: "malformed job JSON (interrupted)" });
        addIssue(cfg, "malformed_job", `Malformed job ${f} moved to failed.`, { job: f });
        out.failed += 1;
        continue;
      }
      const kind = m[1];
      const claims = Math.max(1, Number(job._claims) || 1);
      if (cancelRequested(cfg.queue, f)) {
        safeWriteResult(cfg, full, cancelledResult(kind, job, "interrupted"));
        finish(cfg, full, "failed", { code: "cancelled", reason: "cancelled by admin (worker was interrupted)" });
        out.failed += 1;
        continue;
      }
      if (claims < POISON_CLAIMS) {
        fs.renameSync(full, path.join(cfg.queue, kind, m[2]));
        log(`requeued interrupted ${kind} job ${m[2]} (claim ${claims}/${POISON_CLAIMS})`);
        addIssue(cfg, "requeued_after_crash", `Interrupted ${kind} job for incident #${incidentId} was requeued once (claim ${claims}/${POISON_CLAIMS}).`, {
          incident_id: incidentId,
          job: f,
        });
        out.requeued += 1;
        continue;
      }
      safeWriteResult(
        cfg,
        full,
        failureResult(
          kind,
          incidentId,
          `Quarantined: the worker crashed or was killed ${claims} times while processing this job (crashed worker). Re-enqueue from the admin UI once the cause is fixed.`,
          kind === "push" ? { push_error: "interrupted", job: job.job } : {},
        ),
      );
      finish(cfg, full, "failed", { code: "crashed_worker", reason: `crashed worker (${claims} claims)`, claims });
      log(`quarantined poison ${kind} job ${m[2]} after ${claims} claims`);
      addIssue(cfg, "poison_quarantined", `Poison ${kind} job for incident #${incidentId} quarantined after ${claims} crashed runs.`, {
        incident_id: incidentId,
        job: f,
      });
      out.quarantined += 1;
    } catch (err) {
      log(`cannot recover ${f}: ${err.code || err.message}`);
      addIssue(cfg, "queue_unwritable", `Stale job ${f} could not be recovered (${err.code || err.message}).`, { job: f });
    }
  }
  return out;
}

// ---------------------------------------------------------------- status

/**
 * queue/worker-status.json: the only channel from the host worker to the admin
 * UI (the app runs in a container and shares just the exchange dirs). Written
 * atomically at every stage transition and every heartbeatMs while a child
 * runs. Keeps the v1 token fields (fork_push_token, reason, checked_at).
 * Never contains the token, identifiers or raw log output.
 */
export function statusPath(cfg) {
  return path.join(cfg.queue, "worker-status.json");
}

export function readStatus(cfg) {
  try {
    const st = JSON.parse(fs.readFileSync(statusPath(cfg), "utf8"));
    return st && typeof st === "object" ? st : {};
  } catch {
    return {};
  }
}

let statusWarned = false;
export function updateStatus(cfg, patch, { heartbeat = true } = {}) {
  const now = new Date().toISOString();
  const next = { ...readStatus(cfg), ...patch, version: 2, updated_at: now };
  if (heartbeat) next.heartbeat_at = now;
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  try {
    atomicWriteJson(statusPath(cfg), next);
    statusWarned = false;
  } catch (err) {
    if (!statusWarned) console.error(`heimcloud-ops-worker: cannot write ${statusPath(cfg)}: ${err.code || err.message}`);
    statusWarned = true;
  }
  return next;
}

const MAX_ISSUES = 20;
/** Lockout / recovery notes shown in the admin worker panel (newest first). */
export function addIssue(cfg, code, message, extra = {}) {
  const st = readStatus(cfg);
  const issues = Array.isArray(st.issues) ? st.issues : [];
  const entry = { code, message: redactIdentifyingDetails(message, { knownSlugs: [] }), at: new Date().toISOString(), ...extra };
  updateStatus(cfg, { issues: [entry, ...issues].slice(0, MAX_ISSUES) }, { heartbeat: false });
}

/** Stage transition of the running job (+ cancel checkpoint unless disabled). */
let currentJob = null;
export function stage(cfg, name, extra = {}, { checkCancel = true } = {}) {
  if (!currentJob) return;
  currentJob = { ...currentJob, stage: name, stage_at: new Date().toISOString(), ...extra };
  updateStatus(cfg, { state: "running", pid: process.pid, job: currentJob });
  if (checkCancel && cancelRequested(cfg.queue, currentJob.processing)) throw new JobCancelled(name);
}

export class JobCancelled extends Error {
  constructor(stageName) {
    super(`cancelled by admin during ${stageName}`);
    this.stage = stageName;
  }
}

/** Result for a job cancelled from the admin: leaves the incident in a sane status. */
export function cancelledResult(kind, job, stageName) {
  const incidentId = Number(job?.incident_id || 0);
  const at = stageName ? ` during ${stageName}` : "";
  if (kind === "triage") {
    return { kind: "triage", incident_id: incidentId, status: "triage_cancelled", summary: `Triage cancelled by admin${at}.` };
  }
  if (kind === "push") {
    return {
      kind: "fix",
      via: "push-pending",
      incident_id: incidentId,
      job: job?.job,
      status: "push_failed",
      push_error: "cancelled",
      summary: `Push cancelled by admin${at}; the saved fix is kept (Retry push when ready).`,
    };
  }
  if (kind === "lab") {
    // The branch is pushed; nothing was activated (cancel never interrupts an activation).
    return {
      kind: "fix",
      via: "lab",
      incident_id: incidentId,
      branch: job?.branch,
      compare_url: job?.compare_url,
      status: "awaiting_lab_test",
      lab: "cancelled",
      summary: `Lab test cancelled by admin${at} before activation; the branch stays pushed. Retry the lab job or test manually.`,
    };
  }
  return { kind: "fix", incident_id: incidentId, status: "cancelled", summary: `Fix cancelled by admin${at}; nothing was pushed.` };
}

// ---------------------------------------------------------------- helpers

export function run(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  for (const k of opts.unsetEnv || []) delete env[k];
  if (opts.supervise) return runSupervised(cmd, args, { ...opts, env });
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    cwd: opts.cwd || process.cwd(),
    timeout: opts.timeout || 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error ? r.error.code || r.error.message : null,
  };
}

const SUPERVISE_MARK = "@@heimcloud-ops-supervise ";

/**
 * Long children (Hermes, clone, push, lab) run under a small supervisor process
 * (`worker.mjs --supervise <spec>`), because spawnSync's timeout only kills the
 * direct child: the supervisor starts the command in its OWN process group,
 * writes heartbeats into worker-status.json, polls the admin cancel flag, and on
 * timeout/cancel sends SIGTERM to the whole group, then SIGKILL after a grace.
 * Returns the run() shape; error is "ETIMEDOUT" or "CANCELLED" for those cases.
 */
export function runSupervised(cmd, args, opts = {}) {
  const sup = opts.supervise || {};
  const timeoutMs = opts.timeout || 600_000;
  const spec = {
    cmd,
    args,
    timeoutMs,
    graceMs: sup.graceMs || 10_000,
    pollMs: sup.pollMs || 2000,
    heartbeatMs: sup.heartbeatMs || 30_000,
    statusFile: sup.statusFile || null,
    cancelFile: sup.cancelFile || null,
  };
  const r = spawnSync(process.execPath, [WORKER_FILE, "--supervise", JSON.stringify(spec)], {
    encoding: "utf8",
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    // Last resort only; the supervisor enforces timeoutMs itself.
    timeout: timeoutMs + spec.graceMs + 60_000,
    killSignal: "SIGTERM",
    maxBuffer: 64 * 1024 * 1024,
  });
  let stderr = r.stderr || "";
  let outcome = null;
  const at = stderr.lastIndexOf(SUPERVISE_MARK);
  if (at >= 0) {
    try {
      outcome = JSON.parse(stderr.slice(at + SUPERVISE_MARK.length).split("\n")[0]);
    } catch {
      outcome = null;
    }
    stderr = stderr.slice(0, at);
  }
  let error = r.error ? r.error.code || r.error.message : null;
  if (outcome?.outcome === "timeout") error = "ETIMEDOUT";
  else if (outcome?.outcome === "cancelled") error = "CANCELLED";
  else if (outcome?.outcome === "spawn_error") error = outcome.error || "spawn_error";
  return {
    status: outcome && outcome.outcome === "exit" ? outcome.code : outcome ? null : r.status,
    stdout: r.stdout || "",
    stderr,
    error,
    killed_group: Boolean(outcome?.killed_group),
  };
}

function superviseOpts(cfg, { cancel = true } = {}) {
  return {
    graceMs: cfg.killGraceMs,
    pollMs: cfg.cancelPollMs,
    heartbeatMs: cfg.heartbeatMs,
    statusFile: statusPath(cfg),
    cancelFile: cancel && currentJob ? cancelFile(cfg.queue, currentJob.processing) : null,
  };
}

/** Entry for `--supervise <spec json>` (see runSupervised). */
export function superviseMain(specJson) {
  const spec = JSON.parse(specJson);
  let outcome = null;
  let killedGroup = false;
  let done = false;
  let child;
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
      killedGroup = true;
    } catch {
      /* group already gone */
    }
  };
  const stop = (why) => {
    if (outcome || done) return;
    outcome = why;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), spec.graceMs).unref();
  };
  const end = (res) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    process.stderr.write(`\n${SUPERVISE_MARK}${JSON.stringify({ ...res, killed_group: killedGroup })}\n`, () => {
      process.exit(res.outcome === "exit" && Number.isInteger(res.code) ? res.code : 1);
    });
  };
  let lastBeat = Date.now();
  const beat = () => {
    if (!spec.statusFile || Date.now() - lastBeat < spec.heartbeatMs) return;
    lastBeat = Date.now();
    try {
      const st = JSON.parse(fs.readFileSync(spec.statusFile, "utf8"));
      st.heartbeat_at = new Date().toISOString();
      atomicWriteJson(spec.statusFile, st);
    } catch {
      /* best effort */
    }
  };
  try {
    child = spawn(spec.cmd, spec.args, { stdio: ["ignore", "inherit", "inherit"], detached: true });
  } catch (err) {
    end({ outcome: "spawn_error", error: err.code || err.message });
    return;
  }
  const timer = setTimeout(() => stop("timeout"), spec.timeoutMs);
  const poll = setInterval(() => {
    if (spec.cancelFile && fs.existsSync(spec.cancelFile)) stop("cancelled");
    beat();
  }, spec.pollMs);
  child.on("error", (err) => end({ outcome: "spawn_error", error: err.code || err.message }));
  child.on("exit", (code, signal) => {
    // Leader gone: take down anything it left behind in its group.
    killGroup(outcome ? "SIGKILL" : "SIGTERM");
    end(outcome ? { outcome, code, signal } : { outcome: "exit", code, signal });
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      killGroup("SIGKILL");
      process.exit(143);
    });
  }
}

function gitEnv() {
  return {
    GIT_AUTHOR_NAME: GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(dir, args, opts = {}) {
  return run("git", ["-C", dir, ...args], { ...opts, env: { ...gitEnv(), ...(opts.env || {}) } });
}

/** Last parseable top-level JSON object in free-form Hermes output. */
export function extractJson(text) {
  const t = String(text || "");
  const objs = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) objs.push(t.slice(start, i + 1));
    }
  }
  for (let i = objs.length - 1; i >= 0; i -= 1) {
    try {
      const v = JSON.parse(objs[i]);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* try previous */
    }
  }
  return null;
}

/** DB slugs (best effort, read-only) + OPS_REDACT_EXTRA_SLUGS. */
export function knownSlugs(cfg) {
  const fromDb = [];
  if (fs.existsSync(cfg.dbPath)) {
    const r = run(
      "sqlite3",
      [
        "-readonly",
        "-noheader",
        "-list",
        cfg.dbPath,
        "SELECT DISTINCT customer_repo_slug FROM incidents WHERE customer_repo_slug IS NOT NULL AND trim(customer_repo_slug) != '';",
      ],
      { timeout: 15_000 },
    );
    if (r.status === 0) {
      for (const l of r.stdout.split("\n")) if (l.trim()) fromDb.push(l.trim());
    } else {
      console.error("heimcloud-ops-worker: DB slug read unavailable; using slug-shape + extra slugs only");
    }
  }
  return mergeKnownSlugs(fromDb, ...getExtraRedactSlugs());
}

export function scanOutbound(label, text, slugs) {
  const hits = findIdentifierHits(text, { knownSlugs: slugs });
  if (hits.length) {
    const err = new Error(`redaction_fail_closed:${label}:${hits.join(",")}`);
    err.hits = hits;
    throw err;
  }
}

/** First protected prefix the diff touches (null when the lab does not share the ops host). */
export function denyListHit(files, cfg) {
  return protectedHit(files, cfg)?.paths[0] || null;
}

/**
 * Protected paths touched by the diff while the lab shares the ops host:
 * {areas, paths, core, label, files} or null. Not a refusal any more: the fix
 * is pushed, the lab test waits for an admin approval.
 */
export function protectedHit(files, cfg) {
  if (!cfg.labSharesOps) return null;
  const hit = protectedPrefixesHit(files, cfg.deny);
  if (!hit.length) return null;
  const inHit = (f) => hit.some((d) => f === d || f.startsWith(`${d}/`));
  return { ...describeProtected(hit, cfg.basePaths || DEFAULT_BASE_PATHS), files: files.map((f) => f.replace(/^\.?\/+/, "")).filter(inHit).slice(0, 10) };
}

/**
 * Result for a fix whose lab test needs an admin approval (protected path).
 * No compare link yet (pending_compare_url is only used by the admin "Skip
 * lab" action); everything the app needs to build the approved lab job comes
 * from this result, never from the form. origin says what happened:
 *   "fix"     this run pushed the branch and found protected paths in its diff
 *   "lab_job" a lab job was marked protected without an approval: nothing was
 *             pushed or tested by this run
 *   "runner"  the root lab runner found protected changes (nothing activated)
 */
export const UNVERIFIED_PROTECTED = Object.freeze({ areas: ["unverified"], paths: [], core: false, label: "unverified (claimed by the job)" });

export function approvalNeededResult(common, info, extra = "", origin = "fix") {
  const prot = normalizeProtected(info.protected) || { ...UNVERIFIED_PROTECTED };
  const where = prot.paths.length ? `${prot.paths.join(", ")}${prot.core ? " (base system)" : ""}` : "";
  const why =
    origin === "lab_job"
      ? `Lab job marked protected (${prot.paths.length ? prot.label : "no paths named"}) without an admin approval; nothing was pushed or tested by this run.`
      : origin === "runner"
        ? `The root lab runner found protected changes${where ? ` (${where})` : ""} on branch ${info.branch} and no valid admin approval; nothing was activated.`
        : `Branch ${info.branch} was pushed to the fork; the automated lab test did not run because the change touches ${where || "a protected path"}.`;
  return {
    ...common,
    branch: info.branch,
    job: info.fix_job,
    fix_job: info.fix_job,
    attempt: info.attempt,
    head_sha: info.head_sha,
    base_sha: info.base_sha,
    pr_title: info.pr_title,
    pr_body: info.pr_body,
    target_repo: info.target_repo,
    pr_number: info.pr_number,
    revise_round: info.revise_round,
    change_summary: info.change_summary,
    compare_url: undefined,
    pending_compare_url: info.compare_url,
    protected: prot,
    status: "lab_approval_needed",
    lab: "awaiting_approval",
    summary: `Protected path (${prot.label}): approve lab test. ${why}${extra ? ` ${extra}` : ""}`,
  };
}

function tail(s, n = 800) {
  const t = String(s || "").trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

export function hermesArgs(skill, promptPath) {
  return [
    "--yolo",
    "chat",
    "-Q",
    "--source",
    "tool",
    "--max-turns",
    "40",
    "-s",
    skill,
    "--query-file",
    promptPath,
  ];
}

/**
 * Hermes runs WITHOUT the fork-push credential (the worker pushes). Ambient
 * GitHub tokens are stripped; git identity is pinned so no host name leaks
 * into author/committer fields.
 */
function hermesChat(cfg, skill, promptPath, { cwd, logPath }) {
  const r = run(cfg.hermesBin, hermesArgs(skill, promptPath), {
    cwd,
    timeout: cfg.hermesTimeoutMs,
    supervise: superviseOpts(cfg),
    env: gitEnv(),
    unsetEnv: ["GH_TOKEN", "GITHUB_TOKEN", "GH_PR_TOKEN", "OPS_GITHUB_TOKEN"],
  });
  if (logPath) {
    try {
      fs.writeFileSync(
        logPath,
        `# hermes ${hermesArgs(skill, promptPath).join(" ")}\n# exit=${r.status} error=${r.error || ""}\n\n## stdout\n${r.stdout}\n\n## stderr\n${r.stderr}\n`,
        { mode: 0o640 },
      );
    } catch {
      /* ignore */
    }
  }
  if (r.error === "CANCELLED") throw new JobCancelled(currentJob?.stage || "hermes");
  if (r.error === "ETIMEDOUT") {
    addIssue(cfg, "hermes_killed", `Hermes hit the ${Math.round(cfg.hermesTimeoutMs / 1000)} s timeout; its whole process group was killed.`, {
      incident_id: currentJob?.incident_id,
    });
  }
  return r;
}

function hermesFailure(r) {
  if (r.error === "ENOENT") return "hermes CLI not found on PATH";
  if (r.error === "ETIMEDOUT") return "hermes timed out (process group killed)";
  if (r.error) return `hermes spawn error ${r.error}`;
  return `hermes exit ${r.status}`;
}

// ---------------------------------------------------------------- triage

export function handleTriage(cfg, job, ctx) {
  fs.mkdirSync(ctx.scratch, { recursive: true });
  const prompt = path.join(ctx.scratch, "triage-prompt.txt");
  fs.writeFileSync(
    prompt,
    [
      `Triage Ops incident #${job.incident_id}`,
      `report_hash: ${job.report_hash}`,
      `unit: ${job.unit}`,
      `severity: ${job.severity}`,
      `class: ${job.class}`,
      `neo_version: ${job.neo_version}`,
      "",
      "logs_excerpt (redacted):",
      job.logs_excerpt || "(none)",
      "",
      "Allowlisted target repos (target_repo MUST be one of these; the first is the default):",
      ...targetHints(cfg.targets),
      "",
      "Respond with the JSON verdict only.",
    ].join("\n"),
  );
  const logPath = path.join(ctx.scratch, "triage-hermes.log");
  stage(cfg, "hermes", { attempt: 1, max_attempts: 1 });
  const r = hermesChat(cfg, "heimcloud-ops-triage", prompt, { cwd: ctx.scratch, logPath });
  const verdict = extractJson(r.stdout) || extractJson(r.stderr);
  if (!verdict) {
    return {
      kind: "triage",
      incident_id: job.incident_id,
      status: "triage_failed",
      summary: `Hermes produced no JSON verdict (${hermesFailure(r)}). Log: ${logPath}`,
      hermes_status: r.status,
      hermes_error: r.error,
      evidence_path: logPath,
    };
  }
  const slugs = ctx.slugs;
  // target_repo must be allowlisted; none named → route by the hints; an
  // unknown repo is reported (needs_human), never used.
  const named = typeof verdict.target_repo === "string" ? verdict.target_repo.trim() : "";
  const known = named ? findTarget(cfg.targets, named) : null;
  const routed = known || (named ? null : routeTarget(cfg.targets, { unit: job.unit, logs: job.logs_excerpt }).target);
  return {
    kind: "triage",
    incident_id: job.incident_id,
    status: "triaged",
    class: CLASSES.includes(verdict.class) ? verdict.class : "unknown",
    severity: redactIdentifyingDetails(verdict.severity || "", { knownSlugs: slugs }),
    summary: redactIdentifyingDetails(verdict.summary || "Triage verdict", { knownSlugs: slugs }),
    target_repo: routed ? routed.upstream : undefined,
    ...(named && !known
      ? { target_unknown: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(named) ? redactIdentifyingDetails(named, { knownSlugs: slugs }) : "(invalid)" }
      : {}),
    fixable: Boolean(verdict.fixable),
    ...triageVerdictFields(verdict),
    evidence_path: logPath,
  };
}

const TRIAGE_VERDICTS = ["code_fix", "config_error", "not_actionable", "uncertain"];

/**
 * verdict / confidence from the triage skill output contract (optional: old
 * skill outputs omit them and the admin derives a verdict from class/fixable).
 * confidence is normalized to 0..1 (accepts 0.8, "80%", 80, high|medium|low).
 */
export function triageVerdictFields(v) {
  const out = {};
  if (TRIAGE_VERDICTS.includes(v?.verdict)) out.verdict = v.verdict;
  const words = { high: 0.9, medium: 0.6, low: 0.3 };
  const raw = v?.confidence;
  let c = typeof raw === "string" && Object.hasOwn(words, raw.trim().toLowerCase())
    ? words[raw.trim().toLowerCase()]
    : Number(String(raw ?? "").replace(/%$/, ""));
  if (raw != null && raw !== "" && Number.isFinite(c) && c >= 0) {
    if (c > 1) c /= 100;
    out.confidence = Math.round(Math.min(c, 1) * 100) / 100;
  }
  return out;
}

// ---------------------------------------------------------------- fix

function cloneNeo(cfg, neoDir) {
  // Upstream first: the host pins the upstream ref, and a fork branch of the
  // same name may be stale. Fork second for fork-only base branches.
  const tries = [
    [cfg.upstreamUrl, cfg.baseRef],
    [cfg.forkUrl, cfg.baseRef],
  ];
  const errors = [];
  for (const [url, ref] of tries) {
    fs.rmSync(neoDir, { recursive: true, force: true });
    // Partial clone (full history, lazy blobs): pushing a new branch to the fork
    // from a shallow clone can be rejected; blob:none keeps it fast and valid.
    // Public repos: no credential needed (token is only used at push time).
    const r = run(
      "git",
      ["clone", "--filter=blob:none", "--branch", ref, url, neoDir],
      { env: gitEnv(), timeout: 900_000, unsetEnv: ["GH_TOKEN", "GITHUB_TOKEN"], supervise: superviseOpts(cfg) },
    );
    if (r.error === "CANCELLED") throw new JobCancelled("cloning");
    if (r.status === 0) return { ok: true, url, ref };
    errors.push(`${url}@${ref}: ${tail(r.stderr || r.error, 300)}`);
  }
  return { ok: false, error: errors.join(" | ") };
}

function fixPrompt(job, neoDir, cfg, attempt, previousFailure, continueBranch = "") {
  const repo = cfg.target?.upstream || "madebydamo/neo";
  const revise = job.revise && typeof job.revise_feedback === "string";
  return [
    revise
      ? `Revise the open PR #${Number(job.revise.pr_number)} of Ops incident #${job.incident_id} (${repo}, clone at ${neoDir}; review round ${Number(job.revise.round)}, attempt ${attempt}/${cfg.maxAttempts}).`
      : `Fix Ops incident #${job.incident_id} in the ${repo} clone at ${neoDir} (attempt ${attempt}/${cfg.maxAttempts}).`,
    `Target repo: ${repo}. Base ref the host runs: ${cfg.baseRef} (already checked out; branch from here).`,
    `report_hash: ${job.report_hash}`,
    `unit: ${job.unit}`,
    `severity: ${job.severity}`,
    `class: ${job.class}`,
    `neo_version: ${job.neo_version}`,
    "",
    "logs_excerpt (redacted):",
    job.logs_excerpt || "(none)",
    "",
    ...(previousFailure
      ? ["Previous attempt failed the lab test. Evidence (redacted tail):", previousFailure, ""]
      : []),
    ...(revise ? [job.revise_feedback, ""] : []),
    ...(continueBranch
      ? [
          revise
            ? `Branch ${continueBranch} (the PR head) is checked out: address the feedback with NEW commit(s) on it, keep the branch name, never rewrite or squash existing commits.`
            : `Branch ${continueBranch} (the previous attempt) is checked out: fix forward with a NEW commit on it and keep the branch name.`,
          "",
        ]
      : []),
    `Create branch fix/<topic> or ops/incident-${job.incident_id} and COMMIT the change (git identity is preset; do not change git config).`,
    "Minimal change. No identifiers. Do NOT push and do NOT open a PR; the worker pushes after its redaction gate.",
    'When the commit is ready respond with one JSON object: {"status":"ready_to_push","branch":"fix/…","summary":"…","commit_message":"…"}',
  ].join("\n");
}

function labTest(cfg, branch, klass = "default") {
  const which = run("bash", ["-c", 'command -v -- "$1"', "_", cfg.labBin], { timeout: 10_000 });
  const bin = which.status === 0 ? which.stdout.trim() : "";
  if (!bin) return { skipped: true };
  stage(cfg, "lab", {}, { checkCancel: false });
  const r = run(bin, [branch, klass || "default"], { timeout: cfg.labTimeoutMs, supervise: superviseOpts(cfg) });
  // Already pushed: a cancel here only stops the lab test (the branch stays).
  if (r.error === "CANCELLED") return { skipped: true, cancelled: true };
  return {
    skipped: false,
    ok: r.status === 0,
    output: tail(`${r.stdout}\n${r.stderr}\n${r.error || ""}`, 1500),
    status: r.status,
  };
}

export const PENDING_FILE = "push-pending.json";
export const PATCH_FILE = "fix.patch";

export function tokenAvailable(cfg) {
  const check = run(cfg.envBin, ["--check"], { timeout: 15_000 });
  if (check.status === 0) return { ok: true };
  return {
    ok: false,
    reason:
      check.error === "ENOENT"
        ? `${cfg.envBin} not found on PATH (credentials module not enabled?)`
        : "fork-push token /run/heimcloud-autofix/github-token missing or unreadable by hermes",
  };
}

/**
 * Deny-list + identity + redaction gates on base..HEAD. Returns
 * { ok:true, files } or { ok:false, result } (result fields to merge).
 */
export function gateCommits(cfg, neoDir, baseSha, { branch, prTitle, prBody, slugs }) {
  try {
    buildCompareUrl(branch, cfg.compare || { base: cfg.baseRef }); // validates branch shape
    scanOutbound("branch", branch, slugs);
  } catch (err) {
    return { ok: false, result: { status: "redaction_blocked", summary: `branch rejected: ${err.message}`, hits: err.hits } };
  }
  const count = Number(git(neoDir, ["rev-list", "--count", `${baseSha}..HEAD`]).stdout.trim() || 0);
  if (!count) return { ok: false, result: { status: "needs_human", summary: `no commit on top of ${cfg.baseRef}` } };

  // Author/committer must be the pinned identity (a default hermes@<host> leaks the host name).
  const ids = git(neoDir, ["log", "--format=%an <%ae>%n%cn <%ce>", `${baseSha}..HEAD`]).stdout
    .split("\n")
    .filter(Boolean);
  const want = `${GIT_IDENTITY.name} <${GIT_IDENTITY.email}>`;
  if (ids.some((l) => l !== want)) {
    return { ok: false, result: { status: "redaction_blocked", summary: "commit author/committer differs from the pinned autofix identity" } };
  }
  const files = git(neoDir, ["diff", "--name-only", `${baseSha}..HEAD`]).stdout.split("\n").filter(Boolean);
  // Protected paths no longer block the fix; the lab test needs an approval.
  const prot = protectedHit(files, cfg);
  const diffText = git(neoDir, ["diff", `${baseSha}..HEAD`]).stdout;
  const msgs = git(neoDir, ["log", "--format=%B", `${baseSha}..HEAD`]).stdout;
  try {
    scanOutbound("commit_message", msgs, slugs);
    scanOutbound("diff", diffText, slugs);
    scanOutbound("files", files.join("\n"), slugs);
    scanOutbound("pr_title", prTitle, slugs);
    scanOutbound("pr_body", prBody, slugs);
  } catch (err) {
    return { ok: false, result: { status: "redaction_blocked", summary: err.message, hits: err.hits } };
  }
  return { ok: true, files, commits: count, protected: prot };
}

/** Save everything a later push needs (no second Hermes run). */
export function savePending(cfg, scratch, neoDir, state, slugs) {
  const patch = git(neoDir, ["format-patch", "--stdout", `${state.base_sha}..HEAD`]).stdout;
  // Content is already gated; the pinned identity is the only email allowed.
  scanOutbound("patch", patch.split(GIT_IDENTITY.email).join(""), slugs);
  const patchPath = path.join(scratch, PATCH_FILE);
  fs.writeFileSync(patchPath, patch, { mode: 0o640 });
  const pending = {
    ...state,
    head_sha: git(neoDir, ["rev-parse", "HEAD"]).stdout.trim(),
    neo_dir: neoDir,
    patch_path: patchPath,
    saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(scratch, PENDING_FILE), JSON.stringify(pending, null, 2), { mode: 0o640 });
  return pending;
}

/**
 * One-line, non-sensitive push error class. Raw git output (URLs, helper
 * messages) never leaves the worker log.
 */
export function classifyPushError(text) {
  const t = String(text || "");
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|HTTP (401|403)|Permission to .* denied|invalid credentials|403 Forbidden/i.test(t)) {
    return { class: "auth", message: "fork rejected the credentials or none were offered (check heimcloud-autofix-env / token)" };
  }
  if (/Could not resolve host|timed out|Connection (refused|reset)|Failed to connect|network is unreachable|ETIMEDOUT|unable to access/i.test(t)) {
    return { class: "network", message: "could not reach GitHub" };
  }
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|protected branch|pre-receive hook declined|shallow update not allowed/i.test(t)) {
    return { class: "rejected", message: "fork refused the ref update" };
  }
  return { class: "unknown", message: "git push failed (see worker journal)" };
}

function retryHint(job) {
  return `Retry: admin "Retry push" on the incident, or systemctl start heimcloud-ops-worker-push@${job}.service`;
}

/** Push HEAD to the fork branch, build the compare link, run the lab test. */
function pushAndLab(cfg, neoDir, branch, klass, { skipLab = false, force = true } = {}) {
  // Fork branch namespace fix/*|ops/* is owned by this loop: force keeps
  // re-runs of the same incident idempotent. A PR revision is a plain
  // fast-forward push (the open PR's history is never rewritten).
  // The PR token never reaches git: GH_PR_TOKEN / GH_TOKEN are dropped after
  // heimcloud-autofix-env injected its fork-scoped credential helper.
  // Push guard (push-guard.mjs): allowlisted fork URL only, fix/* | ops/*
  // only, hooks off, no config redirects.
  const push = guardedPush(cfg, neoDir, branch, {
    force,
    deps: { run, git, envBin: cfg.envBin, gitEnv, supervise: superviseOpts(cfg, { cancel: false }) },
  });
  if (!push.pushed) {
    if (push.refused) {
      log(`push refused by the guard: ${push.error}`);
      return { pushed: false, error: { class: "refused", message: `push guard: ${push.error}` } };
    }
    // Journal only, with any URL userinfo stripped; never in results/DB.
    log(`git push failed: ${tail(String(push.error || "").replace(/:\/\/[^@\s/]+@/g, "://***@"), 300)}`);
    return { pushed: false, error: classifyPushError(push.error) };
  }
  const compare_url = buildCompareUrl(branch, cfg.compare || { base: cfg.baseRef });
  return { pushed: true, compare_url, lab: skipLab ? null : labTest(cfg, branch, klass || "default") };
}

export const VALIDATION_FILE = "docs/ops-autofix-validation.md";

/**
 * Validation fix (synthetic incident from the admin "Run PR-loop validation"):
 * one markdown file, no code or config. Returns a Hermes-like run result.
 */
export function validationCommit(neoDir, job, logPath) {
  const id = Number(job.incident_id);
  const branch = `ops/validation-pr-loop-${id}`;
  const text = [
    "# Heimcloud Ops autofix: PR-loop validation",
    "",
    `This file exists only on the validation branch \`${branch}\`.`,
    "It checks that the autofix loop can push a branch to the fork, lab-test it, open a",
    "pull request and address one review comment. It changes no code and no configuration.",
    "",
    "**Do not merge.** Close the pull request when the check is done.",
    "",
  ].join("\n");
  const steps = [
    git(neoDir, ["checkout", "-q", "-B", branch]),
    (fs.mkdirSync(path.join(neoDir, "docs"), { recursive: true }), fs.writeFileSync(path.join(neoDir, VALIDATION_FILE), text), { status: 0 }),
    git(neoDir, ["add", "--", VALIDATION_FILE]),
    git(neoDir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "docs: autofix PR-loop validation (do not merge)"]),
  ];
  const bad = steps.find((x) => x.status !== 0);
  const verdict = {
    status: "ready_to_push",
    branch,
    pr_title: `[validation] Heimcloud Ops autofix PR-loop check (incident #${id}) - DO NOT MERGE`,
    summary:
      "**Validation only, do not merge.** Adds one doc-only file to check the autofix loop end to end (push, lab test, PR, one review round). " +
      "To exercise the feedback loop, leave one review comment asking for a small wording change in that file.",
  };
  try {
    fs.writeFileSync(logPath, `# validation commit (no Hermes)\n${bad ? `failed: ${bad.stderr}` : "ok"}\n`, { mode: 0o640 });
  } catch {
    /* ignore */
  }
  return { status: bad ? 1 : 0, stdout: bad ? "" : JSON.stringify(verdict), stderr: bad ? String(bad.stderr || "") : "", error: null };
}

/** Fields a fix / lab / approval result carries for the PR loop. */
function prFields(cfg, job) {
  const out = { target_repo: cfg.target?.upstream };
  if (job.revise && Number(job.revise.pr_number)) {
    out.pr_number = Number(job.revise.pr_number);
    out.revise_round = Number(job.revise.round) || 1;
  } else if (Number(job.pr_number) && Number(job.revise_round)) {
    out.pr_number = Number(job.pr_number);
    out.revise_round = Number(job.revise_round);
  }
  return out;
}

/** Result for a target without an automated lab method (needs_human). */
function noLabMethodResult(cfg, last, extra = {}) {
  return {
    ...last,
    ...extra,
    compare_url: undefined,
    pending_compare_url: last.compare_url,
    status: "lab_unavailable",
    lab: "no_method",
    summary: `No lab method for ${cfg.target.upstream} (lab = "none"): branch ${last.branch} is pushed. Test it by hand, then use "Skip lab" to open the PR (marked NOT lab-tested).`,
  };
}

export function handleFix(cfg, job, ctx) {
  const pf = prFields(cfg, job);
  const base = { kind: "fix", incident_id: job.incident_id, base_ref: cfg.baseRef, ...pf };
  fs.mkdirSync(ctx.scratch, { recursive: true });
  const neoDir = path.join(ctx.scratch, "neo");
  stage(cfg, "cloning");
  const clone = cloneNeo(cfg, neoDir);
  if (!clone.ok) {
    return { ...base, status: "needs_human", summary: `git clone failed: ${clone.error}` };
  }
  // Push target is always the fork, whichever remote we cloned from.
  git(neoDir, ["remote", "remove", "fork"]);
  git(neoDir, ["remote", "add", "fork", cfg.forkUrl]);
  git(neoDir, ["config", "user.name", GIT_IDENTITY.name]);
  git(neoDir, ["config", "user.email", GIT_IDENTITY.email]);
  git(neoDir, ["config", "commit.gpgsign", "false"]);
  const baseSha = git(neoDir, ["rev-parse", "HEAD"]).stdout.trim();
  const slugs = ctx.slugs;

  // Lab retry (enqueued by a failed lab job): continue on the pushed branch
  // with the redacted lab evidence; the attempt budget carries over.
  const startAttempt = Math.max(1, Math.floor(Number(job.attempt) || 1));
  const revise = Boolean(pf.revise_round);
  let continueBranch = "";
  if ((startAttempt > 1 || revise) && isValidBranch(job.branch)) {
    const f = git(neoDir, ["fetch", "--quiet", "fork", `+refs/heads/${job.branch}:refs/remotes/fork/${job.branch}`]);
    if (f.status === 0 && git(neoDir, ["checkout", "-q", "-B", job.branch, `fork/${job.branch}`]).status === 0) continueBranch = job.branch;
  }
  // PR revision: the PR head every new commit must descend from.
  const prevHead = continueBranch ? git(neoDir, ["rev-parse", "HEAD"]).stdout.trim() : "";
  if (revise && !continueBranch) {
    return { ...base, branch: job.branch, status: "needs_human", summary: `Revise round ${pf.revise_round}: PR branch ${job.branch} could not be fetched from the fork.` };
  }
  let previousFailure = typeof job.lab_failure === "string" ? tail(redactIdentifyingDetails(job.lab_failure, { knownSlugs: slugs }), 3000) : "";
  let last = null;
  if (startAttempt > cfg.maxAttempts) {
    return { ...base, attempts: startAttempt - 1, max_attempts: cfg.maxAttempts, status: "needs_human", lab: "failed", summary: `Lab test failed after ${cfg.maxAttempts} attempt(s): ${tail(previousFailure, 500)}` };
  }
  for (let attempt = startAttempt; attempt <= cfg.maxAttempts; attempt += 1) {
    const prompt = path.join(ctx.scratch, `fix-prompt-${attempt}.txt`);
    fs.writeFileSync(prompt, fixPrompt(job, neoDir, cfg, attempt, previousFailure, attempt === startAttempt ? continueBranch : ""));
    const logPath = path.join(ctx.scratch, `fix-hermes-${attempt}.log`);
    stage(cfg, "hermes", { attempt, max_attempts: cfg.maxAttempts });
    // PR-loop validation: the first commit is the worker's own doc-only file.
    const r =
      job.validation === true && !revise && attempt === startAttempt && !continueBranch
        ? validationCommit(neoDir, job, logPath)
        : hermesChat(cfg, "heimcloud-ops-fix", prompt, { cwd: neoDir, logPath });
    const verdict = extractJson(r.stdout) || extractJson(r.stderr) || {};
    const common = { ...base, attempts: attempt, max_attempts: cfg.maxAttempts, base_sha: baseSha, evidence_path: logPath };

    if (verdict.status === "failed") {
      return {
        ...common,
        status: "needs_human",
        summary: `Hermes gave up: ${redactIdentifyingDetails(verdict.summary || "", { knownSlugs: slugs })}`,
      };
    }
    // A revision stays on the PR branch whatever Hermes names.
    const branch = revise ? job.branch : String(verdict.branch || `ops/incident-${job.incident_id}`).trim();
    const prTitle = revise && job.pr_title ? String(job.pr_title) : String(verdict.pr_title || `ops: incident #${job.incident_id} (${job.severity || "unspecified"})`);
    const prBody = revise && job.pr_body
      ? String(job.pr_body)
      : [
          `# Heimcloud Ops incident #${job.incident_id}`,
          "",
          `report_hash: \`${job.report_hash}\``,
          "",
          redactIdentifyingDetails(verdict.summary || "Automated fix (lab test pending).", { knownSlugs: slugs }),
          "",
          "**Never auto-merged**: merging is a human decision.",
          "",
        ].join("\n");
    let changeSummary;
    if (revise) {
      const head = git(neoDir, ["rev-parse", "HEAD"]).stdout.trim();
      if (head === prevHead) {
        return { ...common, branch, status: "needs_human", summary: `Revise round ${pf.revise_round}: Hermes made no new commit for the feedback (${hermesFailure(r)}). Log: ${logPath}` };
      }
      if (git(neoDir, ["merge-base", "--is-ancestor", prevHead, "HEAD"]).status !== 0) {
        return { ...common, branch, status: "needs_human", summary: `Revise round ${pf.revise_round}: the new commits do not build on the PR head (history rewritten); nothing pushed.` };
      }
      const subjects = git(neoDir, ["log", "--format=%s", `${prevHead}..HEAD`]).stdout.split("\n").filter(Boolean).slice(0, 10);
      changeSummary = {
        commits: subjects.map((x) => redactIdentifyingDetails(x, { knownSlugs: slugs }).slice(0, 200)),
        summary: redactIdentifyingDetails(String(verdict.summary || ""), { knownSlugs: slugs }).slice(0, 800),
        prev_head: prevHead,
      };
    }

    stage(cfg, "checks");
    const gate = gateCommits(cfg, neoDir, baseSha, { branch, prTitle, prBody, slugs });
    if (!gate.ok) {
      const res = { ...common, branch, ...gate.result };
      if (res.summary.startsWith("no commit")) {
        res.summary = `Hermes made no commit on top of ${cfg.baseRef} (${hermesFailure(r)}). Log: ${logPath}`;
      }
      return res;
    }

    // Token is only needed from here on. Without it (or if the push fails)
    // the fix is kept locally and can be pushed later without Hermes.
    const jobName = path.basename(ctx.scratch);
    const keep = () =>
      savePending(cfg, ctx.scratch, neoDir, {
        kind: "fix",
        incident_id: job.incident_id,
        job: jobName,
        branch,
        class: job.class,
        severity: job.severity,
        report_hash: job.report_hash,
        base_ref: cfg.baseRef,
        base_sha: baseSha,
        pr_title: prTitle,
        pr_body: prBody,
        target_repo: cfg.target?.upstream,
        attempt,
      }, slugs);
    const kept = (pending) => ({
      ...common,
      branch,
      job: jobName,
      pr_title: prTitle,
      pr_body: prBody,
      lab: "deferred_until_push",
      patch_path: pending.patch_path,
      pending_path: path.join(ctx.scratch, PENDING_FILE),
      head_sha: pending.head_sha,
    });
    stage(cfg, "push");
    const token = tokenAvailable(cfg);
    if (!token.ok) {
      return {
        ...kept(keep()),
        status: "ready_no_token",
        summary:
          `Fix branch ${branch} is committed locally (${gate.commits} commit(s)) and passed deny-list + redaction gates; ` +
          `waiting for the fork-push token (${token.reason}). ${retryHint(jobName)}`,
      };
    }

    const noLab = cfg.target?.lab === "none";
    const pushed = pushAndLab(cfg, neoDir, branch, job.class, { skipLab: cfg.labAuto || Boolean(gate.protected) || noLab, force: !revise });
    if (!pushed.pushed) {
      // Not a Hermes failure: no retry loop, attempt budget untouched.
      return {
        ...kept(keep()),
        status: "push_failed",
        push_error: pushed.error.class,
        summary: `Fix branch ${branch} is committed locally; push to the fork failed (${pushed.error.class}: ${pushed.error.message}). ${retryHint(jobName)}`,
      };
    }
    last = { ...common, branch, compare_url: pushed.compare_url, pr_title: prTitle, pr_body: prBody, change_summary: changeSummary };
    const headSha = git(neoDir, ["rev-parse", "HEAD"]).stdout.trim();
    if (noLab) return noLabMethodResult(cfg, { ...last, job: jobName, fix_job: jobName, head_sha: headSha, protected: gate.protected || undefined });
    if (gate.protected) {
      const info = {
        protected: gate.protected,
        branch,
        fix_job: jobName,
        attempt,
        head_sha: headSha,
        base_sha: baseSha,
        pr_title: prTitle,
        pr_body: prBody,
        compare_url: pushed.compare_url,
        change_summary: changeSummary,
        ...pf,
      };
      if (cfg.labAuto) return approvalNeededResult(common, info);
      return {
        ...last,
        protected: gate.protected,
        head_sha: info.head_sha,
        status: "awaiting_lab_test",
        lab: "skipped",
        summary: `Protected path (${gate.protected.label}): branch pushed, compare link ready; no automatic lab test for protected paths. Test manually before opening the PR.`,
      };
    }
    if (cfg.labAuto) {
      // Automated lab stage: a separate lab job (shown in the queue) runs the
      // root lab unit. No compare link until it passes.
      const lab = enqueueLab(cfg, job, {
        branch,
        fix_job: jobName,
        attempt,
        compare_url: pushed.compare_url,
        pr_title: prTitle,
        pr_body: prBody,
        base_sha: baseSha,
        head_sha: headSha,
        change_summary: changeSummary,
        ...(revise ? { revise_feedback: job.revise_feedback } : {}),
        ...pf,
      });
      return {
        ...common,
        branch,
        job: jobName,
        pr_title: prTitle,
        pr_body: prBody,
        status: "lab_queued",
        lab: "queued",
        lab_job: lab.instance,
        summary: `Branch ${branch} pushed to the fork (attempt ${attempt}/${cfg.maxAttempts}); automated lab test queued.`,
      };
    }
    const lab = pushed.lab;
    if (lab.skipped) {
      return {
        ...last,
        status: "awaiting_lab_test",
        lab: "skipped",
        summary: lab.cancelled
          ? "Branch pushed; compare link ready. The lab test was cancelled by admin — test manually before opening the PR."
          : `Branch pushed; compare link ready. ${cfg.labBin} is not installed, so the lab test was skipped — test manually before opening the PR.`,
      };
    }
    if (lab.ok) {
      const res = { ...last, status: "compare_ready", lab: "passed", summary: "Lab test passed; open the compare link to create the upstream PR." };
      return afterLabPass(cfg, { ...job, ...pf, branch, head_sha: headSha, pr_title: prTitle, pr_body: prBody, change_summary: changeSummary }, res, { slugs });
    }
    previousFailure = redactIdentifyingDetails(lab.output, { knownSlugs: slugs });
    log(`incident ${job.incident_id}: lab test failed (attempt ${attempt})`);
  }
  // Out of attempts: no compare link (design: no PR after failed lab tests).
  if (pf.revise_round) haltPr(cfg, { incident_id: job.incident_id, ...pf }, "lab_failed", `Revise round ${pf.revise_round} failed the lab test; nothing posted on PR #${pf.pr_number}.`);
  return {
    ...last,
    compare_url: undefined,
    status: "needs_human",
    lab: "failed",
    summary: `Lab test failed after ${cfg.maxAttempts} attempt(s): ${tail(previousFailure, 500)}`,
  };
}

// ---------------------------------------------------------------- PR loop

/** Side result (kind "pr") next to the job's own result. */
function writePrResult(cfg, result) {
  try {
    writeResult(cfg, path.join(cfg.results, `pr-${result.incident_id}-${jobStamp()}-${process.pid}.json`), result);
  } catch (err) {
    log(`cannot write PR result for incident ${result.incident_id}: ${err.code || err.message}`);
  }
}

/** PR automation usable for this run (enabled + token file present). */
function prReady(cfg) {
  if (!cfg.prOn) return { ok: false, reason: "PR automation is off (autofix.pr.enable)" };
  if (!prTokenPresent(cfg)) return { ok: false, reason: "GitHub token missing (autofixForkPushToken)" };
  return { ok: true };
}

/**
 * After a lab pass (or the admin "Skip lab": untested): open / adopt the
 * upstream PR, or, for a revise round, post the reply on the open PR. Returns
 * the job result (fix_result) with the PR outcome folded in; the PR state goes
 * to the app as a separate kind "pr" result. Redaction hit → no PR, no reply.
 */
export function afterLabPass(cfg, job, res, { slugs = [], untested = false, protectedLabel = "" } = {}) {
  const ready = prReady(cfg);
  if (!ready.ok || !cfg.target) return ready.ok ? res : { ...res, pr_skipped: ready.reason };
  const id = Number(job.incident_id);
  return withPrLock(cfg, () => {
    const rec = readRecord(cfg, id);
    // ---- revise round: reply on the PR
    if (Number(job.revise_round) && Number(job.pr_number)) {
      if (!rec || Number(rec.number) !== Number(job.pr_number)) return { ...res, summary: `${res.summary} PR #${job.pr_number} is not tracked; no reply posted.` };
      if (rec.state !== "open" || rec.stopped || rec.halted) {
        rec.revise_pending = null;
        writeRecord(cfg, rec);
        return { ...res, summary: `${res.summary} PR #${rec.number} is ${rec.state !== "open" ? rec.state : rec.stopped ? "stopped" : "halted"}; no reply posted.` };
      }
      const cs = job.change_summary || {};
      const text = buildReplyText(cfg, { round: Number(job.revise_round), changes: cs.commits || [], summary: cs.summary || "", labReport: res.lab_report, untested, protectedLabel }, slugs);
      const hits = outboundHits(text, slugs);
      if (hits.length) {
        rec.halted = "redaction_blocked";
        rec.revise_pending = null;
        writeRecord(cfg, rec);
        writePrResult(cfg, prStateResult(rec, "blocked", `Reply on PR #${rec.number} blocked by the redaction gate (${hits.join(", ")}); nothing posted.`));
        return { ...res, status: "redaction_blocked", summary: `Revision pushed and ${untested ? "not lab-tested" : "lab-tested"}, but the PR reply was blocked by the redaction gate (${hits.join(", ")}).` };
      }
      const c = postComment(cfg, rec.number, text);
      rec.revise_pending = null;
      if (job.head_sha) rec.head_sha = job.head_sha;
      writeRecord(cfg, rec);
      writePrResult(cfg, prStateResult(rec, "revised", c.ok ? `Revision ${rec.round}/${rec.max_rounds} pushed; reply posted on PR #${rec.number}.` : `Revision ${rec.round}/${rec.max_rounds} pushed; the reply could not be posted (${c.error}).`, { reply_posted: c.ok }));
      return { ...res, pr_number: rec.number, pr_url: rec.url, summary: `${res.summary} Revision ${rec.round}/${rec.max_rounds} pushed to PR #${rec.number}${c.ok ? "; reply posted" : `; reply failed (${c.error})`}.` };
    }
    // ---- open / adopt
    const text = buildPrText(cfg, { prTitle: job.pr_title, prBody: job.pr_body, labReport: res.lab_report, untested, protectedLabel }, slugs);
    const hits = [...outboundHits(text.title, slugs), ...outboundHits(text.body, slugs)];
    if (!text.title.trim()) hits.push("empty_title");
    if (hits.length) {
      writePrResult(cfg, { kind: "pr", via: "pr", pr_event: "blocked", incident_id: id, target_repo: cfg.target.upstream, branch: job.branch, summary: `PR not opened: the redaction gate blocked the title/body (${hits.join(", ")}).` });
      return { ...res, status: "redaction_blocked", compare_url: undefined, pr_blocked: true, summary: `Lab ${untested ? "skipped" : "passed"}, but the PR was NOT opened: the redaction gate blocked its title/body (${hits.join(", ")}).` };
    }
    const draft = untested || cfg.prDraft;
    const pr = openOrAdoptPr(cfg, { branch: job.branch, title: text.title, body: text.body, draft });
    if (!pr.ok) {
      writePrResult(cfg, { kind: "pr", via: "pr", pr_event: "error", incident_id: id, target_repo: cfg.target.upstream, branch: job.branch, summary: `Opening the PR failed (${pr.error}); the compare link is the fallback.` });
      return { ...res, pr_error: pr.error, summary: `${res.summary} Opening the PR failed (${pr.error}); the compare link is the fallback.` };
    }
    const keep = rec && Number(rec.number) === pr.number ? rec : null;
    const nrec = keep ? { ...keep, state: pr.state, draft: pr.draft, url: pr.url } : newRecord(cfg, job, pr, { untested });
    writeRecord(cfg, nrec);
    writePrResult(cfg, prStateResult(nrec, pr.adopted ? "adopted" : "opened", `${pr.adopted ? "Adopted" : "Opened"} ${draft ? "draft " : ""}PR #${pr.number} on ${cfg.target.upstream}${untested ? " (NOT lab-tested)" : ""}.`));
    return { ...res, pr_number: pr.number, pr_url: pr.url, summary: `${res.summary.replace(/; open the compare link to create the upstream PR\.?$/, ".")} ${pr.adopted ? "Adopted" : "Opened"} ${draft ? "draft " : ""}PR #${pr.number}.` };
  });
}

/**
 * kind "pr" job (app: "Skip lab" with PR automation, or "Open PR" after a
 * compare-only lab pass): open the PR / post the revise reply without a lab run.
 */
export function handlePr(cfg, job, ctx) {
  const untested = job.mode === "untested";
  const base = {
    kind: "pr",
    via: "pr",
    incident_id: Number(job.incident_id),
    target_repo: cfg.target.upstream,
    branch: job.branch,
  };
  if (!isValidBranch(job.branch)) return { ...base, pr_event: "error", summary: "PR job without a valid fix branch." };
  const ready = prReady(cfg);
  if (!ready.ok) return { ...base, pr_event: "error", summary: `${ready.reason}; use the compare link.` };
  const res = {
    ...base,
    summary: untested ? "Lab test skipped by the admin." : "Lab test passed.",
    lab_report: job.lab_report && typeof job.lab_report === "object" ? job.lab_report : undefined,
  };
  const label = job.protected ? (normalizeProtected(job.protected)?.label || "") : "";
  const out = afterLabPass(cfg, job, res, { slugs: ctx.slugs, untested, protectedLabel: label });
  // The PR outcome itself went out as a side result; this one only logs.
  return { ...out, kind: "pr", via: "pr", pr_event: out.status === "redaction_blocked" ? "blocked_job" : "job", status: undefined, _noIngest: true };
}

/** Stop the PR loop for an incident (cap / lab fail / redaction): needs_human, nothing posted. */
function haltPr(cfg, base, why, summary) {
  try {
    withPrLock(cfg, () => {
      const rec = readRecord(cfg, base.incident_id);
      if (!rec || Number(rec.number) !== Number(base.pr_number)) return;
      rec.halted = why;
      rec.revise_pending = null;
      writeRecord(cfg, rec);
      writePrResult(cfg, prStateResult(rec, "halted", summary));
    });
  } catch (err) {
    log(`cannot halt PR loop for incident ${base.incident_id}: ${err.message}`);
  }
}

/** Pending (queued or claimed) job of any kind for this incident. */
function incidentJobPending(cfg, incidentId) {
  const pre = `${Number(incidentId)}-`;
  for (const d of [...KINDS.map((k) => path.join(cfg.queue, k))]) {
    try {
      if (fs.readdirSync(d).some((n) => n.startsWith(pre) && n.endsWith(".json"))) return true;
    } catch {
      /* none */
    }
  }
  try {
    return fs.readdirSync(path.join(cfg.queue, "processing")).some((n) => KINDS.some((k) => n.startsWith(`${k}-${pre}`)));
  } catch {
    return false;
  }
}

/** `--pr-poll`: one pass over the tracked PRs (timer every 2–5 min). */
export function prPoll(cfg) {
  if (!cfg.prOn) return { skipped: "PR automation off" };
  if (!prTokenPresent(cfg)) return { skipped: "no token" };
  mkdirs(cfg);
  const slugs = knownSlugs(cfg);
  return pollPrs(cfg, {
    slugs,
    writeResult: (r) => writePrResult(cfg, r),
    jobPending: (id) => incidentJobPending(cfg, id),
    enqueueRevise: (tcfg, rec, items) => {
      const j = enqueueSelf(cfg, "fix", rec.incident_id, {
        ...rec.job,
        target_repo: rec.upstream,
        branch: rec.branch,
        attempt: 1,
        revise: { round: rec.round, pr_number: rec.number },
        revise_feedback: feedbackBlock(tcfg, rec.number, items, slugs),
      });
      return j.instance;
    },
  });
}

// ---------------------------------------------------------------- lab

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function jobStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Enqueue a job file for the worker itself (lab / lab-retry fix), atomically. */
function enqueueSelf(cfg, kind, incidentId, payload) {
  const dir = path.join(cfg.queue, kind);
  fs.mkdirSync(dir, { recursive: true });
  let name = `${incidentId}-${jobStamp()}.json`;
  for (let i = 0; fs.existsSync(path.join(dir, name)) && i < 5; i += 1) {
    sleepSync(2);
    name = `${incidentId}-${jobStamp()}.json`;
  }
  atomicWriteJson(path.join(dir, name), { job_version: 1, kind, incident_id: incidentId, enqueued_at: new Date().toISOString(), enqueued_by: "worker", ...payload });
  return { name, instance: `${kind}-${name.replace(/\.json$/, "")}` };
}

export function enqueueLab(cfg, job, fields) {
  // Only the app (admin approval) may queue a protected lab job; the root
  // runner re-checks the approval and detects protected changes on its own.
  if (fields?.protected || fields?.approval || fields?.approved_by) throw new Error("the worker cannot enqueue a protected / approved lab job");
  const incidentId = Number(job.incident_id);
  return enqueueSelf(cfg, "lab", incidentId, {
    report_hash: job.report_hash,
    unit: job.unit,
    severity: job.severity,
    class: job.class,
    neo_version: job.neo_version,
    logs_excerpt: job.logs_excerpt,
    max_attempts: cfg.maxAttempts,
    ...fields,
  });
}

/** Deterministic, redacted failure evidence fed back to Hermes on a lab retry. */
export function labFailureText(report, slugs) {
  const r = normalizeLabReport(report) || { checks: [], evidence: [], reason: "" };
  const redact = keepUnitNames((t) => redactIdentifyingDetails(t, { knownSlugs: slugs }));
  const lines = [
    `Lab test verdict: ${r.verdict}${r.failedStage ? ` (stage ${r.failedStage})` : ""}: ${r.reason}`,
    ...r.checks.filter((c) => c.ok === false).map((c) => `FAILED ${c.label}: ${c.detail}`),
    ...(r.evidence.length ? ["Evidence:", ...r.evidence] : []),
  ];
  return tail(redact(lines.join("\n")), 3000);
}

/**
 * Hermes (skill heimcloud-ops-labtest) derives incident-specific checks from
 * the incident and the diff; the plan is validated against the whitelist. No
 * usable plan → deterministic default (incident unit active).
 */
export function planLabChecks(cfg, job, ctx) {
  const notes = [];
  const slugs = ctx.slugs;
  fs.mkdirSync(ctx.scratch, { recursive: true });
  let files = [];
  const clone = path.join(cfg.scratchRoot, String(job.fix_job || "x"), "neo");
  if (/^fix-\d+-[A-Za-z0-9-]+$/.test(String(job.fix_job || "")) && job.base_sha && fs.existsSync(clone)) {
    const d = git(clone, ["diff", "--name-only", `${job.base_sha}..HEAD`]);
    if (d.status === 0) files = d.stdout.split("\n").filter(Boolean).slice(0, 60);
  }
  const prompt = path.join(ctx.scratch, "lab-plan-prompt.txt");
  fs.writeFileSync(
    prompt,
    [
      `Plan the lab-test checks for Ops incident #${job.incident_id} (fix branch ${job.branch}).`,
      `unit: ${job.unit}`,
      `severity: ${job.severity}`,
      `class: ${job.class}`,
      "",
      "logs_excerpt (redacted):",
      job.logs_excerpt || "(none)",
      "",
      "changed files:",
      ...(files.length ? files : ["(unknown)"]),
      "",
      "Respond with the JSON check plan only.",
    ].join("\n"),
  );
  stage(cfg, "planning");
  const r = hermesChat({ ...cfg, hermesTimeoutMs: cfg.labPlanTimeoutMs }, "heimcloud-ops-labtest", prompt, {
    cwd: ctx.scratch,
    logPath: path.join(ctx.scratch, "lab-plan-hermes.log"),
  });
  const raw = extractJson(r.stdout) || extractJson(r.stderr);
  const plan = raw ? validateCheckPlan(raw) : { checks: [], errors: [`Hermes produced no plan (${hermesFailure(r)})`] };
  // Same wording as the root runner's evidence note ("check #N dropped: why").
  for (const e of plan.errors.slice(0, 6)) notes.push(redactIdentifyingDetails(`check ${e.replace(/^(#\d+):\s*/, "$1 dropped: ")}`, { knownSlugs: slugs }));
  if (plan.checks.length) return { checks: plan.checks, source: "hermes", notes };
  notes.push("using the default check (incident unit active)");
  return { checks: defaultChecks(job.unit), source: "default", notes };
}

function unitState(cfg, unit) {
  const r = run(cfg.systemctlBin, ["show", "-p", "ActiveState", "--value", unit], { timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

function readLabFile(cfg, instance, name) {
  try {
    const fd = fs.openSync(path.join(cfg.labStateDir, instance, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 1024 * 1024) return null;
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Lab job: plan checks (Hermes), start the root lab unit for this job, follow
 * its progress into worker-status.json, map the verdict. Cancel is passed to
 * the runner through the same cancel flag; the runner only honours it before
 * activation, so the worker never interrupts an activation.
 */
export function handleLab(cfg, job, ctx) {
  const instance = path.basename(ctx.processing, ".json");
  const attempt = Math.max(1, Math.floor(Number(job.attempt) || 1));
  const maxAttempts = Math.max(1, Number(job.max_attempts) || cfg.maxAttempts);
  const base = {
    kind: "fix",
    via: "lab",
    incident_id: Number(job.incident_id),
    branch: job.branch,
    job: job.fix_job,
    lab_job: instance,
    attempts: attempt,
    max_attempts: maxAttempts,
    ...prFields(cfg, job),
  };
  const err = (summary, extra = {}) => ({ ...base, status: "lab_error", lab: "error", summary, _bucket: "failed", _reason: { code: "lab_error", reason: summary.slice(0, 160) }, ...extra });
  if (!isValidInstance(instance) || !isValidBranch(job.branch)) return err("lab job has an invalid name or branch");
  const unit = `${cfg.labUnitPrefix}@${instance}.service`;
  const labInfo = (prot) => ({
    protected: normalizeProtected(prot) || { ...UNVERIFIED_PROTECTED },
    branch: job.branch,
    fix_job: job.fix_job,
    attempt,
    head_sha: job.head_sha,
    base_sha: job.base_sha,
    pr_title: job.pr_title,
    pr_body: job.pr_body,
    compare_url: job.compare_url,
    change_summary: job.change_summary,
    ...prFields(cfg, job),
  });
  if (cfg.target?.lab === "none") {
    return { ...noLabMethodResult(cfg, { ...base, compare_url: job.compare_url, pr_title: job.pr_title, pr_body: job.pr_body, head_sha: job.head_sha, change_summary: job.change_summary }), _bucket: "failed", _reason: { code: "no_lab_method", reason: "target has no lab method" } };
  }
  // A protected lab job without the app's approval never reaches the root
  // unit (the runner would refuse it anyway). Nothing was pushed by this run.
  if (job.protected && !job.approval) {
    return { ...approvalNeededResult(base, labInfo(job.protected), "", "lab_job"), _bucket: "failed", _reason: { code: "approval_required", reason: "protected lab job without admin approval" } };
  }

  let report = readLabFile(cfg, instance, "result.json");
  let plan = null;
  if (!report || unitState(cfg, unit) === "active") {
    report = null;
    plan = planLabChecks(cfg, job, ctx);
    try {
      const cur = JSON.parse(fs.readFileSync(ctx.processing, "utf8"));
      atomicWriteJson(ctx.processing, { ...cur, lab_checks: plan.checks, lab_plan: { source: plan.source, notes: plan.notes } });
    } catch (e) {
      return err(`could not write the lab spec (${e.code || e.message})`);
    }
    stage(cfg, "lab", { lab_stage: "starting", lab_step: null, lab_steps: null });
    const st = run(cfg.systemctlBin, ["start", "--no-block", unit], { timeout: 60_000 });
    if (st.status !== 0) {
      return err(`could not start ${cfg.labUnitPrefix}@ (${tail(st.stderr || st.error || `exit ${st.status}`, 200).trim()}); is the polkit rule installed?`);
    }
    const deadline = Date.now() + cfg.labWaitMs;
    let goneSince = 0;
    let lastKey = "";
    let lastBeat = 0;
    for (;;) {
      sleepSync(cfg.labPollMs);
      const status = readLabFile(cfg, instance, "status.json");
      if (status && currentJob) {
        // Mirror runner progress; write on change or once per heartbeat only.
        const p = { lab_stage: String(status.stage || "").slice(0, 30), lab_step: Number(status.step) || null, lab_steps: Number(status.steps) || null };
        const key = JSON.stringify(p);
        if (key !== lastKey || Date.now() - lastBeat >= cfg.heartbeatMs) {
          stage(cfg, "lab", p, { checkCancel: false });
          lastKey = key;
          lastBeat = Date.now();
        }
      }
      report = readLabFile(cfg, instance, "result.json");
      const state = unitState(cfg, unit);
      const running = ["active", "activating", "deactivating", "reloading"].includes(state);
      if (report && !running) break;
      if (!running) {
        goneSince ||= Date.now();
        if (Date.now() - goneSince > Math.max(10_000, 4 * cfg.labPollMs)) break;
      } else goneSince = 0;
      if (Date.now() > deadline) {
        return err(`lab unit still running after ${Math.round(cfg.labWaitMs / 1000)} s; its watchdog rolls the host back at its deadline`);
      }
    }
    if (!report) {
      const wd = readLabFile(cfg, instance, "watchdog.json");
      return err(`lab unit ended without a result${wd?.fired ? ` (watchdog rolled back: restored=${Boolean(wd.restored)})` : ""}`);
    }
  }

  const slugs = ctx.slugs;
  const redact = keepUnitNames((t) => redactIdentifyingDetails(t, { knownSlugs: slugs }));
  const norm = normalizeLabReport(report);
  const lab_report = {
    ...report,
    plan_source: plan?.source || report.plan_source,
    plan_notes: plan?.notes || report.plan_notes || [],
    reason: redact(report.reason || ""),
    evidence: (report.evidence || []).slice(0, 30).map((l) => redact(l)),
    checks: (report.checks || []).slice(0, 40).map((c) => ({ ...c, label: redact(c.label || checkLabel(c)), detail: redact(c.detail || "") })),
  };
  const counts = `${norm.passed}/${norm.checks.length} checks passed`;
  const gen = norm.generation.before != null ? `, generation ${norm.generation.before} → lab → ${norm.generation.after ?? "?"}${norm.generation.restored ? " (restored)" : ""}` : "";
  const withReport = { ...base, lab_report, evidence_path: path.join(cfg.labStateDir, instance, "result.json") };

  // The root runner found protected changes (its own diff of the deployed neo
  // source vs the fork branch) and no valid admin approval: nothing activated.
  if (report.approval_required || report.approval_invalid) {
    const extra = report.approval_invalid ? `The runner rejected the approval (${redact(report.reason || "")}); approve again.` : "";
    return {
      ...approvalNeededResult({ ...base, lab_report, evidence_path: path.join(cfg.labStateDir, instance, "result.json") }, labInfo(report.protected), extra.slice(0, 300), "runner"),
      _bucket: "failed",
      _reason: { code: "approval_required", reason: report.approval_invalid ? "approval rejected by the lab runner" : "protected change without admin approval" },
    };
  }
  if (report.rollback_unverified) {
    return {
      ...withReport,
      status: "needs_human",
      lab: "error",
      summary: `ROLLBACK NOT VERIFIED after the lab test: check the host now. ${redact(report.reason || "")}`.slice(0, 600),
      _bucket: "failed",
      _reason: { code: "rollback_unverified", reason: "lab rollback not verified" },
    };
  }
  if (report.services_unhealthy) {
    return {
      ...withReport,
      status: "needs_human",
      lab: norm.verdict === "pass" ? "passed" : "error",
      services_unhealthy: true,
      summary: `Lab test ${norm.verdict} and rolled back, but ${redact(report.services_reason || "ops / Hermes")} is still down after a restart: check the host now.`.slice(0, 600),
      _bucket: "failed",
      _reason: { code: "services_unhealthy", reason: "ops/Hermes down after the lab rollback" },
    };
  }
  if (norm.verdict === "pass") {
    const res = {
      ...withReport,
      status: "compare_ready",
      lab: "passed",
      compare_url: job.compare_url,
      pr_title: job.pr_title,
      pr_body: job.pr_body,
      head_sha: job.head_sha,
      summary: `Lab test passed (${counts}${gen}); open the compare link to create the upstream PR.`,
    };
    const prot = job.protected ? normalizeProtected(job.protected) : null;
    return afterLabPass(cfg, job, res, { slugs, protectedLabel: prot?.label || "" });
  }
  if (norm.verdict === "cancelled") {
    return { ...cancelledResult("lab", job, report.failed_stage || "lab"), ...withReport, status: "awaiting_lab_test", lab: "cancelled", compare_url: job.compare_url, _bucket: "failed", _reason: { code: "cancelled", reason: "lab test cancelled before activation" } };
  }
  if (norm.verdict === "fail") {
    const failure = labFailureText(lab_report, slugs);
    if (attempt < maxAttempts) {
      const next = enqueueSelf(cfg, "fix", Number(job.incident_id), {
        report_hash: job.report_hash,
        unit: job.unit,
        severity: job.severity,
        class: job.class,
        neo_version: job.neo_version,
        logs_excerpt: job.logs_excerpt,
        attempt: attempt + 1,
        branch: job.branch,
        lab_failure: failure,
        target_repo: cfg.target?.upstream,
        // A revise round keeps its PR / round (same branch, same feedback).
        ...(base.revise_round ? { revise: { round: base.revise_round, pr_number: base.pr_number }, revise_feedback: job.revise_feedback, pr_title: job.pr_title, pr_body: job.pr_body } : {}),
      });
      return {
        ...withReport,
        status: "lab_retry",
        lab: "failed",
        retry_job: next.instance,
        summary: `Lab test failed (${counts}${gen}): ${redact(report.reason || "")}. Retrying the fix with this evidence (attempt ${attempt + 1}/${maxAttempts}).`.slice(0, 700),
      };
    }
    if (base.revise_round) haltPr(cfg, base, "lab_failed", `Revise round ${base.revise_round} failed the lab test after ${attempt} attempt(s); nothing posted on PR #${base.pr_number}.`);
    return {
      ...withReport,
      status: "needs_human",
      lab: "failed",
      compare_url: undefined,
      summary: `Lab test failed after ${attempt} attempt(s) (${counts}${gen}): ${redact(report.reason || "")}`.slice(0, 700),
    };
  }
  return err(`Lab test error: ${redact(report.reason || "unknown")}`.slice(0, 500), { lab_report });
}

function readJsonMaybe(...files) {
  for (const f of files) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Recovery for jobs that ended before push-pending.json existed (e.g. an old
 * "git push to fork failed" needs_human): rebuild it from the scratch clone.
 * branch = current branch; base = recorded base_sha from the job's result,
 * else merge-base with the upstream base ref. Gates run again in pushPending.
 */
export function rebuildPending(cfg, scratch) {
  const name = path.basename(scratch);
  const m = JOB_NAME_RE.exec(name);
  if (!m) throw new Error(`not a fix job scratch dir: ${name}`);
  const neoDir = path.join(scratch, "neo");
  if (!fs.existsSync(path.join(neoDir, ".git"))) {
    throw new Error(`no ${PENDING_FILE} and no scratch clone in ${scratch}`);
  }
  const jobFile = readJsonMaybe(
    path.join(cfg.queue, "done", `${name}.json`),
    path.join(cfg.queue, "failed", `${name}.json`),
  ) || {};
  const prior = readJsonMaybe(
    path.join(cfg.results, `${name}.ingested.json`),
    path.join(cfg.results, `${name}.json`),
    path.join(cfg.results, `${name}.rejected.json`),
  ) || {};
  const incidentId = Number(jobFile.incident_id || prior.incident_id || m[1]);
  const baseRef = prior.base_ref || cfg.baseRef;
  const branch = git(neoDir, ["symbolic-ref", "--short", "HEAD"]).stdout.trim();
  if (!BRANCH_RE.test(branch)) throw new Error(`scratch clone is not on a fix/* or ops/* branch (${branch || "detached"})`);

  let baseSha = "";
  if (prior.base_sha && git(neoDir, ["cat-file", "-e", `${prior.base_sha}^{commit}`]).status === 0) {
    baseSha = prior.base_sha;
  } else {
    const f = git(neoDir, ["fetch", "-q", "origin", baseRef], { timeout: 600_000, unsetEnv: ["GH_TOKEN", "GITHUB_TOKEN"] });
    const mb = f.status === 0 ? git(neoDir, ["merge-base", "HEAD", "FETCH_HEAD"]) : { status: 1, stdout: "" };
    baseSha = mb.status === 0 ? mb.stdout.trim() : "";
    if (!baseSha) throw new Error(`cannot determine base commit (no recorded base_sha, merge-base with ${baseRef} failed)`);
  }
  git(neoDir, ["remote", "remove", "fork"]);
  git(neoDir, ["remote", "add", "fork", cfg.forkUrl]);
  git(neoDir, ["config", "user.name", GIT_IDENTITY.name]);
  git(neoDir, ["config", "user.email", GIT_IDENTITY.email]);
  const slugs = knownSlugs(cfg);
  const severity = jobFile.severity || "unspecified";
  const state = {
    kind: "fix",
    incident_id: incidentId,
    job: name,
    branch,
    class: jobFile.class || "default",
    severity,
    report_hash: jobFile.report_hash || prior.report_hash || "",
    base_ref: baseRef,
    base_sha: baseSha,
    pr_title: prior.pr_title || `ops: incident #${incidentId} (${severity})`,
    pr_body:
      prior.pr_body ||
      [
        `# Heimcloud Ops incident #${incidentId}`,
        "",
        `report_hash: \`${jobFile.report_hash || ""}\``,
        "",
        "Automated fix (recovered from the worker scratch clone).",
        "",
        "Opened manually from the compare link — **do not auto-merge**.",
        "",
      ].join("\n"),
    recovered: true,
  };
  const gate = gateCommits({ ...cfg, baseRef }, neoDir, baseSha, { branch, prTitle: state.pr_title, prBody: state.pr_body, slugs });
  if (!gate.ok) {
    const err = new Error(`recovered clone failed the gates: ${gate.result.status}: ${gate.result.summary}`);
    err.gate = gate.result;
    throw err;
  }
  return savePending({ ...cfg, baseRef }, scratch, neoDir, state, slugs);
}

/**
 * Push a saved fix (ready_no_token / push_failed / recovered clone) without a
 * second Hermes run. Used by the `push` queue kind (admin "Retry push") and by
 * `heimcloud-ops-worker --push-pending <dir>` (heimcloud-ops-worker-push@<job>).
 * Re-runs identity/deny-list/redaction gates (slug list may have grown).
 * Never throws for token/push problems: those keep the pending state.
 */
export function pushPending(cfg, scratch) {
  // push@ unit and the push queue kind use different worker locks; serialise per job.
  const lockPath = path.join(scratch, ".push.lock");
  let fd = null;
  try {
    fd = fs.existsSync(scratch) ? tryLock(lockPath) : null;
  } catch {
    fd = null;
  }
  if (fd == null && fs.existsSync(scratch)) {
    const m = JOB_NAME_RE.exec(path.basename(scratch));
    return { kind: "fix", via: "push-pending", job: path.basename(scratch), incident_id: Number(m?.[1] || 0), status: "push_failed", push_error: "busy", summary: "Another push for this saved fix is running; try again when it finished." };
  }
  try {
    return pushPendingLocked(cfg, scratch);
  } finally {
    if (fd != null) unlock(fd, lockPath);
  }
}

function pushPendingLocked(cfg, scratch) {
  const pendingPath = path.join(scratch, PENDING_FILE);
  const jobName = path.basename(scratch);
  let p;
  try {
    p = fs.existsSync(pendingPath) ? JSON.parse(fs.readFileSync(pendingPath, "utf8")) : rebuildPending(cfg, scratch);
  } catch (err) {
    const m = JOB_NAME_RE.exec(jobName);
    return {
      kind: "fix",
      via: "push-pending",
      job: jobName,
      incident_id: Number(m?.[1] || 0),
      ...(err.gate || { status: "needs_human", summary: `cannot push saved fix: ${err.message}` }),
    };
  }
  const baseRes = { kind: "fix", via: "push-pending", job: jobName, incident_id: p.incident_id, base_ref: p.base_ref, base_sha: p.base_sha, branch: p.branch, pending_path: pendingPath, patch_path: p.patch_path, target_repo: p.target_repo };
  const target = p.target_repo ? findTarget(cfg.targets, p.target_repo) : cfg.target || cfg.targets[0];
  if (!target) return { ...baseRes, status: "needs_human", summary: `Saved fix targets ${p.target_repo}, which is no longer allowlisted; nothing pushed.` };
  const tc = cfg.target && cfg.target.upstream === target.upstream ? cfg : targetCfg(cfg, target);
  const cfgP = { ...tc, baseRef: p.base_ref || tc.baseRef };
  const forkName = cfgP.target.fork;
  const neoDir = p.neo_dir || path.join(scratch, "neo");
  const head = fs.existsSync(neoDir) ? git(neoDir, ["rev-parse", "HEAD"]).stdout.trim() : "";
  if (head !== p.head_sha) {
    // Scratch clone gone or moved: rebuild from the saved patch.
    const clone = cloneNeo(cfgP, neoDir);
    const am = clone.ok
      ? (git(neoDir, ["checkout", "-q", p.base_sha]), git(neoDir, ["am", "--committer-date-is-author-date", p.patch_path]))
      : { status: 1 };
    if (!clone.ok || am.status !== 0) {
      return { ...baseRes, status: "push_failed", push_error: "replay", summary: `Saved patch could not be replayed onto ${p.base_ref} (${clone.ok ? "git am failed" : "clone failed"}). ${retryHint(jobName)}` };
    }
    git(neoDir, ["remote", "remove", "fork"]);
    git(neoDir, ["remote", "add", "fork", cfgP.forkUrl]);
  }
  const slugs = knownSlugs(cfgP);
  stage(cfgP, "checks");
  const gate = gateCommits(cfgP, neoDir, p.base_sha, { branch: p.branch, prTitle: p.pr_title, prBody: p.pr_body, slugs });
  if (!gate.ok) {
    fs.renameSync(pendingPath, `${pendingPath}.blocked`);
    return { ...baseRes, ...gate.result, pending_path: undefined };
  }
  stage(cfgP, "push");
  const token = tokenAvailable(cfgP);
  if (!token.ok) {
    return { ...baseRes, status: "ready_no_token", summary: `Fix branch ${p.branch} still waiting for the fork-push token (${token.reason}). ${retryHint(jobName)}` };
  }
  const pushed = pushAndLab(cfgP, neoDir, p.branch, p.class, { skipLab: cfgP.labAuto || Boolean(gate.protected) });
  if (!pushed.pushed) {
    return { ...baseRes, status: "push_failed", push_error: pushed.error.class, summary: `Push to the fork failed again (${pushed.error.class}: ${pushed.error.message}). ${retryHint(jobName)}` };
  }
  fs.renameSync(pendingPath, `${pendingPath}.done`);
  const common = { ...baseRes, pending_path: undefined, compare_url: pushed.compare_url, pr_title: p.pr_title, pr_body: p.pr_body };
  if (gate.protected) {
    const info = {
      protected: gate.protected,
      branch: p.branch,
      fix_job: p.job || path.basename(scratch),
      attempt: Math.max(1, Number(p.attempt) || 1),
      head_sha: git(neoDir, ["rev-parse", "HEAD"]).stdout.trim() || p.head_sha,
      base_sha: p.base_sha,
      pr_title: p.pr_title,
      pr_body: p.pr_body,
      compare_url: pushed.compare_url,
      target_repo: cfgP.target.upstream,
    };
    if (cfgP.labAuto) return approvalNeededResult({ ...common, compare_url: undefined }, info, "Saved fix pushed.");
    return { ...common, protected: gate.protected, status: "awaiting_lab_test", lab: "skipped", summary: `Saved fix pushed to ${forkName} ${p.branch}; protected path (${gate.protected.label}): no automatic lab test, test manually.` };
  }
  if (cfgP.labAuto) {
    const lab = enqueueLab(cfgP, { incident_id: p.incident_id, report_hash: p.report_hash, severity: p.severity, class: p.class }, {
      target_repo: cfgP.target.upstream,
      branch: p.branch,
      fix_job: p.job || path.basename(scratch),
      attempt: Math.max(1, Number(p.attempt) || 1),
      compare_url: pushed.compare_url,
      pr_title: p.pr_title,
      pr_body: p.pr_body,
      base_sha: p.base_sha,
      // What was pushed (a replayed patch gets a new commit id).
      head_sha: git(neoDir, ["rev-parse", "HEAD"]).stdout.trim() || p.head_sha,
    });
    return { ...common, compare_url: undefined, status: "lab_queued", lab: "queued", lab_job: lab.instance, summary: `Saved fix pushed to ${forkName} ${p.branch}; automated lab test queued.` };
  }
  if (pushed.lab.skipped) return { ...common, status: "awaiting_lab_test", lab: "skipped", summary: `Saved fix pushed to ${forkName} ${p.branch}; compare link ready. Lab test ${pushed.lab.cancelled ? "cancelled by admin" : "skipped (not installed)"} — test manually.` };
  if (pushed.lab.ok) return { ...common, status: "compare_ready", lab: "passed", summary: `Saved fix pushed to ${forkName} ${p.branch}; lab test passed.` };
  return { ...common, compare_url: undefined, status: "needs_human", lab: "failed", summary: `Saved fix pushed but lab test failed (no Hermes retry in push mode): ${tail(redactIdentifyingDetails(pushed.lab.output, { knownSlugs: slugs }), 500)}` };
}

// ---------------------------------------------------------------- main

function shortSummary(s, n = 240) {
  const t = redactIdentifyingDetails(String(s || ""), { knownSlugs: [] }).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function processOne(cfg, entry) {
  const processing = claimJob(cfg, entry);
  if (!processing) return null;
  const pname = path.basename(processing);
  const m = /^(\d+)-/.exec(entry.name);
  const idFromName = Number((m && m[1]) || 0);
  let job = null;
  let result;
  let bucket = "done";
  let reason = null;
  const scratch = path.join(cfg.scratchRoot, path.basename(processing, ".json"));
  const startedAt = new Date().toISOString();
  try {
    job = JSON.parse(fs.readFileSync(processing, "utf8"));
    if (!job || typeof job !== "object" || !Number(job.incident_id)) throw new Error("job without incident_id");
  } catch (err) {
    // Malformed job: never retried, never crashes the loop.
    job = null;
    bucket = "failed";
    reason = { code: "malformed_job", reason: `malformed job JSON (${err.message})` };
    addIssue(cfg, "malformed_job", `Malformed ${entry.kind} job ${entry.name} moved to failed.`, { job: pname });
    result = failureResult(entry.kind, idFromName, `worker error: malformed job file (${err.message}); re-enqueue from the admin UI.`);
  }
  if (job) {
    // Claim counter (poison-job detection in recoverStale). Rename-based
    // rewrite inside processing/; losing it (disk full) only weakens detection.
    job._claims = (Number(job._claims) || 0) + 1;
    job._claimed_at = startedAt;
    try {
      atomicWriteJson(processing, job);
    } catch {
      /* ignore */
    }
    currentJob = {
      kind: entry.kind,
      name: entry.name,
      processing: pname,
      incident_id: Number(job.incident_id),
      priority: entry.priority || "normal",
      claims: job._claims,
      started_at: startedAt,
      stage: "claimed",
      stage_at: startedAt,
    };
    try {
      log(`${entry.kind} incident ${job.incident_id} (${entry.name})`);
      stage(cfg, "claimed");
      const ctx = { scratch, slugs: knownSlugs(cfg) };
      // fix / lab / pr jobs work on the incident's allowlisted target repo.
      const target = entry.kind === "triage" || entry.kind === "push" ? null : jobTarget(cfg, job);
      if (entry.kind !== "triage" && entry.kind !== "push" && !target) {
        const named = redactIdentifyingDetails(String(job.target_repo).slice(0, 120), { knownSlugs: ctx.slugs });
        result = {
          ...failureResult(entry.kind === "pr" ? "fix" : entry.kind, Number(job.incident_id), `Unknown target repo ${named}: not in the allowlist (services.ops.targets); nothing was cloned, pushed or tested.`),
          status: "needs_human",
          unknown_target: named,
        };
        bucket = "failed";
        reason = { code: "unknown_target", reason: "target repo not allowlisted" };
      } else if (entry.kind === "push") {
        const jm = JOB_NAME_RE.exec(String(job.job || ""));
        if (!jm || Number(jm[1]) !== Number(job.incident_id)) throw new Error("push job needs a matching fix job name");
        result = pushPending(cfg, path.join(cfg.scratchRoot, job.job));
      } else {
        const tcfg = target ? targetCfg(cfg, target) : cfg;
        result =
          entry.kind === "triage"
            ? handleTriage(cfg, job, ctx)
            : entry.kind === "lab"
              ? handleLab(tcfg, job, { ...ctx, processing })
              : entry.kind === "pr"
                ? handlePr(tcfg, job, ctx)
                : handleFix(tcfg, job, ctx);
      }
      if (result && result._bucket) {
        bucket = result._bucket;
        reason = result._reason || null;
        delete result._bucket;
        delete result._reason;
      }
    } catch (err) {
      if (err instanceof JobCancelled) {
        result = cancelledResult(entry.kind, job, err.stage);
        reason = { code: "cancelled", reason: `cancelled by admin during ${err.stage}` };
        bucket = "failed";
        addIssue(cfg, "job_cancelled", `Running ${entry.kind} job for incident #${job.incident_id} cancelled during ${err.stage}.`, {
          incident_id: Number(job.incident_id),
        });
      } else {
        bucket = "failed";
        reason = { code: err.code === "ENOSPC" ? "disk_full" : "worker_error", reason: `worker error: ${shortSummary(err.message || err, 160)}` };
        result = failureResult(entry.kind, Number(job.incident_id || idFromName), `worker error: ${err.message || err}`);
        if (err.code === "ENOSPC" || err.code === "EROFS" || err.code === "EACCES") {
          addIssue(cfg, "results_unwritable", `Job for incident #${job.incident_id} failed writing to disk (${err.code}).`, {
            incident_id: Number(job.incident_id),
          });
        }
      }
    }
  }
  if (currentJob) stage(cfg, "result", {}, { checkCancel: false });
  const noIngest = Boolean(result?._noIngest);
  if (result) delete result._noIngest;
  const wrote = noIngest ? { ok: true } : safeWriteResult(cfg, processing, result);
  if (!wrote.ok) {
    bucket = "failed";
    reason = { code: "results_unwritable", reason: `result not writable (${wrote.code})` };
  }
  finish(cfg, processing, bucket, reason);
  currentJob = null;
  updateStatus(cfg, {
    job: null,
    last_run: {
      finished_at: new Date().toISOString(),
      started_at: startedAt,
      kind: entry.kind,
      incident_id: result?.incident_id || idFromName || null,
      name: entry.name,
      status: result?.status || "unknown",
      ok: bucket === "done",
      reason: reason?.code || null,
      summary: shortSummary(result?.summary),
    },
  });
  log(`${entry.kind} incident ${result?.incident_id}: ${result?.status}${reason ? ` (${reason.code})` : ""}`);
  return result;
}

/**
 * Token check fields of queue/worker-status.json (v1 contract, read by the
 * admin to warn that Start fix will end ready_no_token). Never the token.
 */
export function writeWorkerStatus(cfg) {
  const t = tokenAvailable(cfg);
  updateStatus(cfg, { fork_push_token: t.ok, reason: t.ok ? null : t.reason, checked_at: new Date().toISOString() }, { heartbeat: false });
  return t;
}

/**
 * `--check-token`: the one GitHub token works for both scopes, never printed.
 *  push: heimcloud-autofix-env --check (git resolves the per-process helper
 *        and gets a password for the fork URL)
 *  api:  heimcloud-autofix-pr --check (token login = bot login, classic scope
 *        public_repo, push permission on every allowlisted fork)
 */
export function checkToken(cfg) {
  const push = tokenAvailable(cfg);
  console.log(`push scope (git credential via ${cfg.envBin}): ${push.ok ? "ok" : `FAIL: ${push.reason}`}`);
  const r = spawnSync(cfg.prBin, ["--check"], { encoding: "utf8", env: { ...prWrapperEnv(cfg) }, timeout: 90_000 });
  let api = null;
  try {
    api = JSON.parse(String(r.stdout || "").trim().split("\n").pop());
  } catch {
    api = { ok: false, error: r.error ? String(r.error.code || r.error.message) : `exit ${r.status}` };
  }
  console.log(`api scope (${cfg.prBin}): ${api.ok ? "ok" : "FAIL"} ${JSON.stringify(api)}`);
  return push.ok && api.ok ? 0 : 1;
}

// ---------------------------------------------------------------- kick

export const WORKER_UNITS = { path: "heimcloud-ops-worker.path", service: "heimcloud-ops-worker.service" };
const SHOW_PROPS = ["LoadState", "ActiveState", "SubState", "Result", "ExecMainStatus", "NRestarts", "StateChangeTimestamp"];

function systemctlShow(bin, unit) {
  const r = run(bin, ["show", unit, "--timestamp=unix", `--property=${SHOW_PROPS.join(",")}`], { timeout: 20_000 });
  const out = {};
  for (const line of String(r.stdout || "").split("\n")) {
    const k = line.indexOf("=");
    if (k > 0) out[line.slice(0, k)] = line.slice(k + 1).trim();
  }
  const ts = /^@(\d+)$/.exec(out.StateChangeTimestamp || "");
  return {
    load_state: out.LoadState || (r.status === 0 ? "unknown" : "error"),
    active_state: out.ActiveState || "unknown",
    sub_state: out.SubState || "",
    result: out.Result || "",
    exec_main_status: out.ExecMainStatus != null && out.ExecMainStatus !== "" ? Number(out.ExecMainStatus) : null,
    n_restarts: out.NRestarts ? Number(out.NRestarts) : 0,
    changed_at: ts ? new Date(Number(ts[1]) * 1000).toISOString() : null,
  };
}

function unitWedged(u) {
  return u.active_state === "failed" || /limit-hit/.test(u.result || "");
}

/**
 * `heimcloud-ops-worker --kick` (root, from heimcloud-ops-worker-kick.timer):
 * self-lockout watchdog. reset-failed on wedged worker units when jobs are
 * pending, restart the path watch if it is down, start the worker if jobs wait
 * and it is not running (the path unit only fires on changes), and report the
 * unit health to queue/systemd-status.json for the admin panel.
 */
export function kick(cfg, { systemctl = process.env.OPS_SYSTEMCTL_BIN || "systemctl", units = WORKER_UNITS } = {}) {
  const before = { path: systemctlShow(systemctl, units.path), service: systemctlShow(systemctl, units.service) };
  let pending = 0;
  try {
    pending = listJobs(cfg).length;
  } catch {
    pending = 0;
  }
  const paused = Boolean(readPause(cfg.queue));
  const actions = [];
  const wedged = Object.entries(before).filter(([, u]) => unitWedged(u)).map(([k]) => units[k]);
  if (wedged.length && pending) {
    const r = run(systemctl, ["reset-failed", ...wedged], { timeout: 20_000 });
    actions.push({ action: "reset-failed", units: wedged, ok: r.status === 0 });
  }
  if (before.path.load_state === "loaded" && before.path.active_state !== "active") {
    const r = run(systemctl, ["start", units.path], { timeout: 30_000 });
    actions.push({ action: "start", units: [units.path], ok: r.status === 0 });
  }
  if (pending && !paused && ["inactive", "failed"].includes(before.service.active_state) && before.service.load_state === "loaded") {
    const r = run(systemctl, ["start", "--no-block", units.service], { timeout: 30_000 });
    actions.push({ action: "start", units: [units.service], ok: r.status === 0 });
  }
  const after = actions.length ? { path: systemctlShow(systemctl, units.path), service: systemctlShow(systemctl, units.service) } : before;
  const file = path.join(cfg.queue, "systemd-status.json");
  let prev = {};
  try {
    // Runs as root in a container-writable dir: never follow a symlink.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      prev = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    prev = {};
  }
  const now = new Date().toISOString();
  const status = {
    version: 1,
    checked_at: now,
    units: after,
    wedged_before: wedged,
    pending,
    paused,
    actions,
    last_action_at: actions.length ? now : prev.last_action_at || null,
    last_actions: actions.length ? actions : prev.last_actions || [],
  };
  try {
    atomicWriteJson(file, status, 0o640);
  } catch (err) {
    console.error(`heimcloud-ops-worker: cannot write ${file}: ${err.code || err.message}`);
  }
  if (actions.length) log(`kick: ${actions.map((a) => `${a.action} ${a.units.join(" ")}${a.ok ? "" : " (failed)"}`).join("; ")}`);
  return status;
}

// ---------------------------------------------------------------- entry

function drain(cfg, lockInfo) {
  const token = cfg.fixOn ? tokenAvailable(cfg) : null;
  updateStatus(cfg, {
    state: "running",
    pid: process.pid,
    run_started_at: new Date().toISOString(),
    job: null,
    kinds: enabledKinds(cfg),
    hermes_timeout_sec: Math.round(cfg.hermesTimeoutMs / 1000),
    lab_timeout_sec: Math.round(cfg.labTimeoutMs / 1000),
    max_attempts: cfg.maxAttempts,
    heartbeat_sec: Math.round(cfg.heartbeatMs / 1000),
    fork_push_token: token ? token.ok : undefined,
    reason: token ? (token.ok ? null : token.reason) : undefined,
    checked_at: token ? new Date().toISOString() : undefined,
  });
  if (lockInfo.reclaimed) {
    addIssue(cfg, "stale_lock", "Reclaimed a stale worker lock left by a dead run.");
  }
  const rec = recoverStale(cfg);
  if (rec.requeued || rec.quarantined || rec.failed) {
    log(`stale processing/: ${rec.requeued} requeued, ${rec.quarantined} quarantined, ${rec.failed} failed`);
  }
  let n = 0;
  let paused = false;
  while (n < cfg.maxJobs) {
    // Pause is only honoured between jobs: a running job is never killed by it.
    if (readPause(cfg.queue)) {
      paused = true;
      log("queue paused (control/paused.json); not claiming new jobs");
      break;
    }
    const jobs = listJobs(cfg);
    if (!jobs.length) break;
    try {
      processOne(cfg, jobs[0]);
    } catch (err) {
      // Claim/finish I/O failure (unwritable queue dirs): stop this run instead
      // of spinning; the kick timer retries later.
      currentJob = null;
      log(`queue error: ${err.code || err.message}`);
      addIssue(cfg, "queue_unwritable", `Worker stopped: queue I/O failed (${err.code || "error"}).`);
      break;
    }
    n += 1;
  }
  if (!n && !paused) log("no jobs");
  updateStatus(cfg, { state: paused ? "paused" : "idle", pid: undefined, job: null, run_finished_at: new Date().toISOString() });
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.error("usage: heimcloud-ops-worker [--once] | --push-pending <job scratch dir> | --kick | --pr-poll | --check-token");
    return 2;
  }
  const cfg = config();
  if (argv.includes("--check-token")) return checkToken(cfg);
  if (argv.includes("--pr-poll")) {
    try {
      const out = prPoll(cfg);
      if (out.skipped) log(`pr-poll: skipped (${out.skipped})`);
      else for (const o of out) log(`pr-poll incident ${o.incident_id}: ${o.event || o.skipped || `error: ${o.error}`}`);
    } catch (err) {
      console.error(`heimcloud-ops-worker: pr-poll failed: ${err.message || err}`);
    }
    return 0;
  }
  const pi = argv.indexOf("--push-pending");
  if (pi >= 0) {
    const dir = argv[pi + 1];
    if (!dir) {
      console.error("usage: heimcloud-ops-worker --push-pending <job scratch dir>");
      return 2;
    }
    const fd = tryLock(cfg.lock);
    if (fd == null) {
      log("lock busy; another worker is running");
      return 1;
    }
    try {
      const scratch = path.resolve(dir);
      const result = pushPending(cfg, scratch);
      if (result.incident_id) {
        writeResult(cfg, path.join(scratch, `push-${path.basename(scratch)}-${Date.now()}.json`), result);
      }
      log(`push-pending incident ${result.incident_id}: ${result.status}`);
      return ["compare_ready", "awaiting_lab_test"].includes(result.status) ? 0 : 1;
    } catch (err) {
      console.error(`heimcloud-ops-worker: push-pending failed: ${err.message || err}`);
      return 1;
    } finally {
      unlock(fd, cfg.lock);
    }
  }
  if (argv.includes("--kick")) {
    kick(cfg);
    return 0;
  }
  if (!enabledKinds(cfg).length) {
    log("no job kinds enabled (OPS_AUTOFIX_TRIAGE / OPS_AUTOFIX_FIX); exiting");
    return 0;
  }
  mkdirs(cfg);
  let fd = null;
  const lockInfo = {};
  try {
    fd = tryLock(cfg.lock, lockInfo);
  } catch (err) {
    console.error(`heimcloud-ops-worker: cannot take lock: ${err.code || err.message}`);
    return 0;
  }
  if (fd == null) {
    log("lock busy; another worker is running");
    return 0;
  }
  try {
    drain(cfg, lockInfo);
  } catch (err) {
    // Per-job problems never fail the unit (a failed oneshot + start limit
    // would wedge the path trigger); the panel shows the issue instead.
    console.error(`heimcloud-ops-worker: ${err.stack || err.message || err}`);
    try {
      addIssue(cfg, "worker_error", `Worker run aborted: ${shortSummary(err.message || err, 160)}`);
      updateStatus(cfg, { state: "idle", pid: undefined, job: null });
    } catch {
      /* ignore */
    }
  } finally {
    currentJob = null;
    unlock(fd, cfg.lock);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const si = process.argv.indexOf("--supervise");
  if (si >= 0) superviseMain(process.argv[si + 1]);
  else process.exitCode = main();
}
