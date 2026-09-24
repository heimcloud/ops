/**
 * Redact customer-identifying details from text destined for GitHub.
 * Public surfaces may only use Ops incident number + report_hash plus
 * non-identifying metadata. Never emit customer slugs, hostnames, IPs,
 * emails, home paths, or plugin URLs that embed a slug.
 */

const DOMAIN_ALLOWLIST = new Set(["github.com", "docker.io"]);

const LAB_HOSTNAMES = ["hattori", "thatch", "agwanti"];

/** github:owner/repo flake refs we keep (images/docs); everything else goes. */
const GITHUB_FLAKE_ALLOW =
  /^github:(?:madebydamo|heimcloud|NixOS|searxng|docker)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;

/** Exactly 10 uppercase alphanumerics as a whole token (customer_repo_slug). */
const SLUG_SHAPE = /\b[A-Z0-9]{10}\b/g;

const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;

/** IPv6: require '::' or ≥2 colons so digests like sha256:abc are untouched. */
const IPV6 =
  /\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const HOME_PATH = /\/home\/[A-Za-z0-9._-]+/g;

const URL_LIKE =
  /\b(?:github:[^\s`'"]+|git\+https:\/\/[^\s`'"]+|git\+ssh:\/\/[^\s`'"]+|https?:\/\/[^\s`'"]+)/gi;

const FQDN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsSlugShape(s) {
  SLUG_SHAPE.lastIndex = 0;
  return SLUG_SHAPE.test(s);
}

/**
 * @param {string} text
 * @param {{ knownSlugs?: string[] }} [opts]
 * @returns {string}
 */
export function redactIdentifyingDetails(text, opts = {}) {
  let out = text == null ? "" : String(text);
  const known = Array.isArray(opts.knownSlugs) ? opts.knownSlugs : [];

  for (const slug of known) {
    const s = String(slug || "").trim();
    if (!s) continue;
    out = out.replace(new RegExp(escapeRegExp(s), "gi"), "[redacted-slug]");
  }

  // Lowercase hex SHA fragments do not match: [A-Z0-9] is case-sensitive.
  out = out.replace(SLUG_SHAPE, "[redacted-slug]");

  out = out.replace(EMAIL, "[redacted-email]");
  out = out.replace(IPV4, "[redacted-ip]");
  out = out.replace(IPV6, "[redacted-ip]");
  out = out.replace(HOME_PATH, "/home/[redacted-user]");

  for (const host of LAB_HOSTNAMES) {
    out = out.replace(
      new RegExp(`\\b${escapeRegExp(host)}\\b`, "gi"),
      "[redacted-host]",
    );
  }

  out = out.replace(URL_LIKE, (match) => {
    if (match.startsWith("github:")) {
      // Drop query/trailing punctuation sometimes attached
      const trimmed = match.replace(/[),.;]+$/, "");
      if (GITHUB_FLAKE_ALLOW.test(trimmed) && !containsSlugShape(trimmed)) {
        return match;
      }
      return "[redacted-url]";
    }
    try {
      const raw = match.replace(/^git\+/, "");
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!DOMAIN_ALLOWLIST.has(host)) return "[redacted-url]";
      if (
        containsSlugShape(u.pathname) ||
        known.some((s) => s && u.href.toLowerCase().includes(String(s).toLowerCase()))
      ) {
        return "[redacted-url]";
      }
      return match;
    } catch {
      return "[redacted-url]";
    }
  });

  out = out.replace(FQDN, (match) => {
    const lower = match.toLowerCase();
    if (DOMAIN_ALLOWLIST.has(lower)) return match;
    const labels = lower.split(".");
    if (labels.length >= 2) {
      const root = labels.slice(-2).join(".");
      if (DOMAIN_ALLOWLIST.has(root)) return match;
    }
    return "[redacted-host]";
  });

  return out;
}

/**
 * @param {string[]} fromDb
 * @param {...(string|null|undefined)} extras
 */
export function mergeKnownSlugs(fromDb = [], ...extras) {
  const set = new Set();
  for (const s of [...fromDb, ...extras]) {
    const v = s != null ? String(s).trim() : "";
    if (v) set.add(v);
  }
  return [...set];
}

/**
 * Extra burned / rotated slugs that must stay redacted even if DB rows change.
 * Comma-separated via OPS_REDACT_EXTRA_SLUGS.
 * @returns {string[]}
 */
export function getExtraRedactSlugs() {
  const raw = process.env.OPS_REDACT_EXTRA_SLUGS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Return list of hit descriptions if text still contains identifiers after redaction
 * would leave them (or raw known slugs / slug-shape tokens).
 * Used for fail-closed push gates.
 * @param {string} text
 * @param {{ knownSlugs?: string[] }} [opts]
 * @returns {string[]}
 */
export function findIdentifierHits(text, opts = {}) {
  const raw = text == null ? "" : String(text);
  const hits = [];
  const known = Array.isArray(opts.knownSlugs) ? opts.knownSlugs : [];
  for (const slug of known) {
    const s = String(slug || "").trim();
    if (s && raw.includes(s)) hits.push(`known_slug:${s.slice(0, 2)}…`);
  }
  // Slug shape (uppercase 10) still present
  const shape = raw.match(/\b[A-Z0-9]{10}\b/g) || [];
  for (const m of shape) {
    // allow synthetic test tokens that start with ZZ/YY used only in unit tests? No — fail closed on any.
    hits.push(`slug_shape:${m.slice(0, 2)}…`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(raw)) hits.push("ipv4");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(raw)) hits.push("email");
  if (/\/home\/[A-Za-z0-9._-]+/.test(raw)) hits.push("home_path");
  for (const host of ["hattori", "thatch", "agwanti"]) {
    if (new RegExp(`\\b${host}\\b`, "i").test(raw)) hits.push(`lab_host:${host}`);
  }
  return hits;
}

/**
 * @param {string} text
 * @param {{ knownSlugs?: string[] }} [opts]
 */
export function assertNoIdentifyingDetails(text, opts = {}) {
  const hits = findIdentifierHits(text, opts);
  if (hits.length) {
    const err = new Error(`redaction_fail_closed:${hits.join(",")}`);
    err.hits = hits;
    err.status = 422;
    throw err;
  }
  return true;
}
