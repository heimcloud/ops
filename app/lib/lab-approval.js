/**
 * Admin approval of a protected lab test (the fix touches ops / Hermes / swag
 * / base system while the lab shares the ops host).
 *
 * The app signs the approved job (HMAC-SHA256) with a key under
 * <data>/private/ (dir 0700, key 0400, owned by the ops container uid). The
 * worker and Hermes run as the hermes user: they can read the queue and the
 * DB but not this key, so they cannot mint an approval. The root lab runner
 * reads the key (checking owner + mode), recomputes the signature from the job
 * spec and its own instance name, and also requires the matching
 * lab_approved event in the DB.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir, queueDir, ensureDir, findPendingJobs, isAutofixKindEnabled, QueueError } from "./queue.js";
import { labApprovalMessage, normalizeProtected } from "./lab-checks.js";
import { addIncidentEvent, updateIncident } from "./db.js";

export class ApprovalKeyError extends Error {
  constructor(message) {
    super(message);
    this.code = "approval_key";
    this.status = 500;
  }
}

export function approvalKeyPath() {
  return path.join(getDataDir(), "private", "lab-approval.key");
}

function ownUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Load (or create on first use) the approval key; refuses a key it does not own exclusively. */
export function loadApprovalKey() {
  const file = approvalKeyPath();
  const dir = path.dirname(file);
  const uid = ownUid();
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== "EEXIST") throw new ApprovalKeyError(`cannot create ${dir} (${err.code})`);
  }
  const d = fs.lstatSync(dir);
  if (!d.isDirectory() || (uid != null && d.uid !== uid) || (d.mode & 0o077) !== 0) {
    throw new ApprovalKeyError("approval key dir has the wrong owner or mode (expected the ops uid, 0700)");
  }
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o400, flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw new ApprovalKeyError(`cannot create the approval key (${err.code})`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (uid != null && st.uid !== uid) || (st.mode & 0o077) !== 0 || st.size < 32 || st.size > 256) {
      throw new ApprovalKeyError("approval key has the wrong owner, mode or size (expected the ops uid, 0400)");
    }
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8").trim();
  } finally {
    fs.closeSync(fd);
  }
}

/** Signature over the job identity (see labApprovalMessage). */
export function signApproval(fields, key = loadApprovalKey()) {
  return crypto.createHmac("sha256", key).update(labApprovalMessage(fields)).digest("hex");
}

const BRANCH_RE = /^(fix|ops)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const FIX_JOB_RE = /^fix-\d+-[A-Za-z0-9-]+$/;
const COMPARE_RE = /^https:\/\/github\.com\/[^\s<>"']+$/;

function refuse(code, message, status = 409) {
  return Object.assign(new QueueError(code, message), { status });
}

/**
 * The fix waiting for an admin decision on its protected lab test, taken from
 * the DB only (latest fix_result), or null. The incident must still be
 * needs_human: approving / skipping moves it on, so a second click is refused.
 */
export function labApprovalSource(incident, latestFixEvent) {
  if (!incident || incident.status !== "needs_human") return null;
  const m = latestFixEvent?.meta;
  if (!m || m.status !== "lab_approval_needed") return null;
  const branch = String(m.branch || "");
  if (!BRANCH_RE.test(branch) || branch.includes("..")) return null;
  if (!SHA_RE.test(String(m.head_sha || ""))) return null;
  const prot = normalizeProtected(m.protected);
  if (!prot) return null;
  return {
    event_id: latestFixEvent.id,
    branch,
    head_sha: m.head_sha,
    base_sha: typeof m.base_sha === "string" && /^[0-9a-f]{7,64}$/.test(m.base_sha) ? m.base_sha : undefined,
    fix_job: FIX_JOB_RE.test(String(m.fix_job || m.job || "")) ? String(m.fix_job || m.job) : undefined,
    attempt: Math.max(1, Math.floor(Number(m.attempt) || 1)),
    max_attempts: Number(m.max_attempts) || undefined,
    compare_url: COMPARE_RE.test(String(m.pending_compare_url || "")) ? m.pending_compare_url : undefined,
    pr_title: typeof m.pr_title === "string" ? m.pr_title.slice(0, 300) : undefined,
    pr_body: typeof m.pr_body === "string" ? m.pr_body.slice(0, 20000) : undefined,
    protected: prot,
  };
}

function writeJobAtomic(dest, job) {
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  fs.renameSync(tmp, dest);
}

/**
 * Admin approved the protected lab test: lab_approved event (the runner looks
 * it up) + signed lab job in queue/lab. Only this admin route writes approvals;
 * the worker refuses to enqueue a protected lab job itself.
 */
export function approveProtectedLab(incident, src, { now = new Date() } = {}) {
  if (!isAutofixKindEnabled("lab")) {
    throw refuse("autofix_disabled", "Automated lab testing is not enabled on this host (autofix.lab.enable).");
  }
  if (!src) throw refuse("no_lab_approval", `Incident #${incident.id} has no protected fix waiting for a lab approval.`);
  const pending = [...findPendingJobs("lab", incident.id), ...findPendingJobs("fix", incident.id)];
  if (pending.length) throw refuse("already_queued", `A job for incident #${incident.id} is already queued or running (${path.basename(pending[0])}).`);
  const key = loadApprovalKey(); // fail before writing anything
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const name = `${incident.id}-${ts}.json`;
  const instance = `lab-${incident.id}-${ts}`;
  const approvedAt = now.toISOString();
  const eventId = Number(addIncidentEvent(
    incident.id,
    "lab_approved",
    `Admin approved the lab test of protected change (${src.protected.label})${src.protected.core ? " — BASE SYSTEM" : ""}; lab job ${instance} queued`,
    {
      job_file: name,
      job_kind: "lab",
      lab_job: instance,
      branch: src.branch,
      head_sha: src.head_sha,
      protected: src.protected,
      approved_by: "admin",
      approved_at: approvedAt,
      fix_event_id: src.event_id,
    },
  ).id);
  try {
    const sig = signApproval({ incident_id: incident.id, instance, branch: src.branch, head_sha: src.head_sha, event_id: eventId, approved_at: approvedAt }, key);
    const job = {
      job_version: 1,
      kind: "lab",
      incident_id: incident.id,
      report_hash: incident.report_hash,
      unit: incident.unit,
      severity: incident.severity,
      class: incident.class,
      neo_version: incident.neo_version,
      logs_excerpt: incident.logs_excerpt,
      branch: src.branch,
      fix_job: src.fix_job,
      attempt: src.attempt,
      max_attempts: src.max_attempts,
      compare_url: src.compare_url,
      pr_title: src.pr_title,
      pr_body: src.pr_body,
      base_sha: src.base_sha,
      head_sha: src.head_sha,
      protected: src.protected,
      approved_by: "admin",
      approval: { v: 1, by: "admin", event_id: eventId, approved_at: approvedAt, sig },
      enqueued_at: approvedAt,
      enqueued_by: "admin",
    };
    const dir = queueDir("lab");
    ensureDir(dir);
    const dest = path.join(dir, name);
    writeJobAtomic(dest, job);
    updateIncident(incident.id, { status: "testing" });
    return { path: dest, job, event_id: eventId, instance };
  } catch (err) {
    addIncidentEvent(incident.id, "job_cancelled", `Approved lab job could not be queued (${err.code || err.message}); approve again`, {
      job_file: name,
      job_kind: "lab",
      approval_failed: true,
    });
    throw err;
  }
}

/** Admin skipped the lab test: Awaiting PR with a "not lab-tested" warning. */
export function skipProtectedLab(incident, src) {
  if (!src) throw refuse("no_lab_approval", `Incident #${incident.id} has no protected fix waiting for a lab approval.`);
  if (!src.compare_url) throw refuse("no_compare_url", `Incident #${incident.id} has no compare link for the pushed branch.`);
  updateIncident(incident.id, { status: "pr_opened", compare_url: src.compare_url });
  const eventId = Number(addIncidentEvent(
    incident.id,
    "lab_skipped",
    `Admin skipped the lab test of protected change (${src.protected.label}); compare link opened — NOT lab-tested`,
    { compare_url: src.compare_url, branch: src.branch, head_sha: src.head_sha, protected: src.protected, warning: "not lab-tested", by: "admin" },
  ).id);
  return { compare_url: src.compare_url, event_id: eventId };
}
