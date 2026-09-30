/**
 * Lab-test check schema, shared by the host worker (validates Hermes's plan),
 * the root lab runner (re-validates before executing anything) and the ops app
 * (renders the per-check results). One source: app/lib/lab-checks.js;
 * scripts/autofix/lab-checks.js is a symlink to it and the worker package
 * copies this file (a test enforces both). Only plain JS, no imports.
 *
 * Hermes may only choose from these check types. Every field is validated and
 * nothing is ever passed to a shell: units are matched by a strict regex,
 * journal patterns are literal substrings (no regex, no ReDoS), HTTP checks
 * only GET loopback or a named docker container's address.
 */

export const LAB_CHECK_TYPES = ["unit_active", "journal_absent", "http_status"];
export const MAX_LAB_CHECKS = 12;

/** Generic checks the runner always adds (not choosable by Hermes). */
export const GENERIC_CHECKS = [
  { id: "activate", type: "activate", label: "Activation exits 0 (exit 4 only if just the user bus failed)" },
  { id: "failed_units", type: "failed_units", label: "No failed units (systemctl --failed)" },
  { id: "system_running", type: "system_running", label: "systemctl is-system-running = running" },
  { id: "ops_health", type: "ops_health", label: "Ops /health returns 200" },
  { id: "hermes_active", type: "hermes_active", label: "Hermes service active" },
];

export const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,120}\.(service|socket|timer|target|path|mount)$/;
export const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** Optional per-check id (the worker's validated plan carries c1…; Hermes may set its own). */
export const CHECK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const LAB_BRANCH_RE = /^(fix|ops)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export const LAB_INSTANCE_RE = /^lab-[0-9]{1,9}-[A-Za-z0-9-]{1,80}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Coarse progress steps shown on the Testing card, and which runner stages belong to each. */
export const LAB_PHASES = ["Build", "Watchdog", "Activate", "Checks", "Roll back", "Restored"];
const PHASE_OF = {
  queued: 0, planning: 0, starting: 0, validating: 0, waiting_lock: 0, building: 0,
  arming_watchdog: 1, activating: 2, settling: 2, checks: 3, rolling_back: 4, verifying: 4, restored: 5, done: 5,
};
export function labPhase(stage) {
  return Object.hasOwn(PHASE_OF, stage) ? PHASE_OF[stage] : null;
}

export const LAB_STAGE_LABELS = {
  queued: "Queued",
  planning: "Planning checks",
  starting: "Starting lab unit",
  validating: "Validating",
  waiting_lock: "Waiting for activation lock",
  building: "Building",
  arming_watchdog: "Arming watchdog",
  activating: "Activating",
  settling: "Settling",
  checks: "Checks",
  rolling_back: "Rolling back",
  verifying: "Verifying restore",
  restored: "Restored",
  done: "Done",
};

// Every type accepts the optional "id" and "label" fields. validateCheckPlan's
// output must pass validateCheckPlan again unchanged: the worker validates
// Hermes's plan and writes it (ids included) to the job spec, and the root
// runner re-validates that spec with this same function.
const COMMON_KEYS = ["type", "id", "label"];
const KEYS = {
  unit_active: [...COMMON_KEYS, "unit"],
  journal_absent: [...COMMON_KEYS, "unit", "pattern"],
  http_status: [...COMMON_KEYS, "url", "container", "port", "path", "expect_status", "contains"],
};
const GENERIC_IDS = new Set(GENERIC_CHECKS.map((g) => g.id));

function str(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
}

export function isValidBranch(b) {
  return typeof b === "string" && b.length <= 120 && LAB_BRANCH_RE.test(b) && !b.includes("..") && !/\.lock(\/|$)/.test(b);
}

export function isValidInstance(i) {
  return typeof i === "string" && LAB_INSTANCE_RE.test(i);
}

/** Validate one check; returns {check} or {error}. Unknown keys are rejected. */
export function validateCheck(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "check must be an object" };
  const type = raw.type;
  if (!LAB_CHECK_TYPES.includes(type)) return { error: `unknown check type ${JSON.stringify(String(type)).slice(0, 40)}` };
  const extra = Object.keys(raw).filter((k) => !KEYS[type].includes(k));
  if (extra.length) return { error: `${type}: unexpected field(s) ${extra.slice(0, 3).join(", ")}` };
  const out = { type };
  if (raw.id != null) {
    if (typeof raw.id !== "string" || !CHECK_ID_RE.test(raw.id)) return { error: `${type}: id must be 1-32 chars of A-Z a-z 0-9 _ -` };
    out.id = raw.id;
  }
  if (raw.label != null) {
    if (!str(raw.label, 100)) return { error: `${type}: label must be a short single-line string` };
    out.label = raw.label;
  }
  if (type === "unit_active" || type === "journal_absent") {
    // A bare name ("docker-x") means the .service unit, like defaultChecks.
    const unit = typeof raw.unit === "string" && /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,110}$/.test(raw.unit) && !UNIT_RE.test(raw.unit) ? `${raw.unit}.service` : raw.unit;
    if (!str(unit, 128) || !UNIT_RE.test(unit)) return { error: `${type}: invalid unit name` };
    out.unit = unit;
  }
  if (type === "journal_absent") {
    if (!str(raw.pattern, 200) || raw.pattern.trim().length < 4) return { error: "journal_absent: pattern must be 4-200 chars, single line" };
    out.pattern = raw.pattern;
  }
  if (type === "http_status") {
    const hasUrl = raw.url != null;
    const hasContainer = raw.container != null;
    if (hasUrl === hasContainer) return { error: "http_status: give exactly one of url (loopback) or container" };
    if (hasUrl) {
      if (!str(raw.url, 300)) return { error: "http_status: invalid url" };
      let u;
      try {
        u = new URL(raw.url);
      } catch {
        return { error: "http_status: invalid url" };
      }
      if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || u.username || u.password) {
        return { error: "http_status: url must be plain http on loopback" };
      }
      if (raw.port != null || raw.path != null) return { error: "http_status: port/path only with container" };
      out.url = u.toString();
    } else {
      if (!str(raw.container, 63) || !CONTAINER_RE.test(raw.container)) return { error: "http_status: invalid container name" };
      const port = Number(raw.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "http_status: container needs a port 1-65535" };
      const p = raw.path == null ? "/" : raw.path;
      if (!str(p, 200) || !p.startsWith("/") || p.startsWith("//") || /[\s#\\]/.test(p)) return { error: "http_status: path must start with /" };
      out.container = raw.container;
      out.port = port;
      out.path = p;
    }
    if (raw.expect_status != null) {
      const s = Number(raw.expect_status);
      if (!Number.isInteger(s) || s < 100 || s > 599) return { error: "http_status: expect_status must be 100-599" };
      out.expect_status = s;
    } else out.expect_status = 200;
    if (raw.contains != null) {
      if (!str(raw.contains, 200)) return { error: "http_status: contains must be a short single-line string" };
      out.contains = raw.contains;
    }
  }
  return { check: out };
}

/**
 * Validate a Hermes check plan ({checks:[…]} or a bare array). Invalid entries
 * are dropped with a reason ("#N: why", N = 1-based position in the plan);
 * duplicates are dropped; at most MAX_LAB_CHECKS. Every kept check gets an id:
 * a valid supplied one is kept unless already taken or equal to a generic
 * check's id, otherwise c<N>. A malformed id drops the check (like any bad field).
 * Idempotent: validateCheckPlan(validateCheckPlan(p).checks) keeps all checks.
 * @returns {{checks: object[], errors: string[]}}
 */
export function validateCheckPlan(plan) {
  const list = Array.isArray(plan) ? plan : Array.isArray(plan?.checks) ? plan.checks : null;
  const errors = [];
  if (!list) return { checks: [], errors: ["plan has no checks array"] };
  const checks = [];
  const seen = new Set();
  list.forEach((raw, i) => {
    const r = validateCheck(raw);
    if (r.error) {
      errors.push(`#${i + 1}: ${r.error}`);
      return;
    }
    const key = JSON.stringify({ ...r.check, id: undefined, label: undefined });
    if (seen.has(key)) return;
    if (checks.length >= MAX_LAB_CHECKS) {
      errors.push(`#${i + 1}: more than ${MAX_LAB_CHECKS} checks`);
      return;
    }
    seen.add(key);
    checks.push(r.check);
  });
  const used = new Set(GENERIC_IDS);
  const withIds = checks.map((c) => {
    const { id, ...rest } = c;
    return { want: id && !used.has(id) ? (used.add(id), id) : null, rest };
  });
  let n = 0;
  const nextId = () => {
    do n += 1;
    while (used.has(`c${n}`));
    used.add(`c${n}`);
    return `c${n}`;
  };
  return { checks: withIds.map(({ want, rest }) => ({ id: want || nextId(), ...rest })), errors };
}

/** Deterministic fallback when Hermes gives no usable plan: the incident unit must be active. */
export function defaultChecks(unit) {
  const u = String(unit || "");
  const name = u && !/\.[a-z]+$/.test(u) ? `${u}.service` : u;
  return UNIT_RE.test(name) ? [{ id: "c1", type: "unit_active", unit: name, label: `${name} active` }] : [];
}

/** Human label for a check (display text still goes through the app's redactor). */
export function checkLabel(c) {
  if (!c) return "";
  if (c.label) return String(c.label);
  switch (c.type) {
    case "unit_active":
      return `${c.unit} active`;
    case "journal_absent":
      return `${c.unit}: no "${c.pattern}" since activation`;
    case "http_status":
      return c.container ? `${c.container}:${c.port}${c.path} → ${c.expect_status}` : `${c.url} → ${c.expect_status}`;
    default: {
      const g = GENERIC_CHECKS.find((x) => x.type === c.type);
      return g ? g.label : String(c.type || "check");
    }
  }
}

/**
 * Normalize a lab report (from a result file / DB event) for display. Only
 * known fields with bounded sizes survive; free text is left to the caller's
 * redactor.
 */
export function normalizeLabReport(r) {
  if (!r || typeof r !== "object") return null;
  const verdicts = ["pass", "fail", "error", "cancelled"];
  const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
  const checks = (Array.isArray(r.checks) ? r.checks : []).slice(0, 40).map((c) => ({
    id: typeof c?.id === "string" ? c.id.slice(0, 40) : "",
    type: typeof c?.type === "string" ? c.type.slice(0, 40) : "",
    generic: Boolean(c?.generic),
    label: String(c?.label || checkLabel(c) || "").slice(0, 200),
    ok: c?.ok === true ? true : c?.ok === false ? false : null,
    detail: typeof c?.detail === "string" ? c.detail.slice(0, 400) : "",
  }));
  const g = r.generation && typeof r.generation === "object" ? r.generation : {};
  return {
    verdict: verdicts.includes(r.verdict) ? r.verdict : "error",
    failedStage: typeof r.failed_stage === "string" ? r.failed_stage.slice(0, 40) : "",
    reason: typeof r.reason === "string" ? r.reason.slice(0, 400) : "",
    checks,
    passed: checks.filter((c) => c.ok === true).length,
    failed: checks.filter((c) => c.ok === false).length,
    generation: {
      before: n(g.before),
      after: n(g.after),
      labToplevel: typeof g.lab_toplevel === "string" ? g.lab_toplevel.slice(0, 80) : "",
      restored: g.restored === true,
      bootedUnchanged: g.booted_unchanged !== false,
    },
    pinsIdentical: r.pins?.identical === true,
    pinsRestored: r.pins?.restored === true,
    watchdog: {
      armed: r.watchdog?.armed === true,
      disarmed: r.watchdog?.disarmed === true,
      fired: r.watchdog?.fired === true,
      deadlineSec: n(r.watchdog?.deadline_sec),
    },
    // Protected-path run (admin-approved): what was protected, the quick
    // post-activation probe and the service check after the rollback.
    protected: normalizeProtectedRun(r.protected),
    protectedProbe: normalizeSvcPair(r.protected_probe, "ops_health", "hermes_active"),
    postRollbackServices: normalizeSvcPair(r.post_rollback_services),
    servicesUnhealthy: r.services_unhealthy === true,
    servicesReason: typeof r.services_reason === "string" ? r.services_reason.slice(0, 200) : "",
    activationExit: n(r.activation?.exit_code),
    testedRev: /^[0-9a-f]{7,40}$/.test(String(r.tested_rev || "")) ? r.tested_rev : "",
    startedAt: typeof r.started_at === "string" ? r.started_at : "",
    finishedAt: typeof r.finished_at === "string" ? r.finished_at : "",
    durationSec: n(r.duration_sec),
    planSource: ["hermes", "default"].includes(r.plan_source) ? r.plan_source : "",
    planNotes: (Array.isArray(r.plan_notes) ? r.plan_notes : []).slice(0, 8).map((s) => String(s).slice(0, 200)),
    // Checks the runner itself dropped while re-validating the job spec.
    planErrors: (Array.isArray(r.plan_errors) ? r.plan_errors : []).slice(0, 8).map((s) => String(s).slice(0, 200)),
    activationWarning: typeof r.activation?.warning === "string" ? r.activation.warning.slice(0, 200) : "",
    evidence: (Array.isArray(r.evidence) ? r.evidence : []).slice(0, 30).map((s) => String(s).slice(0, 300)),
  };
}

/**
 * Wrap a redactor so systemd unit names and file names ("docker-x.service",
 * "flake.lock") are not mistaken for host names by its FQDN rule. Every other
 * rule of the wrapped redactor still applies (same trick as the app's display
 * redactor).
 */
const SAFE_SUFFIX = /(?<=[A-Za-z0-9_-])\.(service|timer|socket|mount|target|slice|path|json|log|patch|nix|toml|lock)\b/g;
const PH = "\uE001"; // distinct from the display redactor's own placeholder, so both compose
export function keepUnitNames(redact) {
  return (text) => {
    const s = String(text ?? "").split(PH).join("");
    return String(redact(s.replace(SAFE_SUFFIX, `${PH}$1`))).split(PH).join(".");
  };
}

// ------------------------------------------------------------ protected paths

/**
 * Protected paths (lab shares the ops host): a fix touching them may take down
 * ops, Hermes, the worker or the base system during the lab activation. Such a
 * fix is still written and pushed, but the lab test only runs after an admin
 * approval. Base-system prefixes get a stronger warning.
 */
export const DEFAULT_PROTECTED_PATHS = ["nix/services/ops", "nix/services/hermes", "nix/services/swag", "nix/modules/core"];
export const DEFAULT_BASE_PATHS = ["nix/modules/core"];

export function normalizePathPrefixes(list) {
  return [].concat(list || [])
    .map((s) => String(s).trim().replace(/^\.?\/+/, "").replace(/\/+$/, ""))
    .filter((s) => s && !s.split("/").includes(".."));
}

/** Prefixes (of `prefixes`) that any of `files` lies under (path prefix, not substring). */
export function protectedPrefixesHit(files, prefixes) {
  const hit = new Set();
  for (const f of files || []) {
    const norm = String(f).replace(/^\.?\/+/, "");
    for (const d of prefixes || []) if (norm === d || norm.startsWith(`${d}/`)) hit.add(d);
  }
  return [...hit];
}

/** {areas, paths, core, label} for display: "hermes", "base system", … */
export function describeProtected(paths, basePaths = DEFAULT_BASE_PATHS) {
  const ps = [...new Set(normalizePathPrefixes(paths))].slice(0, 8);
  const areas = [...new Set(ps.map((p) => (basePaths.includes(p) ? "base system" : p.split("/").pop())))];
  return { areas, paths: ps, core: ps.some((p) => basePaths.includes(p)), label: areas.join(", ") };
}

/** Sanitized protected info from a result / job (never trusts shapes). */
export function normalizeProtected(p) {
  if (!p || typeof p !== "object") return null;
  const paths = normalizePathPrefixes(Array.isArray(p.paths) ? p.paths : []).filter((x) => /^[A-Za-z0-9._/-]{1,120}$/.test(x));
  const areas = (Array.isArray(p.areas) ? p.areas : []).map(String).filter((a) => /^[A-Za-z0-9 ._-]{1,40}$/.test(a)).slice(0, 8);
  if (!paths.length && !areas.length) return null;
  return { areas, paths: paths.slice(0, 8), core: p.core === true, label: areas.join(", ") || paths.join(", ") };
}

/**
 * Canonical message the app signs (HMAC-SHA256, key only the ops container
 * uid can read) when an admin approves a protected lab test. The root runner
 * recomputes it from the job spec + its own instance name.
 */
export function labApprovalMessage({ incident_id, instance, branch, head_sha, event_id, approved_at }) {
  return [
    "heimcloud-ops-lab-approval-v1",
    String(Number(incident_id)),
    String(instance),
    String(branch),
    String(head_sha),
    String(Number(event_id)),
    String(approved_at),
  ].join("\n");
}

function normalizeProtectedRun(p) {
  const base = normalizeProtected(p) || (p && typeof p === "object" && (p.unknown || p.claimed) ? { areas: [], paths: [], core: false, label: "unverified" } : null);
  if (!base) return null;
  return {
    ...base,
    approved: p.approved === true,
    approvalEventId: Number.isInteger(Number(p.approval_event_id)) && p.approval_event_id != null ? Number(p.approval_event_id) : null,
    unknown: p.unknown === true,
  };
}

/** {ops, hermes} service states from a probe / post-rollback record. */
function normalizeSvcPair(s) {
  if (!s || typeof s !== "object") return null;
  const one = (v, flat) => {
    if (v && typeof v === "object") return { ok: v.ok === true, detail: typeof v.detail === "string" ? v.detail.slice(0, 120) : "", restarted: v.restarted === true };
    if (typeof v === "boolean") return { ok: v, detail: typeof flat === "string" ? flat.slice(0, 120) : "", restarted: false };
    return null;
  };
  const ops = one(s.ops_health, s.ops_detail);
  const hermes = one(s.hermes_active, s.hermes_detail);
  if (!ops && !hermes) return null;
  return { ops, hermes };
}
