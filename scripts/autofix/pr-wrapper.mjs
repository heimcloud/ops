#!/usr/bin/env node
/**
 * heimcloud-autofix-pr: the only code that hands the GitHub token (classic
 * PAT of the heimcloud account, scope public_repo, materialized by the
 * credentials plugin to /run/heimcloud-autofix/github-token) to the REST API.
 * The same token pushes fix/* | ops/* branches to the forks, but only through
 * heimcloud-autofix-env + the worker's push guard (push-guard.mjs).
 *
 * The worker hands it ONE GitHub REST request as JSON on stdin
 *   {"method":"GET","path":"/repos/madebydamo/neo/pulls?head=heimcloud:fix/x&state=all"}
 * and gets ONE JSON line on stdout:
 *   {"ok":true,"status":200,"data":...}          request sent (any HTTP status)
 *   {"ok":false,"refused":true,"reason":"..."}  exit 3: not on the whitelist
 *   {"ok":false,"no_token":true,...}            exit 4: token file missing
 *   {"ok":false,"error":"..."}                  exit 5: network / bad response
 *
 * Whitelist, per configured target (OPS_TARGETS, see targets.js) U = upstream:
 *   GET   /repos/U/pulls?head=heimcloud:<fix/*|ops/*>&state=open|closed|all
 *   POST  /repos/U/pulls              head heimcloud:<fix/*|ops/*> of the
 *                                     configured fork, base = baseRef,
 *                                     keys title/body/head/base/draft/
 *                                     maintainer_can_modify/head_repo only
 *   GET   /repos/U/pulls/N
 *   PATCH /repos/U/pulls/N            title/body only, our PRs only
 *   POST  /repos/U/issues/N/comments  {body}, our PRs only
 *   GET   /repos/U/issues/N/comments | /pulls/N/comments | /pulls/N/reviews
 * "Our PR" = the wrapper GETs it first: user.login = bot login, head repo =
 * the target's fork, head ref fix/* | ops/*. Everything else is refused before
 * the token is read. Outgoing title/body/comment text goes through the
 * fail-closed identifier scan (the worker runs the full gate with the DB
 * slugs before; this is defense in depth).
 * The API base is api.github.com; OPS_PR_API_BASE may only point to
 * http://127.0.0.1 / localhost (tests). No redirects are followed.
 */
import fs from "node:fs";
import { loadTargets, findTarget } from "./targets.js";
import { findIdentifierHits, getExtraRedactSlugs } from "./redact.js";

export const BRANCH_RE = /^(fix|ops)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const MAX_BODY = 60000;

export class Refused extends Error {}
const refuse = (msg) => {
  throw new Refused(msg);
};

function ownerOf(slug) {
  return String(slug).split("/")[0];
}

function validBranch(b) {
  return typeof b === "string" && BRANCH_RE.test(b) && !b.includes("..") && !b.endsWith(".lock");
}

function allowOnlyKeys(obj, keys, what) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) refuse(`${what}: body must be a JSON object`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) refuse(`${what}: field ${k} is not allowed`);
}

function checkText(v, what, max = MAX_BODY) {
  if (typeof v !== "string") refuse(`${what} must be a string`);
  if (v.length > max) refuse(`${what} is too long`);
  const hits = findIdentifierHits(v, { knownSlugs: getExtraRedactSlugs() });
  if (hits.length) refuse(`${what} blocked by the redaction gate (${hits.length} identifier hit(s))`);
}

function parseQuery(qs, allowed) {
  const out = {};
  if (!qs) return out;
  for (const part of qs.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = decodeURIComponent(i < 0 ? part : part.slice(0, i));
    const v = decodeURIComponent(i < 0 ? "" : part.slice(i + 1));
    if (!allowed.includes(k)) refuse(`query parameter ${k} is not allowed`);
    if (k in out) refuse(`duplicate query parameter ${k}`);
    out[k] = v;
  }
  return out;
}

const PAGING = ["per_page", "page", "since"];
function checkPaging(q) {
  if (q.per_page != null && !/^\d{1,3}$/.test(q.per_page)) refuse("bad per_page");
  if (q.page != null && !/^\d{1,4}$/.test(q.page)) refuse("bad page");
  if (q.since != null && !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(q.since)) refuse("bad since");
}

/**
 * Pure policy check. Returns {kind, target, number?, needsOwnership, query}
 * or throws Refused. The caller performs the ownership GET when asked.
 */
export function checkRequest(req, { targets = loadTargets() } = {}) {
  if (!req || typeof req !== "object") refuse("request must be a JSON object");
  const method = String(req.method || "").toUpperCase();
  const full = String(req.path || "");
  if (!full.startsWith("/repos/") || /[\s#\\]|%2f|%2e|\/\.\.?(\/|$|\?)/i.test(full)) refuse("path not allowed");
  const [p, qs = ""] = full.split(/\?(.*)/s, 2);
  const m = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)$/.exec(p);
  if (!m) refuse("path not allowed");
  const target = findTarget(targets, `${m[1]}/${m[2]}`);
  // Exact upstream only (case-insensitive lookup, but the path must name it).
  if (!target) refuse(`repo ${m[1]}/${m[2]} is not a configured target`);
  const rest = m[3];
  const body = req.body;
  let r;
  if ((r = /^\/pulls$/.exec(rest))) {
    if (method === "GET") {
      const q = parseQuery(qs, ["head", "state", ...PAGING]);
      checkPaging(q);
      const hm = /^([A-Za-z0-9-]+):(.+)$/.exec(q.head || "");
      if (!hm || hm[1].toLowerCase() !== ownerOf(target.fork).toLowerCase() || !validBranch(hm[2])) refuse("pull list needs head=heimcloud:<fix/*|ops/*>");
      if (q.state != null && !["open", "closed", "all"].includes(q.state)) refuse("bad state");
      return { kind: "list_pulls", target, query: q };
    }
    if (method === "POST") {
      if (qs) refuse("no query on create");
      allowOnlyKeys(body, ["title", "body", "head", "base", "draft", "maintainer_can_modify", "head_repo"], "create pull");
      const hm = /^([A-Za-z0-9-]+):(.+)$/.exec(String(body.head || ""));
      if (!hm || hm[1] !== ownerOf(target.fork) || !validBranch(hm[2])) refuse("head must be heimcloud:<fix/*|ops/*> of the configured fork");
      if (body.head_repo != null && body.head_repo !== target.fork && body.head_repo !== target.fork.split("/")[1]) refuse("head_repo must be the configured fork");
      if (target.fork.split("/")[1] !== target.upstream.split("/")[1] && body.head_repo == null) refuse("head_repo required: the fork name differs from the upstream");
      if (body.base !== target.baseRef) refuse(`base must be ${target.baseRef}`);
      if (body.draft != null && typeof body.draft !== "boolean") refuse("draft must be a boolean");
      if (body.maintainer_can_modify != null && body.maintainer_can_modify !== false) refuse("maintainer_can_modify must be false");
      checkText(body.title, "title", 256);
      checkText(body.body ?? "", "body");
      return { kind: "create_pull", target, branch: hm[2] };
    }
    refuse(`${method} /pulls is not allowed`);
  }
  if ((r = /^\/pulls\/([1-9]\d{0,8})$/.exec(rest))) {
    const number = Number(r[1]);
    if (method === "GET") {
      if (qs) refuse("no query");
      return { kind: "get_pull", target, number };
    }
    if (method === "PATCH") {
      if (qs) refuse("no query");
      allowOnlyKeys(body, ["title", "body"], "update pull");
      if (!Object.keys(body).length) refuse("update pull: nothing to change");
      if (body.title != null) checkText(body.title, "title", 256);
      if (body.body != null) checkText(body.body, "body");
      return { kind: "update_pull", target, number, needsOwnership: true };
    }
    refuse(`${method} /pulls/N is not allowed`);
  }
  if ((r = /^\/issues\/([1-9]\d{0,8})\/comments$/.exec(rest))) {
    const number = Number(r[1]);
    if (method === "GET") {
      const q = parseQuery(qs, PAGING);
      checkPaging(q);
      return { kind: "list_issue_comments", target, number };
    }
    if (method === "POST") {
      if (qs) refuse("no query");
      allowOnlyKeys(body, ["body"], "comment");
      checkText(body.body, "comment", 20000);
      if (!body.body.trim()) refuse("empty comment");
      return { kind: "create_comment", target, number, needsOwnership: true };
    }
    refuse(`${method} /issues/N/comments is not allowed`);
  }
  if ((r = /^\/pulls\/([1-9]\d{0,8})\/(comments|reviews)$/.exec(rest))) {
    if (method !== "GET") refuse(`${method} /pulls/N/${r[2]} is not allowed`);
    const q = parseQuery(qs, PAGING);
    checkPaging(q);
    return { kind: r[2] === "reviews" ? "list_reviews" : "list_review_comments", target, number: Number(r[1]) };
  }
  refuse("path not allowed");
}

/** "Our PR": opened by the bot from the configured fork on a fix/* | ops/* branch. */
export function isOwnPull(pr, target, botLogin) {
  return Boolean(
    pr &&
      pr.user &&
      String(pr.user.login || "").toLowerCase() === String(botLogin).toLowerCase() &&
      pr.head &&
      pr.head.repo &&
      String(pr.head.repo.full_name || "").toLowerCase() === target.fork.toLowerCase() &&
      validBranch(pr.head.ref) &&
      pr.base &&
      pr.base.repo &&
      String(pr.base.repo.full_name || "").toLowerCase() === target.upstream.toLowerCase(),
  );
}

export function apiBase(env = process.env) {
  const v = String(env.OPS_PR_API_BASE || "").replace(/\/+$/, "");
  if (!v) return "https://api.github.com";
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(v)) return v;
  refuse("OPS_PR_API_BASE may only point to http://127.0.0.1 or localhost");
}

export function readToken(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 4096) return null;
    const t = fs.readFileSync(fd, "utf8").trim();
    return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

async function call(base, token, method, apiPath, body) {
  const res = await fetch(base + apiPath, {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "heimcloud-ops-autofix",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const scopes = res.headers.get("x-oauth-scopes");
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 500) };
  }
  return { status: res.status, data, scopes };
}

/**
 * `--check`: does the token work for the API side? GET /user (login must be
 * the bot login, classic scopes must include public_repo or repo) and GET
 * /repos/<fork> for every allowlisted fork (permissions.push). Prints only
 * booleans / logins / scope names, never the token.
 */
export async function checkMode(env = process.env) {
  const targets = loadTargets(env);
  const botLogin = env.OPS_PR_BOT_LOGIN || "heimcloud";
  const base = apiBase(env);
  const token = readToken(env.OPS_PR_TOKEN_FILE || "/run/heimcloud-autofix/github-token");
  if (!token) return { code: 4, out: { ok: false, no_token: true, reason: "token file missing or unreadable" } };
  const u = await call(base, token, "GET", "/user");
  const scopes = String(u.scopes || "").split(",").map((x) => x.trim()).filter(Boolean);
  const out = {
    ok: false,
    login: u.status === 200 ? String(u.data?.login || "") : null,
    login_ok: u.status === 200 && String(u.data?.login || "").toLowerCase() === botLogin.toLowerCase(),
    scopes,
    scope_ok: scopes.includes("public_repo") || scopes.includes("repo"),
    forks: {},
  };
  for (const t of targets) {
    const r = await call(base, token, "GET", `/repos/${t.fork}`);
    out.forks[t.fork] = r.status === 200 ? { exists: true, push: r.data?.permissions?.push === true } : { exists: false, status: r.status };
  }
  out.ok = out.login_ok && out.scope_ok && Object.values(out.forks).every((f) => f.exists && f.push);
  return { code: out.ok ? 0 : 1, out };
}

export async function handle(req, env = process.env) {
  const targets = loadTargets(env);
  const botLogin = env.OPS_PR_BOT_LOGIN || "heimcloud";
  const ck = checkRequest(req, { targets });
  const base = apiBase(env);
  const tokenFile = env.OPS_PR_TOKEN_FILE || "/run/heimcloud-autofix/github-token";
  const token = readToken(tokenFile);
  if (!token) return { code: 4, out: { ok: false, no_token: true, reason: "PR token file missing or unreadable" } };
  const method = String(req.method).toUpperCase();
  if (ck.needsOwnership) {
    const pr = await call(base, token, "GET", `/repos/${ck.target.upstream}/pulls/${ck.number}`);
    if (pr.status !== 200) return { code: 3, out: { ok: false, refused: true, reason: `ownership check failed (HTTP ${pr.status})` } };
    if (!isOwnPull(pr.data, ck.target, botLogin)) return { code: 3, out: { ok: false, refused: true, reason: "not a PR opened by the autofix bot from the configured fork" } };
  }
  const r = await call(base, token, method, String(req.path), req.body === undefined || method === "GET" ? undefined : req.body);
  return { code: 0, out: { ok: true, status: r.status, data: r.data } };
}

async function main() {
  if (process.argv.includes("--check")) {
    let res;
    try {
      res = await checkMode();
    } catch (err) {
      res = { code: 5, out: { ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) } };
    }
    process.stdout.write(JSON.stringify(res.out) + "\n");
    process.exitCode = res.code;
    return;
  }
  let raw = "";
  for await (const c of process.stdin) {
    raw += c;
    if (raw.length > 200000) break;
  }
  let out;
  let code = 0;
  try {
    const req = JSON.parse(raw);
    ({ code, out } = await handle(req));
  } catch (err) {
    if (err instanceof Refused) {
      code = 3;
      out = { ok: false, refused: true, reason: err.message };
    } else {
      code = 5;
      out = { ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) };
    }
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = code;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("heimcloud-autofix-pr")) {
  main();
}
