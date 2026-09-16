/**
 * Draft PR shell for incidents via GitHub REST API.
 * Token: OPS_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN. No auto-merge.
 */

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

/**
 * Logical allowlisted target vs writable head repo.
 * heimcloud token cannot push to madebydamo/neo — push to fork heimcloud/neo
 * and open the draft PR against upstream when possible.
 */
export function resolveWriteRepo(logicalRepo) {
  const slug = String(logicalRepo || "").trim();
  if (slug === "madebydamo/neo") return "heimcloud/neo";
  return slug;
}

export function resolvePrBaseRepo(logicalRepo, writeRepo) {
  const logical = String(logicalRepo || "").trim();
  const write = String(writeRepo || "").trim();
  if (logical === "madebydamo/neo" && write === "heimcloud/neo") {
    return "madebydamo/neo";
  }
  return write;
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
  const logicalRepo = resolveTargetRepo(incident);
  if (!isRepoAllowed(logicalRepo)) {
    const err = new Error(`target_repo_not_allowlisted:${logicalRepo}`);
    err.status = 400;
    throw err;
  }
  const writeRepo = resolveWriteRepo(logicalRepo);
  const baseRepo = resolvePrBaseRepo(logicalRepo, writeRepo);
  const [writeOwner, writeName] = writeRepo.split("/");
  const [baseOwner, baseName] = baseRepo.split("/");
  const branch = `heimcloud/incident-${incident.id}`;
  const filePath = `docs/heimcloud-ops/incident-${incident.id}.md`;
  const bodyMd = incidentChecklist(incident);

  // Prefer tip of write repo (fork) so we can push; fall back to logical base tip sync is operator's job
  const writeInfo = await gh(`/repos/${writeOwner}/${writeName}`);
  const writeDefault = writeInfo.default_branch || "master";
  const baseInfo = await gh(`/repos/${baseOwner}/${baseName}`);
  const baseDefault = baseInfo.default_branch || "main";
  const ref = await gh(
    `/repos/${writeOwner}/${writeName}/git/ref/heads/${writeDefault}`,
  );
  const baseSha = ref.object.sha;

  // Create branch on writable repo (ignore if already exists)
  try {
    await gh(`/repos/${writeOwner}/${writeName}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
  } catch (err) {
    if (err.status !== 422) throw err;
  }

  let existingSha = null;
  try {
    const existing = await gh(
      `/repos/${writeOwner}/${writeName}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
    );
    existingSha = existing.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  const contentB64 = Buffer.from(bodyMd, "utf8").toString("base64");
  await gh(`/repos/${writeOwner}/${writeName}/contents/${filePath}`, {
    method: "PUT",
    body: {
      message: `ops: incident #${incident.id} draft checklist`,
      content: contentB64,
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    },
  });

  // Cross-fork head when write repo differs from PR base
  const head =
    writeRepo === baseRepo ? branch : `${writeOwner}:${branch}`;
  const openPrs = await gh(
    `/repos/${baseOwner}/${baseName}/pulls?state=open&head=${encodeURIComponent(head.includes(":") ? head : `${writeOwner}:${branch}`)}`,
  );
  if (Array.isArray(openPrs) && openPrs.length > 0) {
    const pr = openPrs[0];
    return {
      repo: logicalRepo,
      write_repo: writeRepo,
      base_repo: baseRepo,
      branch,
      pr_number: pr.number,
      pr_url: pr.html_url,
      draft: Boolean(pr.draft),
      reused: true,
    };
  }

  const pr = await gh(`/repos/${baseOwner}/${baseName}/pulls`, {
    method: "POST",
    body: {
      title: `ops: incident #${incident.id} (${incident.severity || "unspecified"})`,
      head,
      base: baseDefault,
      body: bodyMd,
      draft: true,
    },
  });

  return {
    repo: logicalRepo,
    write_repo: writeRepo,
    base_repo: baseRepo,
    branch,
    pr_number: pr.number,
    pr_url: pr.html_url,
    draft: true,
    reused: false,
  };
}
