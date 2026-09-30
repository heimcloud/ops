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
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  redactIdentifyingDetails,
  findIdentifierHits,
  getExtraRedactSlugs,
  mergeKnownSlugs,
} from "./redact.js";
import { buildCompareUrl } from "./compare.js";

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];
const KINDS = ["triage", "fix"];
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
    deny: (e.OPS_AUTOFIX_DENY_PATHS ||
      "nix/services/ops,nix/services/hermes,nix/services/swag,nix/modules/core")
      .split(",")
      .map((s) => s.trim().replace(/^\.?\/+/, "").replace(/\/+$/, ""))
      .filter(Boolean),
    labSharesOps: !FALSE.includes(
      String(e.OPS_AUTOFIX_LAB_SHARES_OPS_HOST || "true").toLowerCase(),
    ),
    triageOn: TRUE.includes(String(e.OPS_AUTOFIX_TRIAGE || "").toLowerCase()),
    fixOn: TRUE.includes(String(e.OPS_AUTOFIX_FIX || "").toLowerCase()),
    hermesBin: e.HERMES_BIN || "hermes",
    envBin: e.OPS_AUTOFIX_ENV_BIN || "heimcloud-autofix-env",
    labBin: e.OPS_AUTOFIX_LAB_TEST_BIN || "heimcloud-lab-test",
    hermesTimeoutMs: Math.max(60, Number(e.OPS_AUTOFIX_HERMES_TIMEOUT_SEC || 2700)) * 1000,
    labTimeoutMs: Math.max(60, Number(e.OPS_AUTOFIX_LAB_TIMEOUT_SEC || 1800)) * 1000,
    scratchRoot: e.OPS_AUTOFIX_SCRATCH || path.join(os.homedir(), "workspace", "autofix"),
    forkUrl: e.OPS_AUTOFIX_FORK_URL || "https://github.com/heimcloud/neo.git",
    upstreamUrl: e.OPS_AUTOFIX_UPSTREAM_URL || "https://github.com/madebydamo/neo.git",
    baseRef: readNeoBaseRef(),
    dbPath: e.OPS_DB_PATH || path.join(dataDir, "ops.sqlite"),
  };
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

export function tryLock(lockPath) {
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
  return KINDS.filter((k) => (k === "triage" ? cfg.triageOn : cfg.fixOn));
}

export function listJobs(cfg) {
  const out = [];
  for (const kind of enabledKinds(cfg)) {
    const dir = path.join(cfg.queue, kind);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
      const file = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      out.push({ kind, name: f, file, mtime });
    }
  }
  out.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  return out;
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

function finish(cfg, processingFile, bucket) {
  const dest = path.join(cfg.queue, bucket, path.basename(processingFile));
  try {
    fs.renameSync(processingFile, dest);
  } catch {
    try {
      fs.unlinkSync(processingFile);
    } catch {
      /* ignore */
    }
  }
}

export function writeResult(cfg, processingFile, result) {
  fs.mkdirSync(cfg.results, { recursive: true });
  const dest = path.join(cfg.results, path.basename(processingFile));
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...result, finished_at: new Date().toISOString() }, null, 2), {
    mode: 0o660,
  });
  fs.renameSync(tmp, dest);
  return dest;
}

/** A previous run died mid-job (lock is ours now, so anything here is stale). */
export function recoverStale(cfg) {
  const dir = path.join(cfg.queue, "processing");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const m = /^(triage|fix)-(\d+)-/.exec(f);
    const full = path.join(dir, f);
    if (m) {
      writeResult(cfg, full, {
        kind: m[1],
        incident_id: Number(m[2]),
        status: m[1] === "triage" ? "triage_failed" : "needs_human",
        summary: "Worker was interrupted (timeout/kill) while processing this job; re-enqueue from the admin UI.",
      });
    }
    finish(cfg, full, "failed");
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------- helpers

export function run(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  for (const k of opts.unsetEnv || []) delete env[k];
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

export function denyListHit(files, cfg) {
  if (!cfg.labSharesOps) return null;
  for (const f of files) {
    const norm = f.replace(/^\.?\/+/, "");
    for (const d of cfg.deny) {
      if (norm === d || norm.startsWith(`${d}/`)) return d;
    }
  }
  return null;
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
  return r;
}

function hermesFailure(r) {
  if (r.error === "ENOENT") return "hermes CLI not found on PATH";
  if (r.error === "ETIMEDOUT") return "hermes timed out";
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
      "Respond with the JSON verdict only.",
    ].join("\n"),
  );
  const logPath = path.join(ctx.scratch, "triage-hermes.log");
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
  return {
    kind: "triage",
    incident_id: job.incident_id,
    status: "triaged",
    class: CLASSES.includes(verdict.class) ? verdict.class : "unknown",
    severity: redactIdentifyingDetails(verdict.severity || "", { knownSlugs: slugs }),
    summary: redactIdentifyingDetails(verdict.summary || "Triage verdict", { knownSlugs: slugs }),
    target_repo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(verdict.target_repo || "")
      ? verdict.target_repo
      : "madebydamo/neo",
    fixable: Boolean(verdict.fixable),
    evidence_path: logPath,
  };
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
      { env: gitEnv(), timeout: 900_000, unsetEnv: ["GH_TOKEN", "GITHUB_TOKEN"] },
    );
    if (r.status === 0) return { ok: true, url, ref };
    errors.push(`${url}@${ref}: ${tail(r.stderr || r.error, 300)}`);
  }
  return { ok: false, error: errors.join(" | ") };
}

function fixPrompt(job, neoDir, cfg, attempt, previousFailure) {
  return [
    `Fix Ops incident #${job.incident_id} in the neo clone at ${neoDir} (attempt ${attempt}/${cfg.maxAttempts}).`,
    `Base neo ref the host runs: ${cfg.baseRef} (already checked out; branch from here).`,
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
    `Create branch fix/<topic> or ops/incident-${job.incident_id} and COMMIT the change (git identity is preset; do not change git config).`,
    "Minimal change. No identifiers. Do NOT push and do NOT open a PR; the worker pushes after its redaction gate.",
    'When the commit is ready respond with one JSON object: {"status":"ready_to_push","branch":"fix/…","summary":"…","commit_message":"…"}',
  ].join("\n");
}

function labTest(cfg, branch, klass = "default") {
  const which = run("bash", ["-c", 'command -v -- "$1"', "_", cfg.labBin], { timeout: 10_000 });
  const bin = which.status === 0 ? which.stdout.trim() : "";
  if (!bin) return { skipped: true };
  const r = run(bin, [branch, klass || "default"], { timeout: cfg.labTimeoutMs });
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
    buildCompareUrl(branch, { base: cfg.baseRef }); // validates branch shape
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
  const denied = denyListHit(files, cfg);
  if (denied) {
    return { ok: false, result: { status: "denied", summary: `diff touches deny-listed path ${denied} while lab shares ops host` } };
  }
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
  return { ok: true, files, commits: count };
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

/** Push HEAD to the fork branch, build the compare link, run the lab test. */
function pushAndLab(cfg, neoDir, branch, klass) {
  // Fork branch namespace fix/*|ops/* is owned by this loop: force keeps
  // re-runs of the same incident idempotent.
  const push = run(
    cfg.envBin,
    ["git", "-C", neoDir, "push", "--force", "fork", `HEAD:refs/heads/${branch}`],
    { env: gitEnv(), timeout: 900_000 },
  );
  if (push.status !== 0) {
    return { pushed: false, summary: `git push to fork failed: ${tail(push.stderr || push.stdout || push.error, 500)}` };
  }
  return { pushed: true, compare_url: buildCompareUrl(branch, { base: cfg.baseRef }), lab: labTest(cfg, branch, klass || "default") };
}

export function handleFix(cfg, job, ctx) {
  const base = { kind: "fix", incident_id: job.incident_id, base_ref: cfg.baseRef };
  fs.mkdirSync(ctx.scratch, { recursive: true });
  const neoDir = path.join(ctx.scratch, "neo");
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

  let previousFailure = "";
  let last = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    const prompt = path.join(ctx.scratch, `fix-prompt-${attempt}.txt`);
    fs.writeFileSync(prompt, fixPrompt(job, neoDir, cfg, attempt, previousFailure));
    const logPath = path.join(ctx.scratch, `fix-hermes-${attempt}.log`);
    const r = hermesChat(cfg, "heimcloud-ops-fix", prompt, { cwd: neoDir, logPath });
    const verdict = extractJson(r.stdout) || extractJson(r.stderr) || {};
    const common = { ...base, attempts: attempt, max_attempts: cfg.maxAttempts, base_sha: baseSha, evidence_path: logPath };

    if (verdict.status === "failed") {
      return {
        ...common,
        status: "needs_human",
        summary: `Hermes gave up: ${redactIdentifyingDetails(verdict.summary || "", { knownSlugs: slugs })}`,
      };
    }
    const branch = String(verdict.branch || `ops/incident-${job.incident_id}`).trim();
    const prTitle = String(verdict.pr_title || `ops: incident #${job.incident_id} (${job.severity || "unspecified"})`);
    const prBody = [
      `# Heimcloud Ops incident #${job.incident_id}`,
      "",
      `report_hash: \`${job.report_hash}\``,
      "",
      redactIdentifyingDetails(verdict.summary || "Automated fix (lab test pending).", { knownSlugs: slugs }),
      "",
      "Opened manually from the compare link — **do not auto-merge**.",
      "",
    ].join("\n");

    const gate = gateCommits(cfg, neoDir, baseSha, { branch, prTitle, prBody, slugs });
    if (!gate.ok) {
      const res = { ...common, branch, ...gate.result };
      if (res.summary.startsWith("no commit")) {
        res.summary = `Hermes made no commit on top of ${cfg.baseRef} (${hermesFailure(r)}). Log: ${logPath}`;
      }
      return res;
    }

    // Token is only needed from here on. Without it the fix is kept locally.
    const token = tokenAvailable(cfg);
    if (!token.ok) {
      const pending = savePending(cfg, ctx.scratch, neoDir, {
        kind: "fix",
        incident_id: job.incident_id,
        branch,
        class: job.class,
        base_ref: cfg.baseRef,
        base_sha: baseSha,
        pr_title: prTitle,
        pr_body: prBody,
      }, slugs);
      return {
        ...common,
        status: "ready_no_token",
        branch,
        pr_title: prTitle,
        pr_body: prBody,
        lab: "deferred_until_push",
        patch_path: pending.patch_path,
        pending_path: path.join(ctx.scratch, PENDING_FILE),
        head_sha: pending.head_sha,
        summary:
          `Fix branch ${branch} is committed locally (${gate.commits} commit(s)) and passed deny-list + redaction gates; ` +
          `waiting for the fork-push token (${token.reason}). Push later (no Hermes rerun): systemctl start heimcloud-ops-worker-push@${path.basename(ctx.scratch)}.service`,
      };
    }

    const pushed = pushAndLab(cfg, neoDir, branch, job.class);
    if (!pushed.pushed) return { ...common, branch, status: "needs_human", summary: pushed.summary };
    last = { ...common, branch, compare_url: pushed.compare_url, pr_title: prTitle, pr_body: prBody };
    const lab = pushed.lab;
    if (lab.skipped) {
      return {
        ...last,
        status: "awaiting_lab_test",
        lab: "skipped",
        summary: `Branch pushed; compare link ready. ${cfg.labBin} is not installed, so the lab test was skipped — test manually before opening the PR.`,
      };
    }
    if (lab.ok) {
      return { ...last, status: "compare_ready", lab: "passed", summary: "Lab test passed; open the compare link to create the upstream PR." };
    }
    previousFailure = redactIdentifyingDetails(lab.output, { knownSlugs: slugs });
    log(`incident ${job.incident_id}: lab test failed (attempt ${attempt})`);
  }
  // Out of attempts: no compare link (design: no PR after failed lab tests).
  return {
    ...last,
    compare_url: undefined,
    status: "needs_human",
    lab: "failed",
    summary: `Lab test failed after ${cfg.maxAttempts} attempt(s): ${tail(previousFailure, 500)}`,
  };
}

/**
 * `heimcloud-ops-worker --push-pending <job scratch dir>`: push a fix saved as
 * ready_no_token once the token exists. Re-runs the gates (slug list may have
 * grown), never calls Hermes, writes a normal fix result for the app to ingest.
 */
export function pushPending(cfg, scratch) {
  const pendingPath = path.join(scratch, PENDING_FILE);
  const p = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const baseRes = { kind: "fix", incident_id: p.incident_id, base_ref: p.base_ref, base_sha: p.base_sha, branch: p.branch, via: "push-pending" };
  const cfgP = { ...cfg, baseRef: p.base_ref || cfg.baseRef };
  const neoDir = p.neo_dir;
  let result;
  const head = fs.existsSync(neoDir) ? git(neoDir, ["rev-parse", "HEAD"]).stdout.trim() : "";
  if (head !== p.head_sha) {
    // Scratch clone gone or moved: rebuild from the saved patch.
    const clone = cloneNeo(cfgP, neoDir);
    if (!clone.ok) throw new Error(`clone for patch replay failed: ${clone.error}`);
    git(neoDir, ["checkout", "-q", p.base_sha]);
    const am = git(neoDir, ["am", "--committer-date-is-author-date", p.patch_path]);
    if (am.status !== 0) throw new Error(`git am failed: ${tail(am.stderr, 300)}`);
    git(neoDir, ["remote", "remove", "fork"]);
    git(neoDir, ["remote", "add", "fork", cfgP.forkUrl]);
  }
  const slugs = knownSlugs(cfgP);
  const gate = gateCommits(cfgP, neoDir, p.base_sha, { branch: p.branch, prTitle: p.pr_title, prBody: p.pr_body, slugs });
  if (!gate.ok) {
    result = { ...baseRes, ...gate.result };
  } else if (!tokenAvailable(cfgP).ok) {
    throw new Error("fork-push token still unavailable; nothing pushed");
  } else {
    const pushed = pushAndLab(cfgP, neoDir, p.branch, p.class);
    if (!pushed.pushed) result = { ...baseRes, status: "needs_human", summary: pushed.summary };
    else {
      const common = { ...baseRes, compare_url: pushed.compare_url, pr_title: p.pr_title, pr_body: p.pr_body };
      if (pushed.lab.skipped) result = { ...common, status: "awaiting_lab_test", lab: "skipped", summary: "Saved fix pushed; compare link ready. Lab test skipped (not installed) — test manually." };
      else if (pushed.lab.ok) result = { ...common, status: "compare_ready", lab: "passed", summary: "Saved fix pushed; lab test passed." };
      else result = { ...common, compare_url: undefined, status: "needs_human", lab: "failed", summary: `Saved fix pushed but lab test failed (no Hermes retry in push-pending mode): ${tail(redactIdentifyingDetails(pushed.lab.output, { knownSlugs: slugs }), 500)}` };
    }
  }
  const out = writeResult(cfgP, path.join(scratch, `push-${path.basename(scratch)}.json`), result);
  fs.renameSync(pendingPath, `${pendingPath}.done`);
  return { result, path: out };
}

// ---------------------------------------------------------------- main

export function processOne(cfg, entry) {
  const processing = claimJob(cfg, entry);
  if (!processing) return null;
  let job;
  let result;
  let bucket = "done";
  const scratch = path.join(cfg.scratchRoot, path.basename(processing, ".json"));
  try {
    job = JSON.parse(fs.readFileSync(processing, "utf8"));
    if (!job || !Number(job.incident_id)) throw new Error("job without incident_id");
    log(`${entry.kind} incident ${job.incident_id} (${entry.name})`);
    const ctx = { scratch, slugs: knownSlugs(cfg) };
    result = entry.kind === "triage" ? handleTriage(cfg, job, ctx) : handleFix(cfg, job, ctx);
  } catch (err) {
    bucket = "failed";
    const m = /^(\d+)-/.exec(entry.name);
    result = {
      kind: entry.kind,
      incident_id: Number(job?.incident_id || (m && m[1]) || 0),
      status: entry.kind === "triage" ? "triage_failed" : "needs_human",
      summary: `worker error: ${err.message || err}`,
    };
  }
  if (result.incident_id) writeResult(cfg, processing, result);
  finish(cfg, processing, bucket);
  log(`${entry.kind} incident ${result.incident_id}: ${result.status}`);
  return result;
}

/**
 * queue/worker-status.json: last runtime token check, read by the admin UI to
 * warn that Start fix will end ready_no_token. Never contains the token.
 */
export function writeWorkerStatus(cfg) {
  const t = tokenAvailable(cfg);
  const dest = path.join(cfg.queue, "worker-status.json");
  try {
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ fork_push_token: t.ok, reason: t.ok ? null : t.reason, checked_at: new Date().toISOString() }),
      { mode: 0o660 },
    );
    fs.renameSync(tmp, dest);
  } catch (err) {
    console.error(`heimcloud-ops-worker: cannot write ${dest}: ${err.code || err.message}`);
  }
  return t;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.error("usage: heimcloud-ops-worker [--once] | --push-pending <job scratch dir>");
    return 2;
  }
  const cfg = config();
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
      const { result } = pushPending(cfg, path.resolve(dir));
      log(`push-pending incident ${result.incident_id}: ${result.status}`);
      return 0;
    } catch (err) {
      console.error(`heimcloud-ops-worker: push-pending failed: ${err.message || err}`);
      return 1;
    } finally {
      unlock(fd, cfg.lock);
    }
  }
  if (!enabledKinds(cfg).length) {
    log("no job kinds enabled (OPS_AUTOFIX_TRIAGE / OPS_AUTOFIX_FIX); exiting");
    return 0;
  }
  mkdirs(cfg);
  const fd = tryLock(cfg.lock);
  if (fd == null) {
    log("lock busy; another worker is running");
    return 0;
  }
  try {
    if (cfg.fixOn) writeWorkerStatus(cfg);
    const stale = recoverStale(cfg);
    if (stale) log(`recovered ${stale} interrupted job(s) into queue/failed`);
    let n = 0;
    while (n < cfg.maxJobs) {
      const jobs = listJobs(cfg);
      if (!jobs.length) break;
      processOne(cfg, jobs[0]);
      n += 1;
    }
    if (!n) log("no jobs");
  } finally {
    unlock(fd, cfg.lock);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = main();
}
