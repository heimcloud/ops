/**
 * Worker + queue state for the admin (read side) and queue control actions
 * (write side). The host worker and this container share only the exchange
 * dirs under OPS_DATA_DIR, so everything goes through files:
 *   queue/worker-status.json   worker heartbeat / stage / last run / issues
 *   queue/systemd-status.json  unit health, written by the root kick timer
 *   queue/control/*            pause flag, priority sidecar, cancel flags
 * Every free-text field is passed through the display redactor by the caller
 * (models carry raw strings only in *Raw fields that are never rendered).
 */
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./queue.js";
import {
  KINDS,
  PRIORITIES,
  STALE_HEARTBEAT_SEC_DEFAULT,
  listPending,
  readPriorityFile,
  writePriorityFile,
  applyMove,
  prunePriorityJobs,
  readPause,
  setPaused,
  cancelFile,
  reasonFile,
  atomicWriteJson,
  isValidJobName,
  jobKey,
  controlDir,
} from "./queue-control.js";

export const STAGE_LABELS = {
  claimed: "Starting",
  cloning: "Cloning neo",
  hermes: "Hermes",
  checks: "Gates / checks",
  push: "Pushing",
  lab: "Lab test",
  result: "Writing result",
};

export const ISSUE_LABELS = {
  poison_quarantined: "Poison job quarantined",
  requeued_after_crash: "Requeued after crash",
  malformed_job: "Malformed job",
  results_unwritable: "Results not writable",
  queue_unwritable: "Queue not writable",
  hermes_killed: "Hermes timeout (group killed)",
  job_cancelled: "Job cancelled",
  stale_lock: "Stale lock reclaimed",
  worker_error: "Worker error",
};

const STATUS_RE = /^[a-z][a-z_]{0,40}$/;
const safeToken = (s, fallback = "unknown") => (STATUS_RE.test(String(s || "")) ? String(s) : fallback);

export function queueRoot() {
  return path.join(getDataDir(), "queue");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function parseTime(s) {
  const t = Date.parse(String(s || ""));
  return Number.isFinite(t) ? t : null;
}

const zTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const zDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });

/** "14:05" today, else "2026-09-29 14:05" (Europe/Zurich). */
export function zurichShort(ms, now = Date.now()) {
  if (ms == null) return "";
  const d = new Date(ms);
  const t = zTime.format(d);
  return zDay.format(d) === zDay.format(new Date(now)) ? t : `${zDay.format(d)} ${t}`;
}

/** Compact age for tables: "now", "4m", "5h", "3d". */
export function agoLabel(sec) {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "42s", "5m", "3h 10m", "2d". */
export function durationLabel(sec) {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

export function staleAfterSec() {
  const v = Number(process.env.OPS_WORKER_STALE_SEC || STALE_HEARTBEAT_SEC_DEFAULT);
  return Number.isFinite(v) && v >= 30 ? v : STALE_HEARTBEAT_SEC_DEFAULT;
}

const UNIT_WORDS = {
  "active/waiting": "watching",
  "active/running": "triggered",
  "inactive/dead": "idle",
  "activating/start": "running",
  "activating/start-pre": "starting",
  "deactivating/stop": "stopping",
};

function unitModel(u, { mustBeActive = false } = {}) {
  if (!u || typeof u !== "object") return { state: "unknown", label: "unknown", ok: false, limit: false };
  const active = safeToken(u.active_state);
  const sub = safeToken(u.sub_state, "");
  const result = safeToken(u.result, "");
  const limit = /limit_hit|limit-hit/.test(String(u.result || ""));
  const failed = active === "failed" || limit;
  // A oneshot service is healthy when inactive (idle) or activating (running).
  // The path watch must be active; the oneshot service is fine idle or running.
  const ok = !failed && (mustBeActive ? active === "active" : ["active", "inactive", "activating", "reloading"].includes(active));
  const raw = `${active}${sub ? `/${sub}` : ""}`;
  const label = limit ? String(u.result).replace(/[^a-z-]/g, "") : failed ? `failed${result && result !== "success" ? ` (${result})` : ""}` : UNIT_WORDS[raw] || raw;
  return { state: failed ? (limit ? "start-limit" : "failed") : active, label, ok, limit, changedAt: parseTime(u.changed_at) };
}

/**
 * @param {{ redact?: (s:string)=>string, now?: number, caps?: object }} opts
 */
export function workerModel({ redact = (s) => s, now = Date.now(), caps = {} } = {}) {
  const root = queueRoot();
  const st = readJson(path.join(root, "worker-status.json")) || {};
  const sys = readJson(path.join(root, "systemd-status.json"));
  const pause = readPause(root);
  const staleSec = staleAfterSec();
  const enabled = Boolean(caps.triage || caps.fix);
  const v2 = Number(st.version) >= 2;
  const hb = parseTime(st.heartbeat_at);
  const hbAge = hb == null ? null : Math.max(0, (now - hb) / 1000);
  let state = v2 ? safeToken(st.state) : "unknown";
  if (!["idle", "running", "paused"].includes(state)) state = "unknown";
  const stale = state === "running" && (hbAge == null || hbAge > staleSec);
  const job = state === "running" && st.job && typeof st.job === "object" ? st.job : null;
  const jobModel = job
    ? {
        kind: KINDS.includes(job.kind) ? job.kind : "job",
        incidentId: Number(job.incident_id) || null,
        name: isValidJobName(job.name) ? job.name : "",
        stage: Object.hasOwn(STAGE_LABELS, job.stage) ? job.stage : "working",
        stageLabel: STAGE_LABELS[job.stage] || "Working",
        attempt: Number(job.attempt) || null,
        maxAttempts: Number(job.max_attempts) || null,
        startedAt: parseTime(job.started_at),
        stageAt: parseTime(job.stage_at),
        claims: Number(job.claims) || 1,
        priority: PRIORITIES.includes(job.priority) ? job.priority : "normal",
        cancelRequested: Boolean(job.processing && isProcessingName(job.processing) && fs.existsSync(cancelFile(root, job.processing))),
        processing: isProcessingName(job.processing) ? job.processing : "",
      }
    : null;
  if (jobModel) {
    jobModel.elapsedSec = jobModel.startedAt ? (now - jobModel.startedAt) / 1000 : null;
    jobModel.stageText = `${jobModel.stageLabel}${jobModel.stage === "hermes" && jobModel.attempt ? ` ${jobModel.attempt}/${jobModel.maxAttempts || "?"}` : ""}`;
    jobModel.startedLabel = zurichShort(jobModel.startedAt, now);
  }
  const lr = st.last_run && typeof st.last_run === "object" ? st.last_run : null;
  const lastRun = lr
    ? {
        kind: KINDS.includes(lr.kind) ? lr.kind : "job",
        incidentId: Number(lr.incident_id) || null,
        status: safeToken(lr.status),
        ok: Boolean(lr.ok),
        reason: lr.reason ? safeToken(lr.reason) : null,
        finishedAt: parseTime(lr.finished_at),
        finishedLabel: zurichShort(parseTime(lr.finished_at), now),
        ageSec: parseTime(lr.finished_at) ? (now - parseTime(lr.finished_at)) / 1000 : null,
        summary: redact(String(lr.summary || "")).slice(0, 240),
      }
    : null;
  const issues = (Array.isArray(st.issues) ? st.issues : [])
    .slice()
    .sort((a, b) => (parseTime(b?.at) || 0) - (parseTime(a?.at) || 0))
    .slice(0, 10)
    .map((i) => ({
    code: safeToken(i?.code),
    label: ISSUE_LABELS[i?.code] || "Worker note",
    message: redact(String(i?.message || "")).slice(0, 240),
    at: parseTime(i?.at),
    atLabel: zurichShort(parseTime(i?.at), now),
    ageSec: parseTime(i?.at) ? (now - parseTime(i?.at)) / 1000 : null,
    incidentId: Number(i?.incident_id) || null,
  }));
  const tokenKnown = typeof st.fork_push_token === "boolean";
  let systemd = { present: false, stale: true, health: "unknown", label: "no host report" };
  if (sys && typeof sys === "object") {
    const checked = parseTime(sys.checked_at);
    const age = checked ? (now - checked) / 1000 : null;
    const pathU = unitModel(sys.units?.path, { mustBeActive: true });
    const svcU = unitModel(sys.units?.service);
    const wedged = !pathU.ok || !svcU.ok;
    const limit = pathU.limit || svcU.limit;
    systemd = {
      present: true,
      checkedAt: checked,
      checkedLabel: zurichShort(checked, now),
      ageSec: age,
      stale: age == null || age > 15 * 60,
      path: pathU,
      service: svcU,
      health: limit ? "start-limit" : wedged ? "failed" : "ok",
      label: limit ? "start limit hit" : !pathU.ok && pathU.state !== "failed" ? "path watch inactive" : wedged ? "unit failed" : "healthy",
      lastActions: (Array.isArray(sys.last_actions) ? sys.last_actions : []).slice(0, 3).map((a) => ({
        action: safeToken(String(a?.action || "").replace(/-/g, "_")).replace(/_/g, "-"),
        units: (Array.isArray(a?.units) ? a.units : []).filter((u) => /^heimcloud-ops-worker\.(path|service)$/.test(u)),
        ok: Boolean(a?.ok),
      })),
      lastActionAt: parseTime(sys.last_action_at),
      lastActionLabel: zurichShort(parseTime(sys.last_action_at), now),
    };
  }
  let display = state;
  if (!enabled) display = "off";
  else if (stale) display = "stale";
  else if (state !== "running" && pause) display = "paused";
  return {
    enabled,
    present: v2,
    state,
    display,
    stale,
    staleAfterSec: staleSec,
    heartbeatAt: hb,
    heartbeatAgeSec: hbAge,
    heartbeatSec: Number(st.heartbeat_sec) || 30,
    job: jobModel,
    lastRun,
    issues,
    token: tokenKnown ? { known: true, ok: st.fork_push_token, checkedAt: parseTime(st.checked_at) } : { known: false, ok: false },
    hermesTimeoutSec: Number(st.hermes_timeout_sec) || null,
    labTimeoutSec: Number(st.lab_timeout_sec) || null,
    maxAttempts: Number(st.max_attempts) || null,
    kinds: (Array.isArray(st.kinds) ? st.kinds : []).filter((k) => KINDS.includes(k)),
    paused: pause ? { at: parseTime(pause.paused_at), atLabel: zurichShort(parseTime(pause.paused_at), now) } : null,
    systemd,
  };
}

function isProcessingName(n) {
  const m = /^(triage|fix|push)-(.+)$/.exec(String(n || ""));
  return Boolean(m && isValidJobName(m[2]));
}

function resultFor(name) {
  const dir = path.join(getDataDir(), "results");
  for (const f of [`${name}`.replace(/\.json$/, ".ingested.json"), name, `${name}`.replace(/\.json$/, ".rejected.json")]) {
    const r = readJson(path.join(dir, f));
    if (r) return r;
  }
  return null;
}

function listBucket(bucket, limit) {
  const dir = path.join(queueRoot(), bucket);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!f.endsWith(".json") || f.endsWith(".reason.json") || f.includes(".tmp-")) continue;
    if (!isProcessingName(f)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {
      continue;
    }
    out.push({ f, mtime });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/**
 * @returns {{ pending, processing, done, failed, paused, counts }}
 */
export function queueModel({ redact = (s) => s, now = Date.now(), caps = {}, recent = 15, worker = null } = {}) {
  const root = queueRoot();
  const enabledKind = (k) => (k === "triage" ? Boolean(caps.triage) : Boolean(caps.fix));
  const pending = listPending(root).map((j, i) => ({
    kind: j.kind,
    name: j.name,
    key: j.key,
    incidentId: Number(/^(\d+)-/.exec(j.name)?.[1]) || null,
    priority: j.priority,
    explicit: j.explicit,
    position: i + 1,
    enqueuedAt: j.enqueuedAt,
    enqueuedLabel: zurichShort(j.enqueuedAt, now),
    ageSec: (now - j.enqueuedAt) / 1000,
    kindEnabled: enabledKind(j.kind),
  }));
  const processing = [];
  try {
    for (const f of fs.readdirSync(path.join(root, "processing"))) {
      if (!f.endsWith(".json") || f.includes(".tmp-") || !isProcessingName(f)) continue;
      const m = /^(triage|fix|push)-((\d+)-.+)$/.exec(f);
      const job = readJson(path.join(root, "processing", f)) || {};
      const claimedAt = parseTime(job._claimed_at);
      const running = worker?.job?.processing === f ? worker.job : null;
      processing.push({
        kind: m[1],
        name: f,
        jobName: m[2],
        incidentId: Number(m[3]),
        claims: Number(job._claims) || 1,
        claimedAt,
        claimedLabel: zurichShort(claimedAt, now),
        elapsedSec: claimedAt ? (now - claimedAt) / 1000 : null,
        stageText: running ? running.stageText : worker?.stale ? "no heartbeat" : "claimed",
        cancelRequested: fs.existsSync(cancelFile(root, f)),
      });
    }
  } catch {
    /* no processing dir yet */
  }
  const finished = (bucket) =>
    listBucket(bucket, recent).map(({ f, mtime }) => {
      const m = /^(triage|fix|push)-((\d+)-.+)$/.exec(f);
      const reason = readJson(reasonFile(path.join(root, bucket), f));
      const res = resultFor(f);
      return {
        kind: m[1],
        name: f,
        incidentId: Number(m[3]),
        finishedAt: mtime,
        finishedLabel: zurichShort(mtime, now),
        ageSec: (now - mtime) / 1000,
        status: res ? safeToken(res.status) : null,
        code: reason ? safeToken(reason.code) : null,
        reason: reason ? redact(String(reason.reason || "")).slice(0, 200) : "",
        summary: res ? redact(String(res.summary || "")).slice(0, 240) : "",
        retriedAt: reason?.retried_at ? parseTime(reason.retried_at) : null,
        retriedLabel: reason?.retried_at ? zurichShort(parseTime(reason.retried_at), now) : "",
        canRetry: bucket === "failed" && !reason?.retried_at && enabledKind(m[1]),
      };
    });
  const failed = finished("failed");
  const done = finished("done");
  const dayAgo = now - 24 * 3600 * 1000;
  return {
    pending,
    processing,
    done,
    failed,
    paused: readPause(root),
    counts: {
      pending: pending.length,
      triage: pending.filter((j) => j.kind === "triage").length,
      fix: pending.filter((j) => j.kind === "fix").length,
      push: pending.filter((j) => j.kind === "push").length,
      processing: processing.length,
      failed24h: failed.filter((j) => j.finishedAt >= dayAgo && !j.retriedAt).length,
    },
  };
}

// ------------------------------------------------------------------ actions

export class QueueActionError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function assertJob(kind, name) {
  if (!KINDS.includes(kind) || !isValidJobName(name)) throw new QueueActionError("invalid_job", "Unknown job.", 400);
}

function pendingJob(kind, name) {
  assertJob(kind, name);
  const pend = listPending(queueRoot());
  const j = pend.find((x) => x.key === jobKey(kind, name));
  if (!j) throw new QueueActionError("not_pending", "That job is no longer pending (claimed by the worker or removed).");
  return { job: j, pending: pend };
}

export function pauseQueue(paused) {
  fs.mkdirSync(controlDir(queueRoot()), { recursive: true });
  setPaused(queueRoot(), paused);
  return { paused: Boolean(readPause(queueRoot())) };
}

export function setJobPriority(kind, name, priority) {
  if (!PRIORITIES.includes(priority)) throw new QueueActionError("invalid_priority", "Priority must be high, normal or low.", 400);
  const { job, pending } = pendingJob(kind, name);
  const prio = readPriorityFile(queueRoot());
  const jobs = prunePriorityJobs(prio.jobs, pending);
  // A priority change resets the manual rank of this job (it joins the new group by age).
  jobs[job.key] = { priority };
  writePriorityFile(queueRoot(), { jobs });
  return { incidentId: Number(/^(\d+)-/.exec(name)[1]), from: job.priority, to: priority };
}

export function moveJob(kind, name, direction) {
  if (!["up", "down", "top", "bottom"].includes(direction)) throw new QueueActionError("invalid_direction", "Direction must be up, down, top or bottom.", 400);
  const { job, pending } = pendingJob(kind, name);
  const prio = readPriorityFile(queueRoot());
  const from = pending.findIndex((j) => j.key === job.key) + 1;
  const jobs = applyMove(pending, prio.jobs, job.key, direction);
  writePriorityFile(queueRoot(), { jobs });
  const after = listPending(queueRoot());
  const to = after.findIndex((j) => j.key === job.key) + 1;
  return { incidentId: Number(/^(\d+)-/.exec(name)[1]), from, to, priority: after[to - 1]?.priority || job.priority, priorityFrom: job.priority };
}

/** Pending job -> failed/<kind>-<name> (atomic rename; a concurrent claim wins). */
export function cancelPendingJob(kind, name) {
  assertJob(kind, name);
  const root = queueRoot();
  const src = path.join(root, kind, name);
  const destName = `${kind}-${name}`;
  const dest = path.join(root, "failed", destName);
  fs.mkdirSync(path.join(root, "failed"), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === "ENOENT") throw new QueueActionError("not_pending", "That job is no longer pending (the worker may have claimed it).");
    throw err;
  }
  try {
    atomicWriteJson(reasonFile(path.join(root, "failed"), destName), { code: "cancelled", reason: "cancelled by admin while pending", at: new Date().toISOString() });
  } catch {
    /* best effort */
  }
  try {
    const prio = readPriorityFile(root);
    writePriorityFile(root, { jobs: prunePriorityJobs(prio.jobs, listPending(root)) });
  } catch {
    /* best effort */
  }
  return { incidentId: Number(/^(\d+)-/.exec(name)[1]), failedName: destName };
}

/** Raise the cancel flag the worker checks between stages and while Hermes runs. */
export function requestCancelRunning(processingName) {
  if (!isProcessingName(processingName)) throw new QueueActionError("invalid_job", "Unknown job.", 400);
  const root = queueRoot();
  if (!fs.existsSync(path.join(root, "processing", processingName))) {
    throw new QueueActionError("not_running", "That job is not running any more.");
  }
  fs.mkdirSync(controlDir(root), { recursive: true });
  atomicWriteJson(cancelFile(root, processingName), { requested_at: new Date().toISOString() });
  const m = /^(triage|fix|push)-(\d+)-/.exec(processingName);
  return { kind: m[1], incidentId: Number(m[2]) };
}

/** What to re-enqueue for a failed entry (the caller enqueues + records the event). */
export function failedJobInfo(failedName) {
  if (!isProcessingName(failedName)) throw new QueueActionError("invalid_job", "Unknown job.", 400);
  const root = queueRoot();
  const file = path.join(root, "failed", failedName);
  if (!fs.existsSync(file)) throw new QueueActionError("not_failed", "That failed job no longer exists.", 404);
  const reason = readJson(reasonFile(path.join(root, "failed"), failedName));
  if (reason?.retried_at) throw new QueueActionError("already_retried", "That job was already retried.");
  const m = /^(triage|fix|push)-(\d+)-/.exec(failedName);
  const job = readJson(file);
  return { kind: m[1], incidentId: Number(m[2]), pushJob: m[1] === "push" ? String(job?.job || "") : null };
}

export function markRetried(failedName, newJobFile) {
  const dir = path.join(queueRoot(), "failed");
  const prev = readJson(reasonFile(dir, failedName)) || { code: "failed", reason: "" };
  try {
    atomicWriteJson(reasonFile(dir, failedName), { ...prev, retried_at: new Date().toISOString(), retried_as: newJobFile });
  } catch {
    /* best effort */
  }
}
