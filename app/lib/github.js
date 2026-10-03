/**
 * GitHub helpers for Ops.
 *
 * Choice (TASK 2): the old Create-PR path that committed
 * docs/heimcloud-ops/incident-*.md into target repos is removed. Draft PRs
 * cannot exist without a commit, and those commits leaked customer
 * identifiers. Fix PRs now come from tested branches (Start fix only
 * records intent in Ops). buildAnonymousPrPayload remains as the single
 * place that would format GitHub-facing text if we ever open a PR again —
 * title/body are built only from incident number, report_hash, unit,
 * severity, class, neo_version, and a redacted logs excerpt.
 */

import {
  redactIdentifyingDetails,
  mergeKnownSlugs,
  getExtraRedactSlugs,
} from "./redact.js";
import { listDistinctCustomerRepoSlugs } from "./db.js";
import { loadTargets, findTarget, routeTarget } from "./targets.js";

function getToken() {
  return (
    process.env.OPS_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim();
}

export function getGithubTokenConfigured() {
  return Boolean(getToken());
}

/**
 * Allowlisted upstream repos = the autofix targets (OPS_TARGETS, see
 * targets.js). One source of truth: the old OPS_TARGET_ALLOWLIST is gone;
 * without settings the built-in madebydamo/neo → heimcloud/neo entry applies.
 */
export function getTargets() {
  return loadTargets();
}

export function getAllowlist() {
  return getTargets().map((t) => t.upstream);
}

export function isRepoAllowed(repo, targets = getTargets()) {
  return Boolean(findTarget(targets, repo));
}

/**
 * Target repo of an incident: its target_repo (set by triage / the admin) when
 * allowlisted, else an allowlisted target_hint, else routing by the hints
 * (unit / keywords). Never an unknown repo.
 */
export function resolveTargetRepo(incident, targets = getTargets()) {
  for (const v of [incident.target_repo, incident.target_hint]) {
    const t = findTarget(targets, v);
    if (t) return t.upstream;
  }
  return routeTarget(targets, { unit: incident.unit, logs: incident.logs_excerpt }).target.upstream;
}

/** Fork the loop pushes to for an allowlisted upstream (null when unknown). */
export function resolveWriteRepo(logicalRepo, targets = getTargets()) {
  return findTarget(targets, logicalRepo)?.fork || null;
}

export function resolvePrBaseRepo(logicalRepo, targets = getTargets()) {
  return findTarget(targets, logicalRepo)?.upstream || null;
}

/**
 * Build an anonymous title + body for a hypothetical GitHub PR.
 * Does not call GitHub. Never includes customer_repo_slug, target_hint,
 * plugin_urls, or unredacted logs.
 *
 * @param {object} incident
 * @param {{ knownSlugs?: string[], logsMaxChars?: number }} [opts]
 * @returns {{ title: string, body: string }}
 */
export function buildAnonymousPrPayload(incident, opts = {}) {
  const knownSlugs = mergeKnownSlugs(
    opts.knownSlugs ?? listDistinctCustomerRepoSlugs(),
    ...getExtraRedactSlugs(),
    incident.customer_repo_slug,
  );
  const redact = (s) => redactIdentifyingDetails(s, { knownSlugs });

  const id = incident.id;
  const hash = String(incident.report_hash || "");
  const hashShort = hash.slice(0, 12);
  const severity = redact(incident.severity || "unspecified");
  const klass = redact(incident.class || "unknown");
  const unit = redact(incident.unit || "—");
  const neoVersion = redact(incident.neo_version || "—");
  const logsMax = opts.logsMaxChars ?? 4000;
  let logs = redact(incident.logs_excerpt || "(none)");
  if (logs.length > logsMax) {
    logs = `${logs.slice(0, logsMax)}\n…[truncated]`;
  }

  const title = `ops: incident #${id} (${severity})`;
  const body = [
    `# Heimcloud Ops incident #${id}`,
    "",
    "Anonymous incident reference. **Do not auto-merge.**",
    "Fix PRs come from tested branches; this text is metadata only.",
    "",
    "## Incident",
    "",
    `- **report_hash:** \`${hash}\` (\`${hashShort}…\`)`,
    `- **severity:** ${severity}`,
    `- **class:** ${klass}`,
    `- **neo_version:** ${neoVersion}`,
    `- **unit:** ${unit}`,
    "",
    "## Logs excerpt (redacted)",
    "",
    "```",
    logs,
    "```",
    "",
    "---",
    `_Heimcloud Ops · incident #${id} · report_hash ${hashShort}…_`,
    "",
  ].join("\n");

  // Final sweep over the whole payload (defense in depth).
  return {
    title: redact(title),
    body: redact(body),
  };
}

/**
 * @deprecated Removed: doc-commit draft PRs leaked identifiers.
 * Use admin "Start fix" (intent only) + tested fix branches instead.
 */
export async function createDraftPrForIncident() {
  const err = new Error(
    "create_draft_pr_removed: use Start fix + tested branch; doc-commit PRs are disabled",
  );
  err.status = 410;
  throw err;
}
