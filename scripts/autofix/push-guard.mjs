/**
 * Push guard: the one token (classic PAT, heimcloud account, public_repo) may
 * only push fix/* | ops/* branches to the allowlisted heimcloud forks.
 *
 * Every push the worker makes goes through guardedPush():
 *  - the destination is an explicit URL https://github.com/<fork>.git of a
 *    configured target fork (never a remote name: the clone's config is
 *    written partly by Hermes and could carry pushurl / push refspecs);
 *  - git's effective URL for it (`ls-remote --get-url`, i.e. after any
 *    insteadOf / pushInsteadOf rewrite) must be the same URL;
 *  - exactly one refspec <sha>:refs/heads/<fix/*|ops/*>, never the fork's
 *    base branch, never a tag, no --mirror / --all / --tags / --delete;
 *  - hooks off (core.hooksPath=/dev/null + --no-verify), no include.* or
 *    credential.* entries in the clone's local config;
 *  - GH_TOKEN / GITHUB_TOKEN / GH_PR_TOKEN are dropped for git itself: the
 *    credential reaches git only through heimcloud-autofix-env's per-process,
 *    path-scoped helper.
 * Branch protection on the heimcloud default branches (no force-push, no
 * deletion) is the backstop, not the control.
 */
import { findTargetByFork } from "./targets.js";

export const PUSH_BRANCH_RE = /^(fix|ops)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export class PushRefused extends Error {}

export function forkPushUrl(fork, githubBase = "") {
  return githubBase ? `${githubBase.replace(/\/+$/, "")}/${fork}.git` : `https://github.com/${fork}.git`;
}

/**
 * Pure policy check. Returns {target, url, refspec} or throws PushRefused.
 * opts.githubBase: tests only (local bare repos instead of github.com).
 */
export function checkPush({ targets, fork, branch, sha, githubBase = "", localUrl = "" }) {
  const target = findTargetByFork(targets, fork);
  if (!target) throw new PushRefused(`fork ${fork} is not an allowlisted target fork`);
  const b = String(branch || "");
  if (!PUSH_BRANCH_RE.test(b) || b.includes("..") || b.endsWith(".lock") || b.includes("@{")) throw new PushRefused(`branch ${b} is not fix/* or ops/*`);
  if (b === target.baseRef || /^refs\//.test(b)) throw new PushRefused("refusing to push the base branch or a raw ref");
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(sha || ""))) throw new PushRefused("push needs a full commit id");
  // Tests push to local bare repos (absolute path / file://); never a remote host.
  const url = localUrl && /^(\/|file:\/\/\/)/.test(localUrl) && !localUrl.includes("..") ? localUrl : forkPushUrl(target.fork, githubBase);
  return { target, url, refspec: `${sha}:refs/heads/${b}` };
}

/** Local config keys that may redirect a push or reach the credential. */
export function dangerousLocalConfig(lines) {
  return String(lines || "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0].toLowerCase())
    .filter((k) => k && /^(include\.|includeif\.|credential\.|url\..*\.(insteadof|pushinsteadof)$|core\.hookspath$|core\.sshcommand$|http\..*extraheader$|http\.extraheader$)/.test(k));
}

/**
 * Guarded push. deps: { run(cmd,args,opts), git(dir,args,opts), envBin, gitEnv,
 * supervise }. Returns {pushed:true,url} | {pushed:false, refused?, error}.
 */
export function guardedPush(cfg, dir, branch, { force = false, deps }) {
  const sha = deps.git(dir, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  let ck;
  try {
    ck = checkPush({ targets: cfg.targets, fork: cfg.target?.fork || "heimcloud/neo", branch, sha, githubBase: cfg.githubBase && /^(\/|file:\/\/\/)/.test(cfg.githubBase) ? cfg.githubBase : "", localUrl: cfg.forkUrl });
  } catch (err) {
    return { pushed: false, refused: true, error: err.message };
  }
  const local = deps.git(dir, ["config", "--local", "--list", "--name-only"]);
  const bad = dangerousLocalConfig(local.stdout);
  if (bad.length) return { pushed: false, refused: true, error: `clone config has ${bad.slice(0, 3).join(", ")}; refusing to push` };
  const eff = deps.git(dir, ["ls-remote", "--get-url", ck.url]).stdout.trim();
  if (eff !== ck.url) return { pushed: false, refused: true, error: "the push URL is rewritten by git config; refusing to push" };
  const args = [
    "env", "-u", "GH_PR_TOKEN", "-u", "GH_TOKEN", "-u", "GITHUB_TOKEN",
    "git", "-c", "core.hooksPath=/dev/null", "-c", "push.recurseSubmodules=no", "-C", dir,
    "push", "--no-verify", "--no-follow-tags", ...(force ? ["--force"] : []), ck.url, ck.refspec,
  ];
  const r = deps.run(deps.envBin, args, { env: deps.gitEnv(), timeout: 900_000, supervise: deps.supervise, unsetEnv: ["GH_PR_TOKEN"] });
  if (r.status !== 0) return { pushed: false, error: `${r.stderr}\n${r.stdout}\n${r.error || ""}` };
  return { pushed: true, url: ck.url, sha };
}
