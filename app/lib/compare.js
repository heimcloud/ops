/**
 * Compare-link fallback when fine-grained token cannot open upstream PRs.
 */

/**
 * @param {string} branch
 * @param {{ upstream?: string, forkOwner?: string, forkRepo?: string, base?: string }} [opts]
 */
export function buildCompareUrl(branch, opts = {}) {
  const b = String(branch || "").trim();
  if (!b) throw new Error("branch_required");
  if (!/^(fix|ops)\/[A-Za-z0-9._/-]+$/.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".lock")) {
    throw new Error("branch_name_rejected");
  }
  const upstream = opts.upstream || "madebydamo/neo";
  const forkOwner = opts.forkOwner || "heimcloud";
  const forkRepo = opts.forkRepo || "neo";
  const base = String(opts.base || "master").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) {
    throw new Error("base_ref_rejected");
  }
  return `https://github.com/${upstream}/compare/${encodeURIComponent(base).replace(/%2F/g, "/")}...${forkOwner}:${forkRepo}:${encodeURIComponent(b).replace(/%2F/g, "/")}?expand=1`;
}
