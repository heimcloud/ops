/**
 * Allowlisted upstream repos of the autofix loop (single source of truth).
 *
 * Nix renders neo.services.ops.targets (settings.toml [[services.ops.targets]])
 * into OPS_TARGETS (JSON) for the ops container, the worker, the PR wrapper
 * and the root lab runner. Without it the built-in neo entry applies, so a
 * host without new settings keeps working (madebydamo/neo → heimcloud/neo).
 *
 * Entry: { upstream, fork, baseRef, flakeInput, lab, flakeUrl, units, paths,
 *          keywords, protectedPaths }
 *  - upstream   owner/repo the PR goes to (the incident's target_repo)
 *  - fork       heimcloud/<repo> the worker pushes fix/* | ops/* branches to
 *  - baseRef    branch the host runs / PR base
 *  - flakeInput host flake input the lab overrides (null = find it by URL)
 *  - lab        "flake-override" (default) | "none" (→ needs_human, test by hand)
 *  - flakeUrl   override URL with {branch}
 *  - units / paths / keywords  routing hints for triage
 *  - protectedPaths  admin approval before the lab test (shared ops/lab host)
 * Shared by the app (lib) and the worker package (copied, byte-identical).
 */

import fs from "node:fs";

export const DEFAULT_NEO_PROTECTED = ["nix/services/ops", "nix/services/hermes", "nix/services/swag", "nix/modules/core"];
export const LAB_METHODS = ["flake-override", "none"];
export const FORK_OWNER = "heimcloud";

const SLUG_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const INPUT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FLAKE_URL_RE = /^(github:|git\+https:\/\/github\.com\/)[A-Za-z0-9_.\/?=&{}-]+$/;

export function isSlug(s) {
  const v = String(s || "");
  return SLUG_RE.test(v) && !v.split("/").some((p) => p === "." || p === ".." || p.startsWith("."));
}

export function defaultNeoTarget(overrides = {}) {
  return {
    upstream: "madebydamo/neo",
    fork: "heimcloud/neo",
    baseRef: "master",
    flakeInput: "neo",
    lab: "flake-override",
    flakeUrl: "github:heimcloud/neo/{branch}",
    units: [],
    paths: [],
    keywords: [],
    protectedPaths: DEFAULT_NEO_PROTECTED,
    ...overrides,
  };
}

const strList = (v, re, max = 50) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 200 && re.test(x)))].slice(0, max);

/** Validate one entry; null when unusable (never throws). */
export function normalizeTarget(t) {
  if (!t || typeof t !== "object" || !isSlug(t.upstream)) return null;
  const repo = t.upstream.split("/")[1];
  const fork = t.fork == null || t.fork === "" ? `${FORK_OWNER}/${repo}` : String(t.fork);
  // The fork-push credential (and the loop's branch namespace) is heimcloud only.
  if (!isSlug(fork) || fork.split("/")[0].toLowerCase() !== FORK_OWNER) return null;
  const baseRef = String(t.baseRef || "master");
  if (!REF_RE.test(baseRef) || baseRef.includes("..")) return null;
  const flakeInput = t.flakeInput == null || t.flakeInput === "" ? null : String(t.flakeInput);
  if (flakeInput !== null && !INPUT_RE.test(flakeInput)) return null;
  const lab = LAB_METHODS.includes(t.lab) ? t.lab : t.lab == null ? "flake-override" : null;
  if (!lab) return null;
  const flakeUrl = t.flakeUrl ? String(t.flakeUrl) : `github:${fork}/{branch}`;
  if (!FLAKE_URL_RE.test(flakeUrl) || !flakeUrl.includes("{branch}")) return null;
  const isNeo = t.upstream.toLowerCase() === "madebydamo/neo";
  return {
    upstream: t.upstream,
    fork,
    baseRef,
    flakeInput,
    lab,
    flakeUrl,
    units: strList(t.units, /^[A-Za-z0-9@._:*-]+$/),
    paths: strList(t.paths, /^[A-Za-z0-9._\/-]+$/),
    keywords: strList(t.keywords, /^[^\n\r]{2,80}$/),
    protectedPaths: Array.isArray(t.protectedPaths)
      ? strList(t.protectedPaths, /^[A-Za-z0-9._\/-]+$/).map((p) => p.replace(/^\.?\/+|\/+$/g, ""))
      : isNeo
        ? DEFAULT_NEO_PROTECTED
        : [],
  };
}

/**
 * Parse OPS_TARGETS (JSON array). Invalid entries are dropped; duplicates of
 * an upstream keep the first. An unset / unusable value falls back to the
 * built-in neo entry (with OPS_NEO_BASE_REF for its base).
 */
export function parseTargets(raw, { neoBaseRef } = {}) {
  let list = [];
  if (raw && String(raw).trim()) {
    try {
      const v = JSON.parse(raw);
      list = Array.isArray(v) ? v : [];
    } catch {
      list = [];
    }
  }
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const n = normalizeTarget(t);
    if (!n || seen.has(n.upstream.toLowerCase())) continue;
    seen.add(n.upstream.toLowerCase());
    out.push(n);
  }
  if (!out.length) out.push(defaultNeoTarget(neoBaseRef && REF_RE.test(neoBaseRef) && !neoBaseRef.includes("..") ? { baseRef: neoBaseRef } : {}));
  return out;
}

/** Rendered by the ops module on the host (interactive checks without the unit env). */
export const DEFAULT_TARGETS_FILE = "/etc/heimcloud-ops/targets.json";

/**
 * OPS_TARGETS (JSON), else the JSON file OPS_TARGETS_FILE (systemd units: no
 * quoting issues), else DEFAULT_TARGETS_FILE when it exists.
 */
export function loadTargets(env = process.env) {
  return parseTargets(env.OPS_TARGETS || readTargetsFile(env.OPS_TARGETS_FILE || DEFAULT_TARGETS_FILE), { neoBaseRef: String(env.OPS_NEO_BASE_REF || "").trim() });
}

export function readTargetsFile(file) {
  if (!file) return "";
  try {
    return fs.readFileSync(String(file), "utf8").slice(0, 200000);
  } catch {
    return "";
  }
}

/** Allowlisted target by upstream slug (case-insensitive), or null. */
export function findTarget(targets, slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return null;
  return targets.find((t) => t.upstream.toLowerCase() === s) || null;
}

/** Target whose fork is this slug, or null. */
export function findTargetByFork(targets, fork) {
  const s = String(fork || "").trim().toLowerCase();
  return targets.find((t) => t.fork.toLowerCase() === s) || null;
}

function unitMatches(pattern, unit) {
  const u = String(unit || "").toLowerCase().replace(/\.service$/, "");
  const p = pattern.toLowerCase().replace(/\.service$/, "");
  if (!p.includes("*")) return u === p;
  const re = new RegExp(`^${p.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(u);
}

/**
 * Deterministic routing from the hints (used when triage names no target and
 * for the hint list shown to Hermes): unit pattern +3, changed-path prefix +2,
 * keyword in the logs +1. Ties and no match → the first entry (neo).
 */
export function routeTarget(targets, { unit = "", logs = "", files = [] } = {}) {
  let best = targets[0];
  let bestScore = 0;
  const text = String(logs || "").toLowerCase();
  for (const t of targets) {
    let score = 0;
    if (t.units.some((p) => unitMatches(p, unit))) score += 3;
    if (t.paths.some((p) => files.some((f) => f === p || f.startsWith(`${p.replace(/\/+$/, "")}/`)))) score += 2;
    score += t.keywords.filter((k) => text.includes(k.toLowerCase())).length;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return { target: best, score: bestScore };
}

/** Prompt lines describing the allowlist for the triage skill. */
export function targetHints(targets) {
  return targets.map((t) => {
    const bits = [t.units.length && `units ${t.units.join(", ")}`, t.paths.length && `paths ${t.paths.join(", ")}`, t.keywords.length && `keywords ${t.keywords.join(", ")}`].filter(Boolean);
    return `- ${t.upstream}${bits.length ? ` (${bits.join("; ")})` : ""}`;
  });
}

export function compareOpts(t) {
  const [, forkRepo] = t.fork.split("/");
  return { upstream: t.upstream, forkOwner: t.fork.split("/")[0], forkRepo, base: t.baseRef };
}
