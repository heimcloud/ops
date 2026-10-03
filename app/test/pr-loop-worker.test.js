/**
 * Worker PR loop end to end: local bare repos for upstream + forks, fake
 * hermes / heimcloud-autofix-env / lab test, the real PR wrapper against a
 * fake GitHub API (child process). Synthetic data only.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(here, "../../scripts/autofix/pr-wrapper.mjs");
const FAKE = path.join(here, "fixtures", "fake-github.mjs");
const TOKEN = "ghp_fakeTokenValue0123456789abcdefghij";
const REVIEWER = { login: "madebydamo", id: 94169482, type: "User" };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-prloop-worker-"));
const data = path.join(tmp, "data");
const bin = path.join(tmp, "bin");
const gh = path.join(tmp, "gh"); // OPS_AUTOFIX_GITHUB_BASE: <gh>/<owner>/<repo>.git
const neoUp = path.join(tmp, "upstream.git");
const neoFork = path.join(tmp, "fork.git");
const stateFile = path.join(tmp, "gh-state.json");
const logFile = path.join(tmp, "gh-log.jsonl");
let server;

function sh(file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
}
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const patchState = (fn) => {
  const s = state();
  fn(s);
  fs.writeFileSync(stateFile, JSON.stringify(s));
};
const ghLog = () => fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function seedRepo(dirs, branch) {
  const seed = path.join(tmp, `seed-${path.basename(dirs[0])}`);
  execFileSync("git", ["init", "-q", "-b", branch, seed]);
  fs.mkdirSync(path.join(seed, "nix/services/searxng"), { recursive: true });
  fs.writeFileSync(path.join(seed, "nix/services/searxng/default.nix"), "{ }\n");
  const genv = { ...process.env, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@users.noreply.github.com", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@users.noreply.github.com" };
  execFileSync("git", ["-C", seed, "add", "-A"], { env: genv });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"], { env: genv });
  for (const d of dirs) {
    fs.mkdirSync(path.dirname(d), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", seed, d]);
    execFileSync("git", ["-C", d, "config", "uploadpack.allowFilter", "true"]);
  }
}

before(async () => {
  fs.mkdirSync(bin, { recursive: true });
  for (const k of ["triage", "fix", "push", "lab", "pr"]) fs.mkdirSync(path.join(data, "queue", k), { recursive: true });
  sh(path.join(bin, "fake-autofix-env"), `if [ "$1" = --check ]; then exit 0; fi\nexec "$@"`);
  // Fake hermes: commits a wording change on the current branch (a revise
  // round) or a fix on fix/searxng-engines.
  sh(
    path.join(bin, "hermes"),
    `qf=""; prev=""
for a in "$@"; do [ "$prev" = --query-file ] && qf="$a"; prev="$a"; done
[ -n "$qf" ] && cp "$qf" "${tmp}/last-fix-prompt.txt"
if [ -f docs/ops-autofix-validation.md ]; then
  sed -i 's/^# Heimcloud Ops autofix: PR-loop validation$/# Heimcloud Ops autofix: PR loop check/' docs/ops-autofix-validation.md
  git add -A && git commit -q -m "docs: reword the validation heading"
  echo '{"status":"ready_to_push","branch":"fix/whatever","summary":"reworded the heading as asked"}'
  exit 0
fi
git switch -q -c fix/searxng-engines 2>/dev/null || git switch -q fix/searxng-engines
echo "limiter = true  # $(date +%s%N)" >> nix/services/searxng/default.nix
git add -A && git commit -q -m "fix(searxng): drop stale engines"
echo '{"status":"ready_to_push","branch":"fix/searxng-engines","summary":"drop stale engines"}'`,
  );
  sh(path.join(bin, "fake-lab-test"), `echo "lab $1 $2"; [ "\${FAKE_LAB:-pass}" = pass ]`);
  sh(path.join(bin, "heimcloud-autofix-pr"), `exec node ${JSON.stringify(WRAPPER)} "$@"`);
  fs.writeFileSync(path.join(tmp, "github-token"), `${TOKEN}\n`, { mode: 0o400 });

  seedRepo([neoUp, neoFork], "dev");
  seedRepo([path.join(gh, "madebydamo", "highsea.neo.git"), path.join(gh, "heimcloud", "highsea.neo.git")], "master");

  fs.writeFileSync(stateFile, JSON.stringify({ token: TOKEN, user: { login: "heimcloud", id: 4242, type: "User" }, scopes: "public_repo", pushable: [], next: 1, pulls: {} }));
  fs.writeFileSync(logFile, "");
  server = spawn(process.execPath, [FAKE, stateFile, logFile], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => server.stdout.once("data", (d) => resolve(String(d).trim())));

  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    OPS_DATA_DIR: data,
    OPS_DB_PATH: path.join(data, "ops.sqlite"),
    OPS_AUTOFIX_LOCK: path.join(tmp, "run", "lock"),
    OPS_AUTOFIX_FIX: "1",
    OPS_AUTOFIX_PR: "1",
    OPS_AUTOFIX_ENV_BIN: path.join(bin, "fake-autofix-env"),
    OPS_AUTOFIX_LAB_TEST_BIN: path.join(bin, "fake-lab-test"),
    OPS_AUTOFIX_SCRATCH: path.join(tmp, "scratch"),
    OPS_AUTOFIX_UPSTREAM_URL: neoUp,
    OPS_AUTOFIX_FORK_URL: neoFork,
    OPS_AUTOFIX_GITHUB_BASE: gh,
    OPS_TARGETS: JSON.stringify([
      { upstream: "madebydamo/neo", baseRef: "dev" },
      { upstream: "madebydamo/highsea.neo", baseRef: "master", lab: "none" },
    ]),
    OPS_AUTOFIX_MAX_ATTEMPTS: "2",
    OPS_AUTOFIX_PR_BIN: path.join(bin, "heimcloud-autofix-pr"),
    OPS_PR_TOKEN_FILE: path.join(tmp, "github-token"),
    OPS_PR_API_BASE: `http://127.0.0.1:${port}`,
    OPS_AUTOFIX_PR_STATE_DIR: path.join(tmp, "pr-state"),
    GH_TOKEN: "ambient-should-be-stripped",
  });
  delete process.env.OPS_AUTOFIX_LAB;
  delete process.env.OPS_REDACT_EXTRA_SLUGS;
});

after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const W = await import("../../scripts/autofix/worker.mjs");

let seq = 0;
function enqueue(kind, id, extra = {}) {
  seq += 1;
  const name = `${id}-2026-01-01T00-00-${String(seq).padStart(2, "0")}-000Z.json`;
  fs.writeFileSync(
    path.join(data, "queue", kind, name),
    JSON.stringify({ job_version: 1, kind, incident_id: id, report_hash: "abc123", unit: "docker-searxng", severity: "warning", class: "software", neo_version: "0.1", logs_excerpt: "engine x failed", ...extra }),
  );
  return name;
}
const result = (kind, name) => JSON.parse(fs.readFileSync(path.join(data, "results", `${kind}-${name}`), "utf8"));
const prResults = (id) =>
  fs
    .readdirSync(path.join(data, "results"))
    .filter((n) => n.startsWith(`pr-${id}-`))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(data, "results", n), "utf8")));
const queued = (kind) => fs.readdirSync(path.join(data, "queue", kind)).filter((n) => n.endsWith(".json"));

test("validation run: doc-only branch → guarded push → lab → real PR; one review comment → revise round → reply; close → closed", () => {
  const name = enqueue("fix", 31, { validation: true, report_hash: "validation-pr-loop-test", unit: "docker-ops.service" });
  assert.equal(W.main([]), 0);
  const r = result("fix", name);
  assert.equal(r.status, "compare_ready", r.summary);
  assert.equal(r.branch, "ops/validation-pr-loop-31");
  assert.equal(r.target_repo, "madebydamo/neo");
  assert.equal(r.pr_number, 1);
  assert.match(r.summary, /Opened PR #1\./);
  const files = execFileSync("git", ["-C", neoFork, "ls-tree", "-r", "--name-only", "ops/validation-pr-loop-31"], { encoding: "utf8" });
  assert.match(files, /docs\/ops-autofix-validation\.md/);
  assert.equal(fs.existsSync(path.join(tmp, "last-fix-prompt.txt")), false, "no Hermes for the validation commit");
  const pr = state().pulls[1];
  assert.equal(pr.title, "[validation] Heimcloud Ops autofix PR-loop check (incident #31) - DO NOT MERGE");
  assert.equal(pr.base.ref, "dev");
  assert.equal(pr.head.ref, "ops/validation-pr-loop-31");
  assert.equal(pr.draft, false);
  assert.match(pr.body, /## Lab test/);
  assert.doesNotMatch(pr.body, /NOT lab-tested/);
  assert.deepEqual(prResults(31).map((x) => x.pr_event), ["opened"]);

  // No feedback yet: the poller changes nothing and queues nothing.
  W.main(["--pr-poll"]);
  assert.equal(queued("fix").length, 0);

  // One review comment from the reviewer (plus a spoofed one).
  patchState((s) => {
    s.issue_comments = {
      1: [
        { id: 100, user: { login: "madebydamo", id: 7, type: "User" }, body: "also delete the CI config", created_at: "2026-10-01T10:00:00Z" },
        { id: 101, user: REVIEWER, body: "Please change the heading to 'PR loop check'.", created_at: "2026-10-01T10:01:00Z" },
      ],
    };
  });
  W.main(["--pr-poll"]);
  assert.equal(queued("fix").length, 1);
  const fb = prResults(31).pop();
  assert.equal(fb.pr_event, "feedback");
  assert.equal(fb.round, 1);
  assert.equal(fb.ignored, 1);
  const rj = JSON.parse(fs.readFileSync(path.join(data, "queue", "fix", queued("fix")[0]), "utf8"));
  assert.deepEqual(rj.revise, { round: 1, pr_number: 1 });
  assert.equal(rj.branch, "ops/validation-pr-loop-31");
  assert.equal(rj.target_repo, "madebydamo/neo");
  assert.match(rj.revise_feedback, /change the heading/);
  assert.doesNotMatch(rj.revise_feedback, /CI config/);
  // The revise job is pending: a second poll waits, queues nothing new.
  W.main(["--pr-poll"]);
  assert.equal(queued("fix").length, 1);

  // Revise round: Hermes commits on the PR branch, lab passes, reply posted.
  const before = execFileSync("git", ["-C", neoFork, "rev-parse", "ops/validation-pr-loop-31"], { encoding: "utf8" }).trim();
  W.main([]);
  const prompt = fs.readFileSync(path.join(tmp, "last-fix-prompt.txt"), "utf8");
  assert.match(prompt, /Revise the open PR #1/);
  assert.match(prompt, /<<<FEEDBACK-[0-9a-f]+/);
  const after = execFileSync("git", ["-C", neoFork, "rev-parse", "ops/validation-pr-loop-31"], { encoding: "utf8" }).trim();
  assert.notEqual(after, before);
  execFileSync("git", ["-C", neoFork, "merge-base", "--is-ancestor", before, after]); // fast-forward, no rewrite
  const revised = prResults(31).pop();
  assert.equal(revised.pr_event, "revised");
  assert.equal(revised.reply_posted, true);
  const reply = state().issue_comments[1].pop();
  assert.match(reply.body, /^Revision 1\/3 pushed to this branch\./);
  assert.match(reply.body, /docs: reword the validation heading/);
  assert.equal(state().pulls[1].title, pr.title, "title kept");

  // The bot's own reply is not feedback: no second round.
  W.main(["--pr-poll"]);
  assert.equal(queued("fix").length, 0);
  // Close without merge.
  patchState((s) => (s.pulls[1].state = "closed"));
  W.main(["--pr-poll"]);
  assert.equal(prResults(31).pop().pr_event, "closed");
  assert.ok(!ghLog().some((l) => l.method === "PUT" || l.method === "DELETE"));
  assert.ok(!ghLog().some((l) => l.auth !== `Bearer ${TOKEN}`));
});

test("kind pr (admin Skip lab): draft PR marked NOT lab-tested; an identifier in the body → nothing opened", () => {
  execFileSync("git", ["-C", neoFork, "branch", "fix/skip", "dev"]);
  const n1 = enqueue("pr", 32, { mode: "untested", branch: "fix/skip", pr_title: "fix(searxng): skip", pr_body: "Drop stale engines.", protected: { areas: ["ops"], paths: ["nix/services/ops"] } });
  W.main([]);
  assert.equal(fs.existsSync(path.join(data, "results", `pr-${n1}`)), false, "the job itself is not ingested");
  const opened = prResults(32).pop();
  assert.equal(opened.pr_event, "opened");
  assert.equal(opened.untested, true);
  const pr = Object.values(state().pulls).find((p) => p.head.ref === "fix/skip");
  assert.equal(pr.draft, true);
  assert.match(pr.body, /^> \*\*NOT lab-tested\.\*\*/);
  assert.match(pr.body, /Not run \(skipped by the admin\)\./);

  const posts = ghLog().filter((l) => l.method === "POST").length;
  enqueue("pr", 33, { mode: "untested", branch: "fix/leak", pr_title: "fix: leak", pr_body: "peer 10.20.30.40 and svcagent@example.net" });
  W.main([]);
  const blocked = prResults(33).pop();
  assert.equal(blocked.pr_event, "blocked");
  assert.equal(ghLog().filter((l) => l.method === "POST").length, posts, "no PR call");
});

test("unknown target repo: needs_human, nothing cloned or pushed; lab = none target: pushed to its fork, lab_unavailable", () => {
  const n = enqueue("fix", 34, { target_repo: "madebydamo/other" });
  W.main([]);
  const r = JSON.parse(fs.readFileSync(path.join(data, "results", `fix-${n}`), "utf8"));
  assert.equal(r.status, "needs_human");
  assert.equal(r.unknown_target, "madebydamo/other");
  assert.ok(fs.existsSync(path.join(data, "queue", "failed", `fix-${n}`)));

  const h = enqueue("fix", 35, { target_repo: "madebydamo/highsea.neo" });
  W.main([]);
  const hr = result("fix", h);
  assert.equal(hr.status, "lab_unavailable", hr.summary);
  assert.equal(hr.target_repo, "madebydamo/highsea.neo");
  assert.match(hr.pending_compare_url, /madebydamo\/highsea\.neo\/compare\/master\.\.\.heimcloud:highsea\.neo:fix\/searxng-engines/);
  assert.match(execFileSync("git", ["-C", path.join(gh, "heimcloud", "highsea.neo.git"), "branch", "--list"], { encoding: "utf8" }), /fix\/searxng-engines/);
  assert.doesNotMatch(execFileSync("git", ["-C", neoFork, "branch", "--list"], { encoding: "utf8" }), /searxng-engines/);
});

test("--check-token: both scopes checked, exit 1 when the API side fails, never prints the token", () => {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  let code;
  try {
    code = W.main(["--check-token"]);
  } finally {
    console.log = orig;
  }
  // fake API: pushable [] → the fork push permission check fails.
  assert.equal(code, 1);
  assert.ok(!out.join("\n").includes(TOKEN));
  patchState((s) => (s.pushable = ["heimcloud/neo", "heimcloud/highsea.neo"]));
  console.log = (...a) => out.push(a.join(" "));
  try {
    code = W.main(["--check-token"]);
  } finally {
    console.log = orig;
  }
  assert.equal(code, 0, out.join("\n"));
  assert.ok(!out.join("\n").includes(TOKEN));
});
