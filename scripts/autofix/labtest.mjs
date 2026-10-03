#!/usr/bin/env node
/**
 * heimcloud-ops-labtest — automated lab test of a pushed fix branch (ROOT).
 *
 * The only privileged piece of the autofix loop. Started as
 *   systemctl start heimcloud-ops-labtest@<instance>.service
 * by the worker (user hermes, allowed for exactly that unit pattern by a polkit
 * rule). Everything it acts on is validated here again; the job spec is data,
 * never code.
 *
 *   --run <instance>       lab-<incident>-<ts>; spec = <ops>/queue/processing/<instance>.json
 *   --watchdog <file>      fired by the transient systemd timer armed before
 *                          activation: rolls back if the runner did not disarm it
 *
 * Flow (--run): validate spec → lab lock (one lab at a time) → Neo system lock
 * (flock /run/neo/locks/system.lock, the lock neo activate/update/auto-update
 * take, + a holder file for Neo's "Blocked: …" message) → record generations +
 * pin files (flake.lock, flake.nix, settings.toml) → build the host config
 * with ONLY the neo input overridden to the fork branch (--override-input,
 * --no-write-lock-file) → arm watchdog → switch-to-configuration test (never
 * touches the boot loader or the system profile) → settle → generic +
 * incident checks → ALWAYS switch back to the recorded previous system →
 * verify current/profile/booted system + byte-identical pins (restore from
 * backup if not) → disarm watchdog → result.json.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GENERIC_CHECKS,
  checkLabel,
  isValidBranch,
  isValidInstance,
  validateCheckPlan,
  UNIT_RE,
  CONTAINER_RE,
  keepUnitNames,
  labApprovalMessage,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_BASE_PATHS,
  normalizePathPrefixes,
  describeProtected,
} from "./lab-checks.js";
import { redactIdentifyingDetails, getExtraRedactSlugs } from "./redact.js";
import { cancelRequested } from "./queue-control.js";
import { parseTargets, findTarget, readTargetsFile } from "./targets.js";

const SELF = fileURLToPath(import.meta.url);
const SAFE_ENV_DROP = ["GH_TOKEN", "GITHUB_TOKEN", "GH_PR_TOKEN", "OPS_GITHUB_TOKEN", "NIX_CONFIG"];

const num = (v, d, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v != null ? Math.max(min, n) : d;
};

export function labConfig(env = process.env) {
  const activateSec = num(env.LABTEST_ACTIVATE_TIMEOUT_SEC, 900, 1);
  const settleMaxSec = num(env.LABTEST_SETTLE_MAX_SEC, 180, 0);
  const checkSec = num(env.LABTEST_CHECK_TIMEOUT_SEC, 60, 0);
  const rollbackSec = num(env.LABTEST_ROLLBACK_TIMEOUT_SEC, 900, 1);
  const systemLock = env.LABTEST_SYSTEM_LOCK || "/run/neo/locks/system.lock";
  return {
    opsDir: env.LABTEST_OPS_DIR || "/var/neo/DATA/AppData/ops",
    stateDir: env.LABTEST_STATE_DIR || "/var/lib/heimcloud-ops-labtest",
    flake: env.LABTEST_FLAKE || "/var/neo/DATA/AppData/configuration",
    nixosConfig: env.LABTEST_NIXOS_CONFIG || "neo",
    input: env.LABTEST_INPUT || "neo",
    flakeUrl: env.LABTEST_FLAKE_URL || "github:heimcloud/neo/{branch}",
    pinFiles: String(env.LABTEST_PIN_FILES || "flake.lock,flake.nix,settings.toml")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.includes("/") && s !== ".." && s !== "."),
    systemLock,
    neoLockDir: env.LABTEST_NEO_LOCK_DIR || path.dirname(systemLock),
    lockWaitSec: num(env.LABTEST_LOCK_WAIT_SEC, 1800, 0),
    buildSec: num(env.LABTEST_BUILD_TIMEOUT_SEC, 3600, 1),
    activateSec,
    settleSec: num(env.LABTEST_SETTLE_SEC, 30, 0),
    settleMaxSec,
    checkSec,
    rollbackSec,
    // Deadline for the independent watchdog, counted from arming.
    watchdogSec: num(env.LABTEST_WATCHDOG_SEC, activateSec + settleMaxSec + 8 * checkSec + rollbackSec + 300, 5),
    killGraceSec: num(env.LABTEST_KILL_GRACE_SEC, 30, 0),
    opsHealth: env.LABTEST_OPS_HEALTH || "container:ops:3000/health",
    hermesUnit: env.LABTEST_HERMES_UNIT || "hermes-agent.service",
    profile: env.LABTEST_PROFILE || "/nix/var/nix/profiles/system",
    current: env.LABTEST_CURRENT || "/run/current-system",
    booted: env.LABTEST_BOOTED || "/run/booted-system",
    storePrefix: env.LABTEST_STORE_PREFIX || "/nix/store/",
    nix: env.LABTEST_NIX_BIN || "nix",
    systemctl: env.LABTEST_SYSTEMCTL_BIN || "systemctl",
    systemdRun: env.LABTEST_SYSTEMD_RUN_BIN || "systemd-run",
    journalctl: env.LABTEST_JOURNALCTL_BIN || "journalctl",
    flock: env.LABTEST_FLOCK_BIN || "flock",
    docker: env.LABTEST_DOCKER_BIN || "docker",
    node: env.LABTEST_NODE_BIN || process.execPath,
    self: env.LABTEST_SELF || SELF,
    unitPrefix: env.LABTEST_UNIT_PREFIX || "heimcloud-ops-labtest",
    pollMs: num(env.LABTEST_POLL_MS, 2000, 10),
    // ---- protected runs (fix touches ops / Hermes / swag / base system)
    labSharesOps: !["0", "false", "no", "off"].includes(String(env.LABTEST_SHARES_OPS_HOST ?? "true").toLowerCase()),
    protectedPaths: normalizePathPrefixes(String(env.LABTEST_PROTECTED_PATHS || DEFAULT_PROTECTED_PATHS.join(",")).split(",")),
    // Allowlisted targets (same JSON as OPS_TARGETS); unset = neo only (legacy).
    targets: env.LABTEST_TARGETS || env.LABTEST_TARGETS_FILE ? parseTargets(env.LABTEST_TARGETS || readTargetsFile(env.LABTEST_TARGETS_FILE)) : null,
    basePaths: normalizePathPrefixes(String(env.LABTEST_BASE_PATHS || DEFAULT_BASE_PATHS.join(",")).split(",")),
    // Shorter independent watchdog deadline for approved protected runs.
    protectedWatchdogSec: num(env.LABTEST_PROTECTED_WATCHDOG_SEC, 600, 60),
    // After activation: how long ops /health + Hermes may take before an immediate rollback.
    protectedProbeSec: num(env.LABTEST_PROTECTED_PROBE_SEC, 45, 0),
    // Stop checks this long before the watchdog deadline (leaves time for the rollback).
    protectedMarginSec: num(env.LABTEST_PROTECTED_MARGIN_SEC, 150, 0),
    // After rollback: wait this long for ops /health + Hermes (before and after a restart).
    recoverSec: num(env.LABTEST_RECOVER_SEC, 120, 0),
    opsUnit: /^[A-Za-z0-9@._:-]+\.service$/.test(env.LABTEST_OPS_UNIT || "") ? env.LABTEST_OPS_UNIT : "docker-ops.service",
    // Approval check: HMAC key only the ops container uid can read + the DB event.
    opsUid: /^\d+$/.test(String(env.LABTEST_OPS_UID ?? "")) ? Number(env.LABTEST_OPS_UID) : null,
    dbPath: env.LABTEST_DB_PATH || path.join(env.LABTEST_OPS_DIR || "/var/neo/DATA/AppData/ops", "ops.sqlite"),
    sqlite: env.LABTEST_SQLITE_BIN || "sqlite3",
    approvalMaxAgeSec: num(env.LABTEST_APPROVAL_MAX_AGE_SEC, 3 * 86400, 60),
  };
}

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const slugs = () => {
  try {
    return getExtraRedactSlugs();
  } catch {
    return [];
  }
};
/** Evidence redaction (fail closed: the app and worker redact again). Unit names stay readable. */
export function red(text) {
  return keepUnitNames((t) => redactIdentifyingDetails(t, { knownSlugs: slugs() }))(text);
}
function tailLines(s, n = 20, width = 240) {
  return String(s || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .map((l) => (l.length > width ? `${l.slice(0, width)}…` : l));
}

function writeJson(file, obj, mode = 0o640) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode, flag: "wx" });
  fs.renameSync(tmp, file);
}

function readJsonNoFollow(file, maxBytes = 512 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > maxBytes) throw new Error("file too large");
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return JSON.parse(buf.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** "system-123-link" → 123 (the profile's generation), else null. */
export function profileGeneration(profile) {
  try {
    const m = /^system-(\d+)-link$/.exec(path.basename(fs.readlinkSync(profile)));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Run a command in its own process group; on timeout SIGTERM the group, then
 * SIGKILL after the grace period. Never throws.
 */
export function runCmd(cmd, args, { timeoutSec = 600, graceSec = 30, env, cwd, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    const cleanEnv = { ...(env || process.env) };
    for (const k of SAFE_ENV_DROP) delete cleanEnv[k];
    try {
      child = spawn(cmd, args, { cwd, env: cleanEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: "", error: err.code || String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    child.stdout.on("data", (d) => {
      if (stdout.length < maxBytes) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < maxBytes) stderr += d;
    });
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), graceSec * 1000);
    }, timeoutSec * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ status: null, stdout, stderr, error: err.code || String(err), timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      kill("SIGKILL"); // stragglers of the group
      resolve({ status: code, signal, stdout, stderr, error: null, timedOut, truncated: stdout.length >= maxBytes || stderr.length >= maxBytes });
    });
  });
}

/**
 * Hold an flock(2) through util-linux flock(1): resolves once the lock is held
 * ({ok:true, release}) or when it could not be taken ({ok:false, code}).
 * The helper lives in its own process group; release() kills it (the kernel
 * drops the lock with it, also if this process dies: same unit cgroup).
 */
export function holdFlock(cfg, file, { shared = false, waitSec = 0 } = {}) {
  return new Promise((resolve) => {
    const args = [shared ? "-s" : "-x", ...(waitSec > 0 ? ["-w", String(waitSec)] : ["-n"]), "-E", "75", file, "-c", "echo LOCKED; exec sleep infinity"];
    let child;
    try {
      child = spawn(cfg.flock, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, code: null, error: String(err) });
      return;
    }
    let done = false;
    let err = "";
    const release = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    };
    child.stdout.on("data", (d) => {
      if (!done && String(d).includes("LOCKED")) {
        done = true;
        resolve({ ok: true, release, pid: child.pid });
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      if (!done) {
        done = true;
        resolve({ ok: false, code: null, error: e.code || String(e) });
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        resolve({ ok: false, code, error: err.trim().slice(0, 200) });
      }
    });
  });
}

/**
 * Neo's operation-lock holder file (<lockdir>/<id>.holder, flocked by its
 * holder) so `neo activate` / the web UI say "Blocked: Ops lab test … in
 * progress" instead of a generic message. Best effort: the system.lock flock
 * alone decides.
 */
async function writeNeoHolder(cfg, incidentId) {
  const id = `${process.pid}-labtest`;
  const tmp = path.join(cfg.neoLockDir, `.${id}.tmp`);
  const file = path.join(cfg.neoLockDir, `${id}.holder`);
  try {
    const holder = {
      id,
      scopes: [{ scope: "system", mode: "ex" }],
      kind: "lab_test",
      label: `Ops lab test (incident #${incidentId})`,
      pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
    };
    fs.writeFileSync(tmp, JSON.stringify(holder), { mode: 0o644 });
    const lk = await holdFlock(cfg, tmp);
    if (!lk.ok) {
      fs.rmSync(tmp, { force: true });
      return null;
    }
    fs.renameSync(tmp, file);
    return () => {
      fs.rmSync(file, { force: true });
      lk.release();
    };
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Snapshot pin files (bytes + owner/mode) into the instance dir. */
export function snapshotPins(cfg, dir) {
  const out = [];
  for (const name of cfg.pinFiles) {
    const p = path.join(cfg.flake, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      out.push({ name, exists: false });
      continue;
    }
    if (!st.isFile()) {
      out.push({ name, exists: true, skipped: "not a regular file" });
      continue;
    }
    const buf = fs.readFileSync(p);
    const backup = path.join(dir, `pin-${name}`);
    fs.writeFileSync(backup, buf, { mode: 0o600 });
    out.push({ name, exists: true, sha256: sha256(buf), backup, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid });
  }
  return out;
}

/** Compare pins with the snapshot; restore any changed file from its backup. */
export function verifyPins(cfg, snap) {
  const files = [];
  let identical = true;
  let restoredAll = true;
  for (const s of snap) {
    const p = path.join(cfg.flake, s.name);
    if (s.skipped) {
      files.push({ name: s.name, identical: true, note: s.skipped });
      continue;
    }
    let now = null;
    try {
      now = fs.readFileSync(p);
    } catch {
      now = null;
    }
    const same = s.exists ? now !== null && sha256(now) === s.sha256 : now === null;
    if (same) {
      files.push({ name: s.name, identical: true });
      continue;
    }
    identical = false;
    let restored = false;
    try {
      if (s.exists) {
        const tmp = `${p}.labtest-restore-${process.pid}`;
        fs.writeFileSync(tmp, fs.readFileSync(s.backup), { mode: s.mode });
        try {
          fs.chownSync(tmp, s.uid, s.gid);
        } catch {
          /* non-root tests */
        }
        fs.renameSync(tmp, p);
      } else {
        fs.rmSync(p, { force: true });
      }
      const after = s.exists ? fs.readFileSync(p) : null;
      restored = s.exists ? sha256(after) === s.sha256 : !fs.existsSync(p);
    } catch {
      restored = false;
    }
    if (!restored) restoredAll = false;
    files.push({ name: s.name, identical: false, restored });
  }
  return { identical, restored: !identical && restoredAll, ok: identical || restoredAll, files };
}

function isSystemPath(cfg, p) {
  return typeof p === "string" && p.startsWith(cfg.storePrefix) && !p.includes("..") && fs.existsSync(path.join(p, "bin", "switch-to-configuration"));
}

async function systemctl(cfg, args, timeoutSec = 60) {
  return runCmd(cfg.systemctl, args, { timeoutSec, graceSec: 5 });
}

async function failedUnits(cfg) {
  const r = await systemctl(cfg, ["--failed", "--plain", "--no-legend", "--no-pager"]);
  return String(r.stdout || "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && UNIT_RE.test(u.replace(/^●/, "")))
    .map((u) => u.replace(/^●/, ""));
}

/** Failed units with their load state ("not-found" = not in the running config). */
async function failedUnitsDetailed(cfg) {
  const r = await systemctl(cfg, ["--failed", "--plain", "--no-legend", "--no-pager"]);
  return String(r.stdout || "")
    .split("\n")
    .map((l) => l.trim().replace(/^●\s*/, "").split(/\s+/))
    .filter((p) => p[0] && UNIT_RE.test(p[0]))
    .map((p) => ({ unit: p[0], load: p[1] || "" }));
}

/**
 * After a verified rollback: units that only existed in the lab system stay
 * listed as failed ("not-found") and would leave the host degraded; reset
 * exactly those. A unit of the restored system that is still failed is
 * reported, never hidden.
 */
async function cleanupLabFailures(cfg, run, result, preFailed) {
  const pre = new Set(preFailed || []);
  const now = (await failedUnitsDetailed(cfg)).filter((u) => !pre.has(u.unit));
  const labOnly = now.filter((u) => u.load === "not-found").map((u) => u.unit);
  const still = now.filter((u) => u.load !== "not-found").map((u) => u.unit);
  if (labOnly.length) {
    await systemctl(cfg, ["reset-failed", "--", ...labOnly]);
    run.note(`reset-failed lab-only units after rollback: ${labOnly.join(", ")}`);
  }
  if (still.length) run.note(`still failed after rollback (was fine before the test): ${still.join(", ")}`);
  result.post_rollback = { reset_lab_only: labOnly, still_failed: still };
}

async function systemState(cfg) {
  const r = await systemctl(cfg, ["is-system-running"]);
  return String(r.stdout || "").trim().split("\n")[0] || "unknown";
}

async function isActive(cfg, unit) {
  const r = await systemctl(cfg, ["is-active", unit]);
  return String(r.stdout || "").trim().split("\n")[0] || "unknown";
}

async function containerUrl(cfg, container, port, p) {
  if (!CONTAINER_RE.test(container)) return { error: "invalid container" };
  const r = await runCmd(cfg.docker, ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container], { timeoutSec: 20, graceSec: 5 });
  const ip = String(r.stdout || "").trim().split(/\s+/).find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
  if (!ip) return { error: `container ${container} has no address (docker inspect exit ${r.status})` };
  return { url: `http://${ip}:${port}${p}` };
}

async function httpOnce(url, { expect = 200, contains = null, timeoutMs = 10_000 } = {}) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const body = contains ? (await res.text()).slice(0, 256 * 1024) : "";
    if (!contains) await res.body?.cancel?.().catch(() => {});
    const ok = res.status === expect && (!contains || body.includes(contains));
    return { ok, detail: `HTTP ${res.status}${contains && res.status === expect && !ok ? " (expected text missing)" : ""}` };
  } catch (err) {
    return { ok: false, detail: `request failed (${err.name === "TimeoutError" ? "timeout" : err.cause?.code || err.name})` };
  }
}

/** Retry an async probe until ok or the check timeout elapses. */
async function until(cfg, probe, run) {
  const deadline = Date.now() + cfg.checkSec * 1000;
  let last;
  for (;;) {
    last = await probe();
    if (last.ok || Date.now() >= deadline || run.stopping) return last;
    await sleep(Math.min(cfg.pollMs, Math.max(10, deadline - Date.now())));
  }
}

// ------------------------------------------------------------------ run

function instanceDir(cfg, instance) {
  return path.join(cfg.stateDir, instance);
}

function makeRun(cfg, instance) {
  const dir = instanceDir(cfg, instance);
  const run = {
    cfg,
    instance,
    dir,
    stopping: false,
    startedAt: nowIso(),
    status: { instance, stage: "validating", started_at: nowIso(), pid: process.pid },
    releases: [],
    evidence: [],
  };
  run.setStage = (stage, extra = {}) => {
    run.status = { ...run.status, stage, step: undefined, steps: undefined, ...extra, updated_at: nowIso() };
    try {
      writeJson(path.join(dir, "status.json"), run.status);
    } catch {
      /* status is informational */
    }
  };
  run.note = (line) => {
    for (const l of [].concat(line)) if (l) run.evidence.push(red(l).slice(0, 300));
  };
  return run;
}

/** Validate + load the job spec the worker left in queue/processing. */
export function loadSpec(cfg, instance) {
  if (!isValidInstance(instance)) throw Object.assign(new Error("invalid instance name"), { code: "invalid_spec" });
  const file = path.join(cfg.opsDir, "queue", "processing", `${instance}.json`);
  let spec;
  try {
    spec = readJsonNoFollow(file);
  } catch (err) {
    throw Object.assign(new Error(`job spec unreadable (${err.code || err.message})`), { code: "invalid_spec" });
  }
  const incidentId = Number(/^lab-(\d+)-/.exec(instance)[1]);
  if (spec?.kind !== "lab") throw Object.assign(new Error("job spec is not a lab job"), { code: "invalid_spec" });
  if (Number(spec.incident_id) !== incidentId) throw Object.assign(new Error("job spec incident does not match instance"), { code: "invalid_spec" });
  if (!isValidBranch(spec.branch)) throw Object.assign(new Error("invalid fix branch"), { code: "invalid_spec" });
  // The commit the worker gated (identity, deny-list, redaction) before push.
  // The root only activates that exact tip (checked after the build).
  if (!/^[0-9a-f]{40}$/.test(String(spec.head_sha || ""))) throw Object.assign(new Error("job spec has no gated commit (head_sha)"), { code: "invalid_spec" });
  const plan = validateCheckPlan(spec.lab_checks || []);
  return {
    incidentId,
    branch: spec.branch,
    headSha: spec.head_sha,
    checks: plan.checks,
    planErrors: plan.errors,
    processingName: `${instance}.json`,
    // Written by the app on an admin approval (verified in verifyApproval).
    approval: spec.approval && typeof spec.approval === "object" ? spec.approval : null,
    claimsProtected: Boolean(spec.protected),
    targetRepo: typeof spec.target_repo === "string" && spec.target_repo ? spec.target_repo : null,
  };
}

/** Root flake inputs whose locked/original github source is one of the slugs. */
export function matchInputs(locks, slugs) {
  const want = new Set(slugs.map((x) => String(x).toLowerCase()));
  const root = locks?.nodes?.[locks.root || "root"];
  const out = [];
  for (const [name, ref] of Object.entries(root?.inputs || {})) {
    if (typeof ref !== "string") continue; // follows
    const n = locks.nodes[ref];
    for (const src of [n?.locked, n?.original]) {
      if (src && src.type === "github" && want.has(`${src.owner}/${src.repo}`.toLowerCase())) {
        out.push(name);
        break;
      }
    }
  }
  return out;
}

/**
 * Lab settings for the job's target: input / flake URL / protected paths. The
 * neo entry keeps the LABTEST_INPUT / _FLAKE_URL / _PROTECTED_PATHS values.
 * Other targets: their flakeInput, or (null) the one root input of the host
 * flake whose source is the upstream or the fork. Fail closed: unknown
 * target, lab = "none", 0 or >1 matching inputs → error, nothing built.
 */
export async function resolveLabTarget(cfg, spec) {
  if (!cfg.targets) {
    if (spec.targetRepo && spec.targetRepo.toLowerCase() !== "madebydamo/neo") return { ok: false, reason: `target ${spec.targetRepo} is not configured on the lab runner (LABTEST_TARGETS unset)` };
    return { ok: true, cfg };
  }
  const t = spec.targetRepo ? findTarget(cfg.targets, spec.targetRepo) : cfg.targets[0];
  if (!t) return { ok: false, reason: `target ${String(spec.targetRepo).slice(0, 120)} is not allowlisted` };
  if (t.lab === "none") return { ok: false, reason: `target ${t.upstream} has no lab method` };
  if (t.upstream.toLowerCase() === "madebydamo/neo") return { ok: true, cfg, target: t };
  let input = t.flakeInput;
  if (!input) {
    const hm = await runCmd(cfg.nix, ["--extra-experimental-features", "nix-command flakes", "flake", "metadata", "--json", "--no-write-lock-file", cfg.flake], { timeoutSec: 300, graceSec: cfg.killGraceSec, cwd: cfg.flake });
    let names = [];
    try {
      names = matchInputs(JSON.parse(hm.stdout).locks, [t.upstream, t.fork]);
    } catch {
      return { ok: false, reason: `could not read the host flake inputs (exit ${hm.status})` };
    }
    if (names.length !== 1) return { ok: false, reason: `${names.length ? "several" : "no"} host flake input(s) for ${t.upstream}${names.length ? ` (${names.join(", ")})` : ""}; set flakeInput on the target` };
    input = names[0];
  }
  return { ok: true, target: t, cfg: { ...cfg, input, flakeUrl: t.flakeUrl, protectedPaths: normalizePathPrefixes(t.protectedPaths), basePaths: [] } };
}

// ------------------------------------------------------------------ protected runs

/** Entries (relative path → content digest) under root/rel; null past `limit`. */
function treeDigest(root, rel, limit = 20000) {
  const out = new Map();
  const walk = (r) => {
    const abs = path.join(root, r);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return true;
    }
    if (out.size >= limit) return false;
    if (st.isSymbolicLink()) out.set(r, `l:${fs.readlinkSync(abs)}`);
    else if (st.isFile()) out.set(r, `f:${(st.mode & 0o111) ? "x" : "-"}:${sha256(fs.readFileSync(abs))}`);
    else if (st.isDirectory()) {
      out.set(r, "d");
      for (const n of fs.readdirSync(abs).sort()) if (!walk(path.join(r, n))) return false;
    }
    return true;
  };
  return walk(rel) ? out : null;
}

function sameTree(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function nixString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$\{/g, "\\${")}"`;
}

/**
 * Does activating the fork branch change a protected path on this host?
 * Worker-independent: compares the neo source the host runs now (the locked
 * input of the host flake) with the fork branch source, file by file, under
 * each protected prefix. Returns {checked, hit, unknown, paths, detail}.
 * Anything it cannot determine counts as protected (fail closed).
 */
export async function detectProtected(cfg, branch, headSha) {
  if (!cfg.labSharesOps || !cfg.protectedPaths.length) return { checked: false, hit: false, unknown: false, paths: [] };
  const nixArgs = ["--extra-experimental-features", "nix-command flakes"];
  const unknown = (detail) => ({ checked: true, hit: false, unknown: true, paths: [], detail });
  const bm = await runCmd(cfg.nix, [...nixArgs, "flake", "metadata", "--json", flakeUrlFor(cfg, branch)], { timeoutSec: 300, graceSec: cfg.killGraceSec, cwd: cfg.flake });
  let branchSrc;
  try {
    const j = JSON.parse(bm.stdout);
    branchSrc = j.path;
    const rev = j.revision || j.locked?.rev;
    if (rev !== headSha) return { ...unknown("fork branch tip is not the gated commit"), moved: /^[0-9a-f]{40}$/.test(String(rev || "")) };
  } catch {
    return unknown(`nix flake metadata of the fork branch failed (exit ${bm.status})`);
  }
  const hm = await runCmd(cfg.nix, [...nixArgs, "flake", "metadata", "--json", "--no-write-lock-file", cfg.flake], { timeoutSec: 300, graceSec: cfg.killGraceSec, cwd: cfg.flake });
  let locked;
  try {
    const locks = JSON.parse(hm.stdout).locks;
    locked = locks.nodes[locks.nodes[locks.root || "root"].inputs[cfg.input]].locked;
    if (!locked || typeof locked !== "object" || !locked.type) throw new Error("no locked input");
  } catch {
    return unknown(`could not read the host flake's locked ${cfg.input} input (exit ${hm.status})`);
  }
  const ev = await runCmd(cfg.nix, [...nixArgs, "eval", "--raw", "--expr", `(builtins.fetchTree (builtins.fromJSON ${nixString(JSON.stringify(locked))})).outPath`], {
    timeoutSec: 300,
    graceSec: cfg.killGraceSec,
    cwd: cfg.flake,
  });
  const deployedSrc = String(ev.stdout || "").trim();
  for (const [name, p] of [["fork branch", branchSrc], ["deployed", deployedSrc]]) {
    if (typeof p !== "string" || !p.startsWith(cfg.storePrefix) || p.includes("..") || !fs.existsSync(p)) return unknown(`${name} source not in the store`);
  }
  const changed = [];
  for (const prefix of cfg.protectedPaths) {
    const a = treeDigest(deployedSrc, prefix);
    const b = treeDigest(branchSrc, prefix);
    if (!a || !b) return unknown(`too many files under ${prefix}`);
    if (!sameTree(a, b)) changed.push(prefix);
  }
  return { checked: true, hit: changed.length > 0, unknown: false, paths: changed };
}

const APPROVAL_KEY_REL = path.join("private", "lab-approval.key");

/** Read the approval key; the file and its dir must belong to the ops uid, mode 0?00 / 0700. */
function readApprovalKey(cfg) {
  if (cfg.opsUid == null) return { error: "ops uid not configured (LABTEST_OPS_UID)" };
  const dir = path.join(cfg.opsDir, "private");
  const file = path.join(cfg.opsDir, APPROVAL_KEY_REL);
  try {
    const d = fs.lstatSync(dir);
    if (!d.isDirectory() || d.uid !== cfg.opsUid || (d.mode & 0o077) !== 0) return { error: "approval key dir has the wrong owner or mode" };
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== cfg.opsUid || (st.mode & 0o077) !== 0 || st.size < 32 || st.size > 256) return { error: "approval key has the wrong owner, mode or size" };
      const buf = Buffer.alloc(st.size);
      fs.readSync(fd, buf, 0, st.size, 0);
      return { key: buf.toString("utf8").trim() };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { error: `approval key unreadable (${err.code || err.message})` };
  }
}

function approvalUsedFile(cfg, eventId) {
  return path.join(cfg.stateDir, "approvals", `${Number(eventId)}.used`);
}

/**
 * Verify the admin approval of a protected lab job: HMAC over the job
 * identity (key readable only by the ops container uid, so neither Hermes nor
 * the worker can mint one), the matching lab_approved DB event, age, and
 * single use. Returns {ok, eventId} or {ok:false, missing?, reason}.
 */
export async function verifyApproval(cfg, spec, instance) {
  const a = spec.approval;
  if (!a) return { ok: false, missing: true, reason: "no admin approval in the job" };
  const eventId = Number(a.event_id);
  if (a.v !== 1 || a.by !== "admin" || !Number.isInteger(eventId) || eventId < 1 || typeof a.approved_at !== "string" || !/^[0-9a-f]{64}$/.test(String(a.sig || ""))) {
    return { ok: false, reason: "approval malformed" };
  }
  const at = Date.parse(a.approved_at);
  if (!Number.isFinite(at) || at > Date.now() + 5 * 60_000 || Date.now() - at > cfg.approvalMaxAgeSec * 1000) return { ok: false, reason: "approval expired" };
  const k = readApprovalKey(cfg);
  if (k.error) return { ok: false, reason: k.error };
  const msg = labApprovalMessage({ incident_id: spec.incidentId, instance, branch: spec.branch, head_sha: spec.headSha, event_id: eventId, approved_at: a.approved_at, target_repo: spec.targetRepo });
  const want = crypto.createHmac("sha256", k.key).update(msg).digest();
  const got = Buffer.from(a.sig, "hex");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: "approval signature invalid" };
  if (fs.existsSync(approvalUsedFile(cfg, eventId))) return { ok: false, reason: "approval already used" };
  const q = await runCmd(cfg.sqlite, ["-readonly", "-json", cfg.dbPath, `SELECT id, incident_id, kind, meta_json FROM incident_events WHERE id = ${eventId};`], { timeoutSec: 30, graceSec: 5 });
  let row;
  try {
    row = JSON.parse(String(q.stdout || "").trim() || "[]")[0];
  } catch {
    row = null;
  }
  if (q.status !== 0 || !row) return { ok: false, reason: `approval event #${eventId} not found in the ops DB` };
  let meta = {};
  try {
    meta = JSON.parse(row.meta_json || "{}") || {};
  } catch {
    meta = {};
  }
  if (row.kind !== "lab_approved" || Number(row.incident_id) !== spec.incidentId || meta.lab_job !== instance || meta.head_sha !== spec.headSha || meta.branch !== spec.branch || meta.approved_by !== "admin") {
    return { ok: false, reason: `approval event #${eventId} does not match this job` };
  }
  return { ok: true, eventId };
}

/**
 * After a (verified) rollback: ops /health must be 200 and Hermes active;
 * a service still down is restarted once (the runner is root) and checked
 * again. Never depends on ops/Hermes/the worker itself.
 */
export async function recoverServices(cfg, note) {
  const probeCfg = { ...cfg, checkSec: cfg.recoverSec };
  const quiet = { stopping: false };
  const out = {};
  const svc = [
    ["ops_health", "ops /health", cfg.opsUnit, () => opsHealth(cfg)],
    ["hermes_active", "Hermes", cfg.hermesUnit, async () => {
      const st = await isActive(cfg, cfg.hermesUnit);
      return { ok: st === "active", detail: st };
    }],
  ];
  for (const [key, name, unit, probe] of svc) {
    let r = await until(probeCfg, probe, quiet);
    if (r.ok) {
      out[key] = { ok: true, detail: r.detail, restarted: false };
      note(`after rollback: ${name} ok (${r.detail})`);
      continue;
    }
    note(`after rollback: ${name} down (${r.detail}); restarting ${unit}`);
    const rs = await systemctl(cfg, ["restart", unit], 300);
    r = await until(probeCfg, probe, quiet);
    out[key] = { ok: r.ok, detail: r.detail, restarted: true, restart_exit: rs.status };
    note(r.ok ? `after restart of ${unit}: ${name} ok (${r.detail})` : `after restart of ${unit}: ${name} STILL DOWN (${r.detail})`);
  }
  out.ok = Object.values(out).every((v) => v.ok);
  return out;
}

export function flakeUrlFor(cfg, branch) {
  return cfg.flakeUrl.replace("{branch}", branch);
}

async function build(cfg, run, branch) {
  const attr = `${cfg.flake}#nixosConfigurations.${cfg.nixosConfig}.config.system.build.toplevel`;
  const args = [
    "--extra-experimental-features",
    "nix-command flakes",
    "build",
    "--no-link",
    "--print-out-paths",
    "--no-write-lock-file",
    "--override-input",
    cfg.input,
    flakeUrlFor(cfg, branch),
    attr,
  ];
  const r = await runCmd(cfg.nix, args, { timeoutSec: cfg.buildSec, graceSec: cfg.killGraceSec, cwd: cfg.flake });
  const out = String(r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  if (r.status === 0 && isSystemPath(cfg, out)) return { ok: true, toplevel: out };
  const text = `${r.stderr}\n${r.stdout}`;
  const infra = r.timedOut || r.error || /unable to download|could not resolve|failed to connect|API rate limit|HTTP error (?:5\d\d|429)|Connection (?:timed out|refused)/i.test(text);
  return {
    ok: false,
    infra: Boolean(infra),
    reason: r.timedOut ? `build timed out after ${cfg.buildSec} s` : r.error ? `nix not runnable (${r.error})` : r.status === 0 ? "build produced no system toplevel" : `build failed (exit ${r.status})`,
    log: tailLines(r.stderr || r.stdout, 25),
  };
}

/**
 * Revision the override resolved to (same fetcher cache as the build). Used to
 * refuse activating a fork branch that moved after the worker gated it.
 */
async function resolvedRev(cfg, branch) {
  const r = await runCmd(
    cfg.nix,
    ["--extra-experimental-features", "nix-command flakes", "flake", "metadata", "--json", "--no-write-lock-file", "--override-input", cfg.input, flakeUrlFor(cfg, branch), cfg.flake],
    { timeoutSec: 300, graceSec: cfg.killGraceSec, cwd: cfg.flake },
  );
  if (r.status !== 0) return { rev: null, infra: true, detail: `nix flake metadata exit ${r.status}` };
  try {
    const locks = JSON.parse(r.stdout).locks;
    const root = locks.nodes[locks.root || "root"];
    const node = locks.nodes[root.inputs[cfg.input]];
    const rev = node?.locked?.rev;
    return /^[0-9a-f]{40}$/.test(String(rev || "")) ? { rev } : { rev: null, detail: "no locked rev for the input" };
  } catch {
    return { rev: null, detail: "unparsable flake metadata" };
  }
}

function watchdogUnit(cfg, instance) {
  return `${cfg.unitPrefix}-watchdog-${instance}`;
}

async function armWatchdog(cfg, run, act) {
  const unit = watchdogUnit(cfg, run.instance);
  const actFile = path.join(run.dir, "activation.json");
  writeJson(actFile, act);
  const r = await runCmd(
    cfg.systemdRun,
    [
      `--unit=${unit}`,
      `--description=Heimcloud Ops lab-test rollback watchdog (${run.instance})`,
      `--on-active=${Math.round(cfg.watchdogSec)}s`,
      "--timer-property=AccuracySec=1s",
      "--property=Type=oneshot",
      `--property=TimeoutStartSec=${Math.round(cfg.rollbackSec + 120)}s`,
      "--collect",
      "--quiet",
      "--",
      cfg.node,
      cfg.self,
      "--watchdog",
      actFile,
    ],
    { timeoutSec: 60, graceSec: 5 },
  );
  const state = await isActive(cfg, `${unit}.timer`);
  return { ok: r.status === 0 && state === "active", unit, detail: r.status === 0 ? `timer ${state}` : `systemd-run exit ${r.status} ${tailLines(r.stderr, 2).join(" ")}` };
}

async function disarmWatchdog(cfg, unit) {
  await systemctl(cfg, ["stop", `${unit}.timer`]);
  const state = await isActive(cfg, `${unit}.timer`);
  return !["active", "activating", "reloading"].includes(state);
}

async function switchTo(cfg, toplevel, timeoutSec) {
  return runCmd(path.join(toplevel, "bin", "switch-to-configuration"), ["test"], {
    timeoutSec,
    graceSec: cfg.killGraceSec,
    env: { ...process.env, NIXOS_INSTALL_BOOTLOADER: "0" },
  });
}

/*
 * switch-to-configuration exits 4 for "switched, but something failed". Neo's
 * own activate treats every exit 4 as success-with-warnings (user session
 * reloads). The lab is stricter: exit 4 only passes when the output shows that
 * the *only* failure was the per-user activation (typically the service user's
 * user bus /run/user/<uid>/bus not running: no lingering), and nothing at the
 * system level failed. Messages below are the ones switch-to-configuration-ng
 * prints (parent: per-user result; child: dbus / user-unit errors).
 */
const USER_ACTIVATION_FAILED = /warning: user activation for (\S+) failed/;
const USER_BUS_HINT = /Failed to open dbus connection|\/run\/user\/\d+\/bus|DBUS_SESSION_BUS_ADDRESS|org\.freedesktop\.DBus\.Error\.(NoServer|FileNotFound|NoReply|Spawn)|XDG_RUNTIME_DIR/;
// Any of these means a system-level failure: exit 4 is then a real failure.
const SYSTEM_FAILURE = [
  /warning: the following units failed:/, // (not "the following user units failed")
  /Unable to list users with logind/,
  /Failed to run activate script/,
  /Failed to install bootloader/,
  /Failed to restart sysinit-reactivation\.target/,
  // Failed to start|stop|restart|reload <unit> (system job) vs "... user unit X"
  // and the child's "Failed to restart nixos-activation.service" (user-level).
  /\bFailed to (start|stop|restart|reload|reload-or-restart|verify-start|try-restart)\s+(?!user unit\b)(?!nixos-activation\.service\b)\S/,
];

/**
 * Decide whether an exit-4 activation output is only the per-user activation
 * failing. Returns {tolerable, reason, users, userBus}.
 */
export function classifyActivationExit4(output, { truncated = false } = {}) {
  const lines = String(output || "").split("\n");
  const users = [...new Set(lines.map((l) => USER_ACTIVATION_FAILED.exec(l)?.[1]).filter(Boolean))];
  const blocker = lines.find((l) => SYSTEM_FAILURE.some((re) => re.test(l)));
  const userBus = lines.some((l) => USER_BUS_HINT.test(l));
  if (truncated) return { tolerable: false, reason: "activation output truncated", users, userBus };
  if (blocker) return { tolerable: false, reason: `system-level failure: ${blocker.trim().slice(0, 160)}`, users, userBus };
  if (!users.length) return { tolerable: false, reason: "no user-activation failure in the output (unknown exit-4 cause)", users, userBus };
  return { tolerable: true, reason: userBus ? "user bus unavailable" : "user activation failed", users, userBus };
}

async function genericChecks(cfg, run, ctx) {
  const results = [];
  const g = (type) => GENERIC_CHECKS.find((c) => c.type === type);
  const add = (type, ok, detail) => results.push({ id: g(type).id, type, generic: true, label: g(type).label, ok, detail: red(detail || "").slice(0, 400) });
  // failed_units / system_running are evaluated first: the exit-4 rule needs
  // them. The result order stays activate, failed_units, system_running.
  const failed = await failedUnits(cfg);
  const pre = new Set(ctx.pre.failed);
  const grown = failed.filter((u) => !pre.has(u));
  const tolerate = ctx.pre.state === "degraded" && grown.length === 0;
  const failedOk = failed.length === 0 || tolerate;
  const state = ctx.stateAfterSettle;
  const runningOk = state === "running" || (state === "degraded" && tolerate);
  const act = ctx.activation;
  let actOk = act.exit_code === 0 && !act.timed_out;
  let actDetail = act.timed_out ? `timed out after ${cfg.activateSec} s` : `exit ${act.exit_code}`;
  if (act.exit_code === 4 && !act.timed_out) {
    const k = ctx.exit4 || { tolerable: false, reason: "no activation output" };
    if (k.tolerable && failedOk && runningOk) {
      actOk = true;
      const what = k.userBus ? "user bus unavailable" : "user activation failed";
      actDetail = `exit 4 tolerated: ${what} (user activation failed for ${k.users.length} user(s)); no newly failed units, system ${state}`;
      act.tolerated_exit4 = true;
      act.warning = `exit 4 tolerated: ${what}`;
      run.note(`activation exit 4 tolerated: ${what}`);
    } else {
      actDetail = `exit 4 not tolerated: ${!k.tolerable ? k.reason : !failedOk ? "newly failed units after activation" : `system ${state}`}`;
    }
  }
  add("activate", actOk, actDetail);
  add("failed_units", failedOk, failed.length === 0 ? "none" : tolerate ? `${failed.length} already failed before the test: ${failed.join(", ")}` : `newly failed: ${grown.join(", ")}`);
  if (grown.length) run.note(`failed units after activation: ${grown.join(", ")}`);
  add("system_running", runningOk, state === "degraded" && tolerate ? "degraded (as before the test, no new failures)" : state);
  run.setStage("checks", { step: 3, steps: ctx.total });
  const ops = await until(cfg, () => opsHealth(cfg), run);
  add("ops_health", ops.ok, ops.detail);
  run.setStage("checks", { step: 4, steps: ctx.total });
  const h = await until(cfg, async () => {
    const s = await isActive(cfg, cfg.hermesUnit);
    return { ok: s === "active", detail: s };
  }, run);
  add("hermes_active", h.ok, h.detail);
  return results;
}

async function opsHealth(cfg) {
  const v = cfg.opsHealth;
  if (/^http:\/\//.test(v)) return httpOnce(v, { expect: 200 });
  const m = /^container:([A-Za-z0-9][A-Za-z0-9_.-]*):(\d+)(\/[^\s]*)$/.exec(v);
  if (!m) return { ok: false, detail: "ops health target misconfigured" };
  const u = await containerUrl(cfg, m[1], Number(m[2]), m[3]);
  if (u.error) return { ok: false, detail: u.error };
  return httpOnce(u.url, { expect: 200 });
}

async function incidentCheck(cfg, run, c, ctx) {
  switch (c.type) {
    case "unit_active":
      return until(cfg, async () => {
        const s = await isActive(cfg, c.unit);
        return { ok: s === "active", detail: s };
      }, run);
    case "http_status":
      return until(cfg, async () => {
        let url = c.url;
        if (c.container) {
          const u = await containerUrl(cfg, c.container, c.port, c.path);
          if (u.error) return { ok: false, detail: u.error };
          url = u.url;
        }
        return httpOnce(url, { expect: c.expect_status || 200, contains: c.contains || null });
      }, run);
    case "journal_absent": {
      const r = await runCmd(cfg.journalctl, ["-u", c.unit, "--since", `@${ctx.activatedAtSec}`, "-o", "cat", "--no-pager", "-q"], { timeoutSec: 60, graceSec: 5 });
      if (r.status !== 0 && r.status !== 1) return { ok: false, detail: `journalctl exit ${r.status}` };
      const needle = c.pattern.toLowerCase();
      const hits = String(r.stdout || "").split("\n").filter((l) => l.toLowerCase().includes(needle));
      if (hits.length) run.note(hits.slice(0, 3).map((l) => `${c.unit}: ${l.slice(0, 200)}`));
      return { ok: hits.length === 0, detail: hits.length ? `${hits.length} matching line(s) since activation` : "no matching lines since activation" };
    }
    default:
      return { ok: false, detail: "unsupported check type" };
  }
}

/**
 * The lab test. Always resolves with a result object (also written to
 * <state>/<instance>/result.json). Rollback runs in `finally` whenever an
 * activation was attempted; SIGTERM only makes it skip remaining checks.
 */
export async function runLab(cfg, instance) {
  const run = makeRun(cfg, instance);
  if (!isValidInstance(instance)) return { verdict: "error", reason: "invalid instance name" };
  fs.mkdirSync(run.dir, { recursive: true, mode: 0o750 });
  for (const f of ["result.json", "status.json", "watchdog.json", "activation.json"]) fs.rmSync(path.join(run.dir, f), { force: true });
  const onTerm = () => {
    run.stopping = true;
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);
  process.on("SIGHUP", onTerm);

  const result = {
    version: 1,
    instance,
    incident_id: null,
    branch: null,
    verdict: "error",
    failed_stage: "",
    reason: "",
    checks: [],
    plan_errors: [],
    generation: {},
    pins: {},
    watchdog: { armed: false, disarmed: false, fired: false },
    activation: {},
    started_at: run.startedAt,
  };
  let act = null;
  let pins = null;
  let wdUnit = null;
  let before = null;
  let protectedRun = false;
  try {
    run.setStage("validating");
    let spec;
    try {
      spec = loadSpec(cfg, instance);
    } catch (err) {
      result.failed_stage = "validating";
      result.reason = err.message;
      return result;
    }
    result.incident_id = spec.incidentId;
    result.branch = spec.branch;
    const lt = await resolveLabTarget(cfg, spec);
    if (!lt.ok) {
      result.failed_stage = "validating";
      result.reason = `${lt.reason}; nothing built or activated`;
      result.target_error = true;
      return result;
    }
    cfg = lt.cfg;
    result.target_repo = lt.target?.upstream || spec.targetRepo || "madebydamo/neo";
    result.flake_input = cfg.input;
    result.flake_url = flakeUrlFor(cfg, spec.branch);
    result.plan_errors = spec.planErrors.map(red);
    // A check the runner drops must be visible on the card, never vanish.
    for (const e of result.plan_errors.slice(0, 6)) run.note(`check ${e.replace(/^(#\d+):\s*/, "$1 dropped: ")}`);
    run.status.incident_id = spec.incidentId;
    const cancelled = () => cancelRequested(path.join(cfg.opsDir, "queue"), spec.processingName) || run.stopping;
    const cancel = (stage) => {
      result.verdict = "cancelled";
      result.failed_stage = stage;
      result.reason = run.stopping ? "lab unit stopped before activation" : "cancelled by admin before activation";
      return result;
    };

    // One lab at a time (independent of the worker lock).
    const labLock = await holdFlock(cfg, path.join(cfg.stateDir, "lab.lock"));
    if (!labLock.ok) {
      result.failed_stage = "validating";
      result.reason = "another lab test is running";
      result.lab_busy = true;
      return result;
    }
    run.releases.push(labLock.release);
    if (cancelled()) return cancel("validating");

    run.setStage("waiting_lock");
    fs.mkdirSync(cfg.neoLockDir, { recursive: true });
    const t0 = Date.now();
    const sys = await holdFlock(cfg, cfg.systemLock, { waitSec: cfg.lockWaitSec });
    result.lock = { waited_sec: Math.round((Date.now() - t0) / 1000) };
    if (!sys.ok) {
      result.failed_stage = "waiting_lock";
      result.reason = `Neo activation lock busy for ${cfg.lockWaitSec} s (another activation/update is running)`;
      result.lock_timeout = true;
      return result;
    }
    run.releases.push(sys.release);
    const dropHolder = await writeNeoHolder(cfg, spec.incidentId);
    if (dropHolder) run.releases.push(dropHolder);
    if (cancelled()) return cancel("waiting_lock");

    // Protected change (ops / Hermes / swag / base system)? Detected here from
    // the deployed neo source vs the fork branch, independent of what the
    // worker claims. Protected → only with a valid admin approval.
    const prot = await detectProtected(cfg, spec.branch, spec.headSha);
    if (prot.moved) {
      result.failed_stage = "validating";
      result.reason = "fix branch moved after the worker gated it (fork tip is not the gated commit); not activating";
      return result;
    }
    protectedRun = prot.hit || prot.unknown || Boolean(spec.approval) || spec.claimsProtected;
    if (protectedRun) {
      const desc = describeProtected(prot.paths, cfg.basePaths);
      if (!desc.label) Object.assign(desc, prot.unknown ? { areas: ["unverified"], label: "unverified" } : { areas: ["claimed by the job"], label: "claimed by the job" });
      result.protected = { ...desc, detected: prot.hit, unknown: prot.unknown, ...(prot.detail ? { detail: red(prot.detail).slice(0, 200) } : {}) };
      const ap = await verifyApproval(cfg, spec, instance);
      if (!ap.ok) {
        result.failed_stage = "approval";
        result[ap.missing ? "approval_required" : "approval_invalid"] = true;
        result.reason = `protected change (${desc.label}${prot.unknown ? `: ${red(prot.detail || "")}` : ""}) ${ap.missing ? "needs an admin approval" : `approval rejected: ${ap.reason}`}; nothing built or activated`;
        run.note(result.reason);
        return result;
      }
      result.protected.approved = true;
      result.protected.approval_event_id = ap.eventId;
      run.note(
        `protected run (${desc.label}${desc.core ? ", BASE SYSTEM" : ""}): approved by admin (event #${ap.eventId}); watchdog ${Math.round(cfg.protectedWatchdogSec)} s; ` +
          "ops /health or Hermes down after activation → immediate rollback; services verified after rollback",
      );
    }

    before = {
      current: realpathOrNull(cfg.current),
      profile: realpathOrNull(cfg.profile),
      profileGen: profileGeneration(cfg.profile),
      booted: realpathOrNull(cfg.booted),
    };
    result.generation = { before: before.profileGen };
    if (!isSystemPath(cfg, before.current)) {
      result.failed_stage = "validating";
      result.reason = "current system has no switch-to-configuration; refusing to test without a rollback target";
      return result;
    }
    pins = snapshotPins(cfg, run.dir);
    const pre = { failed: await failedUnits(cfg), state: await systemState(cfg) };
    before.preFailed = pre.failed;
    result.pre = { failed_units: pre.failed.length, state: pre.state };

    run.setStage("building");
    const b = await build(cfg, run, spec.branch);
    if (!b.ok) {
      result.verdict = b.infra ? "error" : "fail";
      result.failed_stage = "build";
      result.reason = b.reason;
      result.checks = [{ id: "build", type: "build", generic: true, label: "Host configuration builds with the fix branch", ok: false, detail: red(b.reason) }];
      run.note(b.log);
      return result;
    }
    const rev = await resolvedRev(cfg, spec.branch);
    result.tested_rev = rev.rev ? rev.rev.slice(0, 12) : null;
    if (rev.rev !== spec.headSha) {
      result.failed_stage = "building";
      result.reason = rev.rev
        ? "fix branch moved after the worker gated it (fork tip is not the gated commit); not activating"
        : `could not confirm the fork tip is the gated commit (${rev.detail}); not activating`;
      return result;
    }
    result.generation.lab_toplevel = path.basename(b.toplevel).slice(0, 44);
    result.generation.no_change = b.toplevel === before.current;
    if (result.generation.no_change) run.note("the fix branch does not change this host's system closure");
    if (cancelled()) return cancel("building");

    run.setStage("arming_watchdog");
    act = {
      version: 1,
      instance,
      phase: "arming",
      before: before.current,
      lab: b.toplevel,
      current_link: cfg.current,
      profile: cfg.profile,
      store_prefix: cfg.storePrefix,
      rollback_timeout_sec: cfg.rollbackSec,
      lab_unit: `${cfg.unitPrefix}@${instance}.service`,
      systemctl: cfg.systemctl,
      flock: cfg.flock,
      system_lock: cfg.systemLock,
      flake: cfg.flake,
      pins: pins.filter((p) => p.backup).map((p) => ({ name: p.name, sha256: p.sha256, backup: p.backup, mode: p.mode, uid: p.uid, gid: p.gid })),
      armed_at: nowIso(),
      deadline_sec: cfg.watchdogSec,
    };
    const wdCfg = protectedRun ? { ...cfg, watchdogSec: cfg.protectedWatchdogSec } : cfg;
    act.deadline_sec = wdCfg.watchdogSec;
    if (protectedRun) {
      Object.assign(act, { protected: true, ops_health: cfg.opsHealth, ops_unit: cfg.opsUnit, hermes_unit: cfg.hermesUnit, docker: cfg.docker, recover_sec: cfg.recoverSec });
      // Single use: consumed right before the point of no return.
      try {
        fs.mkdirSync(path.dirname(approvalUsedFile(cfg, result.protected.approval_event_id)), { recursive: true, mode: 0o750 });
        fs.writeFileSync(approvalUsedFile(cfg, result.protected.approval_event_id), `${instance}\n`, { flag: "wx", mode: 0o640 });
      } catch (err) {
        act = null;
        result.failed_stage = "approval";
        result.approval_invalid = true;
        result.reason = `approval could not be consumed (${err.code === "EEXIST" ? "already used" : err.code || err.message}); nothing activated`;
        return result;
      }
    }
    const armedAt = Date.now();
    const wd = await armWatchdog(wdCfg, run, act);
    wdUnit = wd.unit;
    result.watchdog = { armed: wd.ok, disarmed: false, fired: false, deadline_sec: Math.round(wdCfg.watchdogSec) };
    if (!wd.ok) {
      result.failed_stage = "arming_watchdog";
      result.reason = `rollback watchdog could not be armed (${wd.detail}); not activating`;
      await disarmWatchdog(cfg, wd.unit);
      act = null; // nothing activated: no rollback needed
      return result;
    }
    // Point of no return: from here on cancel is ignored until rollback.
    run.setStage("activating");
    act.phase = "activating";
    writeJson(path.join(run.dir, "activation.json"), act);
    const activatedAtSec = Math.floor(Date.now() / 1000);
    const ta = Date.now();
    const a = await switchTo(cfg, b.toplevel, cfg.activateSec);
    result.activation = { exit_code: a.status, timed_out: a.timedOut, duration_sec: Math.round((Date.now() - ta) / 1000) };
    if (a.status !== 0) run.note(tailLines(`${a.stderr}\n${a.stdout}`, 15).map((l) => `activation: ${l}`));
    const exit4 = a.status === 4 ? classifyActivationExit4(`${a.stderr}\n${a.stdout}`, { truncated: a.truncated }) : null;

    run.setStage("settling");
    if (!run.stopping) await sleep(cfg.settleSec * 1000);
    let st = await systemState(cfg);
    const settleEnd = Date.now() + cfg.settleMaxSec * 1000;
    while (["starting", "initializing"].includes(st) && Date.now() < settleEnd && !run.stopping) {
      await sleep(cfg.pollMs);
      st = await systemState(cfg);
    }

    // Protected run: ops or Hermes down after activation → roll back now,
    // do not wait for the full check timeouts.
    let abortReason = "";
    if (protectedRun && !run.stopping) {
      const quick = { ...cfg, checkSec: cfg.protectedProbeSec };
      const ops = await until(quick, () => opsHealth(cfg), run);
      const hs = await until(quick, async () => {
        const x = await isActive(cfg, cfg.hermesUnit);
        return { ok: x === "active", detail: x };
      }, run);
      result.protected_probe = { ops_health: ops.ok, ops_detail: red(ops.detail || ""), hermes_active: hs.ok, hermes_detail: red(hs.detail || "") };
      abortReason = [!ops.ok && `ops /health down (${ops.detail})`, !hs.ok && `Hermes ${hs.detail}`].filter(Boolean).join(", ");
      if (abortReason) run.note(`protected run: ${abortReason} after activation → rolling back immediately`);
    }
    // Leave room for the rollback before the watchdog would fire (margin at most half the deadline).
    const marginSec = Math.min(cfg.protectedMarginSec, wdCfg.watchdogSec / 2);
    const checkDeadline = protectedRun ? armedAt + (wdCfg.watchdogSec - marginSec) * 1000 : Infinity;

    const total = GENERIC_CHECKS.length + spec.checks.length;
    run.setStage("checks", { step: 1, steps: total });
    const checks = run.stopping ? [] : await genericChecks(abortReason ? { ...cfg, checkSec: 0 } : cfg, run, { activation: result.activation, exit4, pre, stateAfterSettle: st, total });
    let skippedNote = false;
    for (const [i, c] of spec.checks.entries()) {
      if (run.stopping) break;
      const label = red(checkLabel(c)).slice(0, 200);
      const why = abortReason ? "not run: rolled back immediately (ops/Hermes down)" : Date.now() > checkDeadline ? "not run: too close to the watchdog deadline" : "";
      if (why) {
        if (!abortReason && !skippedNote) run.note(`protected run: remaining checks skipped ${Math.round(marginSec)} s before the watchdog deadline`);
        skippedNote = true;
        checks.push({ id: c.id, type: c.type, generic: false, label, ok: false, detail: why });
        continue;
      }
      run.setStage("checks", { step: GENERIC_CHECKS.length + i + 1, steps: total });
      const r = await incidentCheck(cfg, run, c, { activatedAtSec });
      checks.push({ id: c.id, type: c.type, generic: false, label, ok: r.ok, detail: red(r.detail || "").slice(0, 400) });
    }
    result.checks = checks;
    if (abortReason && !run.stopping) {
      result.verdict = "fail";
      result.failed_stage = "checks";
      result.reason = red(`protected run: ${abortReason} after activation; rolled back immediately`).slice(0, 300);
    } else if (run.stopping) {
      result.verdict = "error";
      result.failed_stage = "checks";
      result.reason = "lab unit stopped during checks; rolled back";
    } else {
      const failed = checks.filter((c) => !c.ok);
      result.verdict = failed.length ? "fail" : "pass";
      result.failed_stage = failed.length ? (failed[0].id === "activate" ? "activating" : "checks") : "";
      result.reason = failed.length ? `${failed.length} of ${checks.length} check(s) failed: ${failed.slice(0, 4).map((c) => c.label).join("; ")}` : `all ${checks.length} checks passed`;
    }
    return result;
  } catch (err) {
    result.verdict = "error";
    result.reason = red(`lab runner error: ${err.message}`).slice(0, 300);
    return result;
  } finally {
    if (act) {
      run.setStage("rolling_back");
      const rb = await switchTo(cfg, before.current, cfg.rollbackSec);
      result.rollback = { exit_code: rb.status, timed_out: rb.timedOut };
      if (rb.status !== 0) run.note(tailLines(`${rb.stderr}\n${rb.stdout}`, 8).map((l) => `rollback: ${l}`));
      run.setStage("verifying");
      const cur = realpathOrNull(cfg.current);
      const prof = realpathOrNull(cfg.profile);
      const booted = realpathOrNull(cfg.booted);
      const restored = cur === before.current && prof === before.profile;
      result.generation = {
        ...result.generation,
        after: profileGeneration(cfg.profile),
        restored,
        booted_unchanged: booted === before.booted,
        current_restored: cur === before.current,
        profile_unchanged: prof === before.profile,
      };
      const pv = verifyPins(cfg, pins || []);
      result.pins = pv;
      if (!pv.identical) run.note(`pin files changed during the test: ${pv.files.filter((f) => !f.identical).map((f) => f.name).join(", ")} (${pv.ok ? "restored from backup" : "RESTORE FAILED"})`);
      if (restored && pv.ok) {
        result.watchdog.disarmed = await disarmWatchdog(cfg, wdUnit);
        act.phase = "restored";
        writeJson(path.join(run.dir, "activation.json"), act);
        run.setStage("restored");
        try {
          await cleanupLabFailures(cfg, run, result, before.preFailed);
        } catch {
          /* best effort; the rollback itself is verified */
        }
        if (protectedRun) {
          // The change may have taken down ops / Hermes: verify after the
          // rollback, restart what is still down (we are root), record it.
          run.setStage("verifying");
          try {
            const svc = await recoverServices(cfg, (l) => run.note(l));
            result.post_rollback_services = svc;
            if (!svc.ok) {
              result.services_unhealthy = true;
              result.services_reason = [!svc.ops_health.ok && "ops /health", !svc.hermes_active.ok && "Hermes"].filter(Boolean).join(" and ");
            }
          } catch (err) {
            result.services_unhealthy = true;
            result.services_reason = `service check error (${err.message})`;
          }
          run.setStage("restored");
        }
      } else {
        // Leave the watchdog armed: it retries the same rollback at its deadline.
        result.verdict = "error";
        result.failed_stage = "rolling_back";
        result.rollback_unverified = true;
        result.reason = `ROLLBACK NOT VERIFIED (current ${cur === before.current ? "ok" : "differs"}, profile ${prof === before.profile ? "ok" : "differs"}, pins ${pv.ok ? "ok" : "differ"}); watchdog left armed`;
      }
    } else if (pins) {
      result.pins = verifyPins(cfg, pins);
      if (!result.pins.ok) {
        result.verdict = "error";
        result.rollback_unverified = true;
        result.reason = "pin files changed and could not be restored";
      }
    }
    if (before && !result.generation.after) result.generation.after = profileGeneration(cfg.profile);
    for (const rel of run.releases.reverse()) {
      try {
        rel();
      } catch {
        /* ignore */
      }
    }
    result.evidence = run.evidence.slice(-30);
    result.finished_at = nowIso();
    result.duration_sec = Math.round((Date.parse(result.finished_at) - Date.parse(result.started_at)) / 1000);
    try {
      writeJson(path.join(run.dir, "result.json"), result);
    } catch {
      /* the worker reports a missing result */
    }
    run.setStage("done", { verdict: result.verdict });
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onTerm);
    process.off("SIGHUP", onTerm);
  }
}

// ------------------------------------------------------------------ watchdog

/**
 * Independent rollback, run by the transient timer armed before activation.
 * Rolls back only if the lab system is still active (or the activation was
 * interrupted before the current-system link moved), never over a system a
 * later operation activated.
 */
export async function runWatchdog(actFile, env = process.env) {
  const act = readJsonNoFollow(actFile);
  const dir = path.dirname(actFile);
  const cfg = { ...labConfig(env), systemctl: act.systemctl || "systemctl", flock: act.flock || "flock", storePrefix: act.store_prefix || "/nix/store/", killGraceSec: 10 };
  const out = { fired: false, at: nowIso(), phase: act.phase };
  const done = (extra) => {
    Object.assign(out, extra);
    try {
      writeJson(path.join(dir, "watchdog.json"), out);
    } catch {
      /* ignore */
    }
    return out;
  };
  if (act.phase === "restored") return done({ reason: "already restored by the runner" });
  if (!isSystemPath(cfg, act.before) || !String(act.lab || "").startsWith(cfg.storePrefix)) return done({ reason: "activation record invalid; not touching the system" });
  // Stop a hung runner first so two switches never race.
  if (/^[A-Za-z0-9@._-]+\.service$/.test(act.lab_unit || "")) {
    await runCmd(cfg.systemctl, ["kill", "--signal=SIGKILL", act.lab_unit], { timeoutSec: 30, graceSec: 5 });
  }
  const lk = await holdFlock(cfg, act.system_lock || "/run/neo/locks/system.lock", { waitSec: 60 });
  try {
    const cur = realpathOrNull(act.current_link || "/run/current-system");
    // Interrupted mid-activation before the link moved: re-switching is idempotent.
    const needed = cur === act.lab || (cur === act.before && act.phase === "activating");
    if (!needed) return done({ reason: "system changed by another operation since the lab test; left alone" });
    const rb = await switchTo(cfg, act.before, Number(act.rollback_timeout_sec) || 900);
    const now = realpathOrNull(act.current_link || "/run/current-system");
    const pinCfg = { ...cfg, flake: act.flake, pinFiles: (act.pins || []).map((p) => p.name) };
    const pv = verifyPins(pinCfg, (act.pins || []).map((p) => ({ ...p, exists: true })));
    const restored = now === act.before;
    const notes = [`watchdog rollback exit ${rb.status}`];
    let services = null;
    if (act.protected && restored) {
      // Protected run: the runner died (maybe with ops/Hermes); same service
      // verification + restart as the runner, from the activation record.
      const svcCfg = {
        ...cfg,
        opsHealth: act.ops_health || cfg.opsHealth,
        docker: act.docker || cfg.docker,
        hermesUnit: /^[A-Za-z0-9@._:-]+\.service$/.test(act.hermes_unit || "") ? act.hermes_unit : cfg.hermesUnit,
        opsUnit: /^[A-Za-z0-9@._:-]+\.service$/.test(act.ops_unit || "") ? act.ops_unit : cfg.opsUnit,
        recoverSec: Number(act.recover_sec) >= 0 ? Number(act.recover_sec) : cfg.recoverSec,
      };
      try {
        services = await recoverServices(svcCfg, (l) => notes.push(red(l).slice(0, 300)));
      } catch (err) {
        services = { ok: false, error: err.message };
      }
    }
    const res = done({ fired: true, rollback_exit: rb.status, restored, pins: pv, locked: lk.ok, ...(services ? { services } : {}) });
    const resultFile = path.join(dir, "result.json");
    if (!fs.existsSync(resultFile)) {
      writeJson(resultFile, {
        version: 1,
        instance: act.instance,
        verdict: "error",
        failed_stage: act.phase,
        reason: restored ? "lab runner did not finish; the watchdog rolled back to the previous system" : "lab runner did not finish; WATCHDOG ROLLBACK NOT VERIFIED",
        rollback_unverified: !restored || !pv.ok,
        checks: [],
        generation: { restored, after: profileGeneration(act.profile || "/nix/var/nix/profiles/system") },
        pins: pv,
        watchdog: { armed: true, disarmed: false, fired: true },
        finished_at: nowIso(),
        evidence: notes,
        ...(services ? { post_rollback_services: services, services_unhealthy: !services.ok, services_reason: services.ok ? undefined : "ops /health or Hermes" } : {}),
        ...(act.protected ? { protected: { approved: true, label: "protected run" } } : {}),
      });
    }
    return res;
  } finally {
    if (lk.ok) lk.release();
  }
}

// ------------------------------------------------------------------ main

export async function main(argv = process.argv.slice(2)) {
  const [mode, arg] = argv;
  if (mode === "--run") {
    const cfg = labConfig();
    if (!isValidInstance(arg || "")) {
      console.error("heimcloud-ops-labtest: invalid instance");
      return 2;
    }
    const r = await runLab(cfg, arg);
    console.log(`heimcloud-ops-labtest: ${arg}: ${r.verdict}${r.reason ? ` (${r.reason})` : ""}`);
    return fs.existsSync(path.join(instanceDir(cfg, arg), "result.json")) ? 0 : 1;
  }
  if (mode === "--watchdog") {
    const cfg = labConfig();
    const file = path.resolve(String(arg || ""));
    if (!file.startsWith(path.resolve(cfg.stateDir) + path.sep) || path.basename(file) !== "activation.json") {
      console.error("heimcloud-ops-labtest: watchdog file outside the state dir");
      return 2;
    }
    const r = await runWatchdog(file);
    console.log(`heimcloud-ops-labtest watchdog: ${r.fired ? `rolled back (restored=${r.restored})` : r.reason}`);
    return 0;
  }
  console.error("usage: heimcloud-ops-labtest --run <lab-instance> | --watchdog <state>/<instance>/activation.json");
  return 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`heimcloud-ops-labtest: ${err?.stack || err}`);
    process.exit(1);
  });
}
