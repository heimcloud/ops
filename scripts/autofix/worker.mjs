#!/usr/bin/env node
/**
 * heimcloud-ops-worker — process one job from the shared queue (concurrency 1 via systemd lock).
 * Runs as user hermes. Default OFF; only invoked when autofix Nix units are enabled.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  redactIdentifyingDetails,
  findIdentifierHits,
  getExtraRedactSlugs,
  mergeKnownSlugs,
} from "./redact.js";
import { buildCompareUrl } from "./compare.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.OPS_DATA_DIR || "/var/neo/DATA/AppData/ops";
const QUEUE = path.join(DATA_DIR, "queue");
const RESULTS = path.join(DATA_DIR, "results");
const LOCK = process.env.OPS_AUTOFIX_LOCK || "/run/heimcloud-ops-worker.lock";
const MAX_ATTEMPTS = Number(process.env.OPS_AUTOFIX_MAX_ATTEMPTS || 2);
const DENY = (process.env.OPS_AUTOFIX_DENY_PATHS ||
  "nix/services/ops,nix/services/hermes,nix/services/swag,nix/modules/core")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LAB_SHARES_OPS = !["0", "false", "no", "off"].includes(
  String(process.env.OPS_AUTOFIX_LAB_SHARES_OPS_HOST || "true").toLowerCase(),
);
const HERMES_BIN = process.env.HERMES_BIN || "hermes";
const SCRATCH_ROOT =
  process.env.OPS_AUTOFIX_SCRATCH ||
  path.join(os.homedir(), "workspace", "autofix");

function usage() {
  console.error("usage: heimcloud-ops-worker [--once]");
  process.exit(2);
}

function ensureDirs() {
  for (const d of [
    path.join(QUEUE, "triage"),
    path.join(QUEUE, "fix"),
    RESULTS,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function tryLock() {
  try {
    const fd = fs.openSync(LOCK, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    return fd;
  } catch {
    return null;
  }
}

function unlock(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(LOCK);
  } catch {
    /* ignore */
  }
}

function listJobs() {
  const out = [];
  for (const kind of ["triage", "fix"]) {
    const dir = path.join(QUEUE, kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
      out.push({ kind, file: path.join(dir, f) });
    }
  }
  out.sort((a, b) => fs.statSync(a.file).mtimeMs - fs.statSync(b.file).mtimeMs);
  return out;
}

function writeResult(jobFile, result) {
  fs.mkdirSync(RESULTS, { recursive: true });
  const base = path.basename(jobFile, ".json");
  const dest = path.join(RESULTS, `${base}.json`);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, dest);
  try {
    fs.renameSync(jobFile, `${jobFile}.done`);
  } catch {
    fs.unlinkSync(jobFile);
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd || process.cwd(),
    timeout: opts.timeout || 600_000,
  });
}

function extractJson(text) {
  const t = String(text || "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function knownSlugs() {
  return mergeKnownSlugs(getExtraRedactSlugs());
}

function scanOutbound(label, text) {
  const hits = findIdentifierHits(text, { knownSlugs: knownSlugs() });
  if (hits.length) {
    const err = new Error(`redaction_fail_closed:${label}:${hits.join(",")}`);
    err.hits = hits;
    throw err;
  }
}

function readNeoBaseRef() {
  // Prefer flake lock neo input ref on the host build tree; fallback master.
  const candidates = [
    process.env.OPS_NEO_BASE_REF,
    "/etc/neo/neo-input-ref",
    path.join(os.homedir(), ".neo-input-ref"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        const v = fs.readFileSync(c, "utf8").trim();
        if (v) return v;
      }
    } catch {
      /* ignore */
    }
  }
  // Documented fallback: branch tip name for clone -b
  return process.env.OPS_NEO_FALLBACK_REF || "master";
}

function hermesChat(skill, promptPath) {
  const args = [
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
  // Prefer credential wrapper for fix skill pushes later; triage needs no token.
  const wrapped = run("heimcloud-autofix-env", ["--check"]);
  const useWrap = wrapped.status === 0;
  const r = useWrap
    ? run("heimcloud-autofix-env", [HERMES_BIN, ...args])
    : run(HERMES_BIN, args);
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    wrapped: useWrap,
  };
}

function handleTriage(job, jobFile) {
  const prompt = path.join(os.tmpdir(), `ops-triage-${job.incident_id}.txt`);
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
  const r = hermesChat("heimcloud-ops-triage", prompt);
  const verdict = extractJson(r.stdout) || extractJson(r.stderr);
  if (!verdict) {
    writeResult(jobFile, {
      kind: "triage",
      incident_id: job.incident_id,
      status: "triage_failed",
      summary: "Hermes produced no JSON verdict",
      hermes_status: r.status,
    });
    return;
  }
  writeResult(jobFile, {
    kind: "triage",
    incident_id: job.incident_id,
    status: "triaged",
    class: verdict.class,
    severity: verdict.severity,
    summary: verdict.summary,
    target_repo: verdict.target_repo || "madebydamo/neo",
    fixable: Boolean(verdict.fixable),
  });
}

function denyListHit(diff) {
  if (!LAB_SHARES_OPS) return null;
  for (const d of DENY) {
    if (diff.includes(d)) return d;
  }
  return null;
}

function handleFix(job, jobFile) {
  const check = run("heimcloud-autofix-env", ["--check"]);
  if (check.status !== 0) {
    writeResult(jobFile, {
      kind: "fix",
      incident_id: job.incident_id,
      status: "no_token",
      fallback: "triage_only",
      summary: "heimcloud-autofix-env --check failed; no fork-push token",
    });
    return;
  }

  const baseRef = readNeoBaseRef();
  const scratch = path.join(SCRATCH_ROOT, String(job.incident_id));
  fs.mkdirSync(scratch, { recursive: true });
  const neoDir = path.join(scratch, "neo");
  if (!fs.existsSync(neoDir)) {
    const clone = run("heimcloud-autofix-env", [
      "git",
      "clone",
      "--depth",
      "50",
      "--branch",
      baseRef,
      "https://github.com/heimcloud/neo.git",
      neoDir,
    ]);
    if (clone.status !== 0) {
      // try without --branch
      const clone2 = run("heimcloud-autofix-env", [
        "git",
        "clone",
        "--depth",
        "50",
        "https://github.com/heimcloud/neo.git",
        neoDir,
      ]);
      if (clone2.status !== 0) {
        writeResult(jobFile, {
          kind: "fix",
          incident_id: job.incident_id,
          status: "needs_human",
          summary: `git clone failed: ${clone2.stderr || clone.stderr}`,
        });
        return;
      }
    }
  }

  const prompt = path.join(scratch, "prompt.txt");
  fs.writeFileSync(
    prompt,
    [
      `Fix Ops incident #${job.incident_id} in the neo clone at ${neoDir}.`,
      `Base neo ref the host runs: ${baseRef}`,
      `report_hash: ${job.report_hash}`,
      `unit: ${job.unit}`,
      `severity: ${job.severity}`,
      `class: ${job.class}`,
      `neo_version: ${job.neo_version}`,
      "",
      "logs_excerpt (redacted):",
      job.logs_excerpt || "(none)",
      "",
      "Create branch fix/<topic> or ops/incident-" + job.incident_id + ".",
      "Minimal change. No identifiers. Do not push yourself; the worker pushes.",
      "Respond with JSON when the commit is ready.",
    ].join("\n"),
  );

  const r = hermesChat("heimcloud-ops-fix", prompt);
  const verdict = extractJson(r.stdout) || extractJson(r.stderr) || {};
  const branch =
    verdict.branch ||
    `ops/incident-${job.incident_id}`;

  try {
    scanOutbound("branch", branch);
  } catch (err) {
    writeResult(jobFile, {
      kind: "fix",
      incident_id: job.incident_id,
      status: "redaction_blocked",
      summary: err.message,
      hits: err.hits,
    });
    return;
  }

  const log = run("git", ["-C", neoDir, "log", "-1", "--pretty=%B"]);
  const diff = run("git", ["-C", neoDir, "diff", "origin/master...HEAD"]);
  const diffText = diff.stdout || run("git", ["-C", neoDir, "diff", "HEAD~1...HEAD"]).stdout || "";
  const msg = log.stdout || verdict.commit_message || "";

  const denied = denyListHit(diffText);
  if (denied) {
    writeResult(jobFile, {
      kind: "fix",
      incident_id: job.incident_id,
      status: "denied",
      summary: `diff touches deny-listed path ${denied} while lab shares ops host`,
      branch,
    });
    return;
  }

  const prTitle =
    verdict.pr_title ||
    `ops: incident #${job.incident_id} (${job.severity || "unspecified"})`;
  const prBody = [
    `# Heimcloud Ops incident #${job.incident_id}`,
    "",
    `report_hash: \`${job.report_hash}\``,
    "",
    redactIdentifyingDetails(verdict.summary || "Automated fix (lab test pending).", {
      knownSlugs: knownSlugs(),
    }),
    "",
    "Draft/compare only — **do not auto-merge**.",
    "",
  ].join("\n");

  try {
    scanOutbound("commit_message", msg);
    scanOutbound("diff", diffText);
    scanOutbound("pr_title", prTitle);
    scanOutbound("pr_body", prBody);
  } catch (err) {
    writeResult(jobFile, {
      kind: "fix",
      incident_id: job.incident_id,
      status: "redaction_blocked",
      summary: err.message,
      hits: err.hits,
      branch,
    });
    return;
  }

  // Ensure branch name locally
  run("git", ["-C", neoDir, "checkout", "-B", branch]);
  const push = run("heimcloud-autofix-env", [
    "git",
    "-C",
    neoDir,
    "push",
    "-u",
    "origin",
    branch,
  ]);
  if (push.status !== 0) {
    writeResult(jobFile, {
      kind: "fix",
      incident_id: job.incident_id,
      status: "needs_human",
      summary: `git push failed: ${push.stderr || push.stdout}`,
      branch,
    });
    return;
  }

  let compareUrl;
  try {
    compareUrl = buildCompareUrl(branch);
  } catch (err) {
    writeResult(jobFile, {
      kind: "fix",
      incident_id: job.incident_id,
      status: "needs_human",
      summary: err.message,
      branch,
    });
    return;
  }

  // Optional lab test stub
  const lab = run("bash", ["-lc", `command -v heimcloud-lab-test >/dev/null && heimcloud-lab-test ${JSON.stringify(branch)} default || echo SKIP`]);
  const labOut = (lab.stdout || "").trim();
  let status = "awaiting_lab_test";
  let summary = "Branch pushed; compare link prepared. Lab test pending.";
  if (labOut && !labOut.includes("SKIP")) {
    if (lab.status === 0) {
      status = "compare_ready";
      summary = "Lab test passed; open compare link / draft PR.";
    } else {
      status = "needs_human";
      summary = `Lab test failed: ${labOut.slice(0, 500)}`;
    }
  }

  // Future: GH_PR_TOKEN → gh pr create --draft
  let prUrl = null;
  if (process.env.GH_PR_TOKEN) {
    const pr = run(
      "heimcloud-autofix-env",
      [
        "gh",
        "pr",
        "create",
        "--draft",
        "--repo",
        "madebydamo/neo",
        "--head",
        `heimcloud:${branch}`,
        "--base",
        "master",
        "--title",
        prTitle,
        "--body",
        prBody,
      ],
      { env: { GH_TOKEN: process.env.GH_PR_TOKEN } },
    );
    if (pr.status === 0) {
      prUrl = (pr.stdout || "").trim();
      status = "pr_opened";
    }
  }

  writeResult(jobFile, {
    kind: "fix",
    incident_id: job.incident_id,
    status,
    branch,
    compare_url: compareUrl,
    pr_title: prTitle,
    pr_body: prBody,
    pr_url: prUrl,
    summary,
    max_attempts: MAX_ATTEMPTS,
    base_ref: baseRef,
  });
}

function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) usage();
  ensureDirs();
  const fd = tryLock();
  if (fd == null) {
    console.error("heimcloud-ops-worker: lock busy; exiting");
    process.exit(0);
  }
  try {
    const jobs = listJobs();
    if (!jobs.length) {
      console.log("heimcloud-ops-worker: no jobs");
      return;
    }
    const { kind, file } = jobs[0];
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`heimcloud-ops-worker: ${kind} incident ${job.incident_id}`);
    if (kind === "triage") handleTriage(job, file);
    else handleFix(job, file);
  } finally {
    unlock(fd);
  }
}

main();
