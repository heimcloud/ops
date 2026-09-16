/**
 * Draft PR shell for incidents via GitHub REST API.
 * Token: GITHUB_TOKEN or GH_TOKEN. No auto-merge.
 */

function getToken() {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim();
}

export function getGithubTokenConfigured() {
  return Boolean(getToken());
}

/** Default allowlist: madebydamo/neo + heimcloud/* */
export function getAllowlist() {
  const raw =
    process.env.OPS_TARGET_ALLOWLIST || "madebydamo/neo,heimcloud/*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isRepoAllowed(repo, allowlist = getAllowlist()) {
  const slug = String(repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) return false;
  const [owner, name] = slug.split("/");
  for (const rule of allowlist) {
    if (rule === slug) return true;
    if (rule.endsWith("/*")) {
      const prefix = rule.slice(0, -2);
      if (owner === prefix) return true;
    }
    if (rule === `${owner}/*`) return true;
    if (rule === name && owner) {
      /* ignore bare name */
    }
  }
  // Explicit default coverage even if env is empty-ish
  if (slug === "madebydamo/neo") return true;
  if (owner === "heimcloud") return true;
  return false;
}

export function resolveTargetRepo(incident) {
  const hint = (incident.target_repo || incident.target_hint || "").trim();
  if (hint && isRepoAllowed(hint)) return hint;
  if (hint && !hint.includes("/")) {
    // bare name under heimcloud
    const candidate = `heimcloud/${hint}`;
    if (isRepoAllowed(candidate)) return candidate;
  }
  return "madebydamo/neo";
}

async function gh(path, { method = "GET", body } = {}) {
  const token = getToken();
  if (!token) {
    const err = new Error("github_token_not_configured");
    err.status = 503;
    throw err;
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "heimcloud-ops",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      (data && (data.message || data.error)) || `github_api_${res.status}`,
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function incidentChecklist(incident) {
  return [
    `# Heimcloud Ops incident #${incident.id}`,
    "",
    "Phase 1 draft PR shell — fill in the repair. **Do not auto-merge.**",
    "",
    "## Incident",
    "",
    `- **report_hash:** \`${incident.report_hash}\``,
    `- **severity:** ${incident.severity || "—"}`,
    `- **class:** ${incident.class}`,
    `- **status:** ${incident.status}`,
    `- **neo_version:** ${incident.neo_version || "—"}`,
    `- **unit:** ${incident.unit || "—"}`,
    `- **customer_repo_slug:** ${incident.customer_repo_slug || "—"}`,
    `- **target_hint:** ${incident.target_hint || "—"}`,
    "",
    "## Plugin URLs",
    "",
    "```",
    incident.plugin_urls || "(none)",
    "```",
    "",
    "## Logs excerpt",
    "",
    "```",
    incident.logs_excerpt || "(none)",
    "```",
    "",
    "## Checklist for Repair / human",
    "",
    "- [ ] Confirm class (software vs human_config)",
    "- [ ] Reproduce or verify from logs",
    "- [ ] Implement fix on this branch",
    "- [ ] Request review — **no auto-merge**",
    "",
    "---",
    `_Opened by Heimcloud Ops · branch \`heimcloud/incident-${incident.id}\`_`,
    "",
  ].join("\n");
}

/**
 * Create branch heimcloud/incident-<id> from default branch tip,
 * add docs/heimcloud-ops/incident-<id>.md stub, open draft PR.
 */
export async function createDraftPrForIncident(incident) {
  const repo = resolveTargetRepo(incident);
  if (!isRepoAllowed(repo)) {
    const err = new Error(`target_repo_not_allowlisted:${repo}`);
    err.status = 400;
    throw err;
  }
  const [owner, name] = repo.split("/");
  const branch = `heimcloud/incident-${incident.id}`;
  const filePath = `docs/heimcloud-ops/incident-${incident.id}.md`;
  const bodyMd = incidentChecklist(incident);

  const repoInfo = await gh(`/repos/${owner}/${name}`);
  const defaultBranch = repoInfo.default_branch || "main";
  const ref = await gh(`/repos/${owner}/${name}/git/ref/heads/${defaultBranch}`);
  const baseSha = ref.object.sha;

  // Create branch (ignore if already exists)
  try {
    await gh(`/repos/${owner}/${name}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
  } catch (err) {
    if (err.status !== 422) throw err;
    // Branch may already exist — continue and try file + PR
  }

  // Create or update stub file via Contents API
  let existingSha = null;
  try {
    const existing = await gh(
      `/repos/${owner}/${name}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
    );
    existingSha = existing.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  const contentB64 = Buffer.from(bodyMd, "utf8").toString("base64");
  await gh(`/repos/${owner}/${name}/contents/${filePath}`, {
    method: "PUT",
    body: {
      message: `ops: incident #${incident.id} draft checklist`,
      content: contentB64,
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    },
  });

  // Find existing PR for this head, else create draft
  const head = `${owner}:${branch}`;
  const openPrs = await gh(
    `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(head)}`,
  );
  if (Array.isArray(openPrs) && openPrs.length > 0) {
    const pr = openPrs[0];
    return {
      repo,
      branch,
      pr_number: pr.number,
      pr_url: pr.html_url,
      draft: Boolean(pr.draft),
      reused: true,
    };
  }

  const pr = await gh(`/repos/${owner}/${name}/pulls`, {
    method: "POST",
    body: {
      title: `ops: incident #${incident.id} (${incident.severity || "unspecified"})`,
      head: branch,
      base: defaultBranch,
      body: bodyMd,
      draft: true,
    },
  });

  return {
    repo,
    branch,
    pr_number: pr.number,
    pr_url: pr.html_url,
    draft: true,
    reused: false,
  };
}
