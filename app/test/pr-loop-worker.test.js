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

// ------------------------------------------------ open failure / adoption

const forkPr = (number, ref, extra = {}) => ({
  number,
  html_url: `https://github.com/madebydamo/neo/pull/${number}`,
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  title: `fix: ${ref}`,
  body: "Opened from the compare link.",
  user: REVIEWER,
  head: { ref, sha: "c".repeat(40), repo: { full_name: "heimcloud/neo", owner: "heimcloud" } },
  base: { ref: "dev", repo: { full_name: "madebydamo/neo" } },
  requested_reviewers: [],
  ...extra,
});
const recordFile = (id) => path.join(tmp, "pr-state", `${id}.json`);
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return { ret: fn(), lines };
  } finally {
    console.log = orig;
  }
}

test("open failure (HTTP 403): pr_open_failed with a redacted reason, no PR record; Retry open PR adopts the PR opened from the compare link", () => {
  patchState((s) => (s.create_fail = { status: 403, message: "Resource not accessible by personal access token" }));
  const name = enqueue("fix", 50, { validation: true, report_hash: "validation-pr-loop-50", unit: "docker-ops.service" });
  const { lines } = captureLog(() => W.main([]));
  const r = result("fix", name);
  assert.equal(r.status, "pr_open_failed", r.summary);
  assert.equal(r.pr_number, undefined);
  assert.match(r.pr_error, /HTTP 403/);
  assert.match(r.compare_url, /compare\/dev\.\.\.heimcloud:neo:ops\/validation-pr-loop-50/);
  assert.match(r.summary, /Retry open PR/);
  const side = prResults(50).pop();
  assert.equal(side.pr_event, "error");
  assert.equal(side.pr_number, undefined);
  assert.equal(fs.existsSync(recordFile(50)), false, "no autofix-pr record without a PR");
  // BUG-7: the job log line names the status, never "undefined".
  assert.ok(lines.some((l) => /fix incident 50: pr_open_failed - /.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /undefined/.test(l)), lines.join("\n"));

  // Damo opened it from the compare link; Retry open PR adopts it (no second create).
  patchState((s) => {
    delete s.create_fail;
    s.pulls[60] = forkPr(60, "ops/validation-pr-loop-50");
  });
  const posts = ghLog().filter((l) => l.method === "POST" && /\/pulls$/.test(l.path)).length;
  enqueue("pr", 50, { mode: "open", branch: "ops/validation-pr-loop-50", head_sha: r.head_sha, pr_title: r.pr_title, pr_body: r.pr_body, target_repo: "madebydamo/neo" });
  W.main([]);
  const adopted = prResults(50).pop();
  assert.equal(adopted.pr_event, "adopted");
  assert.equal(adopted.pr_number, 60);
  assert.equal(JSON.parse(fs.readFileSync(recordFile(50), "utf8")).number, 60);
  assert.equal(ghLog().filter((l) => l.method === "POST" && /\/pulls$/.test(l.path)).length, posts, "adopted, not created");
});

test("pr-poll discovery: untracked fork PRs mapping to an incident are adopted with a baseline; only new reviewer comments drive a revise", async () => {
  // Fake sqlite3 CLI (worker contract: -readonly -json db sql) over the app DB.
  fs.writeFileSync(
    path.join(bin, "sqlite3"),
    `#!${process.execPath}
const Database = require(${JSON.stringify(path.resolve(here, "..", "node_modules", "better-sqlite3"))});
const a = process.argv.slice(2);
if (a[0] !== "-readonly" || a[1] !== "-json") process.exit(2);
const db = new Database(a[2], { readonly: true, fileMustExist: true });
const rows = db.prepare(a[3]).all();
process.stdout.write(rows.length ? JSON.stringify(rows) : "");
`,
    { mode: 0o755 },
  );
  const db = await import("../lib/db.js");
  const byBranch = db.upsertIncident({ report_hash: "disc-1", unit: "docker-searxng.service", severity: "warning", logs_excerpt: "engine x failed" }).incident;
  db.addIncidentEvent(byBranch.id, "fix_result", "pushed", { branch: "fix/discovered-a", status: "compare_ready" });
  const byBody = db.upsertIncident({ report_hash: "disc-2", unit: "docker-searxng.service", severity: "warning", logs_excerpt: "engine y failed" }).incident;
  const closed = db.upsertIncident({ report_hash: "disc-3", unit: "docker-searxng.service", severity: "warning", logs_excerpt: "z" }).incident;
  db.updateIncident(closed.id, { status: "closed" });
  db._resetDbForTests?.();
  patchState((s) => {
    s.pulls[70] = forkPr(70, "fix/discovered-a");
    s.pulls[71] = forkPr(71, "fix/some-change", { body: `Heimcloud Ops incident #${byBody.id}\n\nhand-made PR` });
    s.pulls[72] = forkPr(72, "fix/unrelated");
    s.pulls[73] = forkPr(73, `ops/incident-${closed.id}`);
    s.pulls[74] = forkPr(74, "fix/discovered-a", { head: { ref: "fix/discovered-a", sha: "d".repeat(40), repo: { full_name: "someone/neo", owner: "someone" } } });
    s.issue_comments = { ...(s.issue_comments || {}), 70: [{ id: 700, user: REVIEWER, body: "old remark before adoption", created_at: "2026-10-01T09:00:00Z" }] };
  });
  const before = queued("fix").length;
  const { lines } = captureLog(() => W.main(["--pr-poll"]));
  const a = prResults(byBranch.id);
  assert.deepEqual(a.map((x) => x.pr_event).slice(0, 1), ["adopted"], JSON.stringify(a));
  assert.equal(a[0].pr_number, 70);
  assert.equal(prResults(byBody.id)[0].pr_number, 71);
  assert.deepEqual(prResults(closed.id), [], "closed incident: not adopted");
  for (const n of [72, 74]) assert.ok(!fs.readdirSync(path.join(tmp, "pr-state")).some((f) => JSON.parse(fs.readFileSync(path.join(tmp, "pr-state", f), "utf8")).number === n), `PR ${n} not adopted`);
  assert.equal(JSON.parse(fs.readFileSync(recordFile(byBranch.id), "utf8")).adopted_by, "discovery");
  assert.equal(queued("fix").length, before, "comments before adoption are the baseline");
  assert.ok(lines.some((l) => new RegExp(`pr-poll incident ${byBranch.id} PR #70: adopted`).test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /undefined/.test(l)), lines.join("\n"));
  // A second poll does not adopt again.
  W.main(["--pr-poll"]);
  assert.equal(prResults(byBranch.id).filter((x) => x.pr_event === "adopted").length, 1);
  // A new reviewer comment → revise round on the adopted PR's branch.
  patchState((s) => s.issue_comments[70].push({ id: 701, user: REVIEWER, body: "Please also keep the old engine list.", created_at: "2026-10-02T09:00:00Z" }));
  W.main(["--pr-poll"]);
  assert.equal(prResults(byBranch.id).pop().pr_event, "feedback");
  const jobs = queued("fix").filter((n) => n.startsWith(`${byBranch.id}-`));
  assert.equal(jobs.length, 1);
  const rj = JSON.parse(fs.readFileSync(path.join(data, "queue", "fix", jobs[0]), "utf8"));
  assert.equal(rj.branch, "fix/discovered-a");
  assert.deepEqual(rj.revise, { round: 1, pr_number: 70 });
  assert.match(rj.revise_feedback, /keep the old engine list/);
  assert.doesNotMatch(rj.revise_feedback, /old remark/);
  for (const n of queued("fix")) fs.rmSync(path.join(data, "queue", "fix", n));
  patchState((s) => {
    for (const n of [70, 71, 72, 73, 74]) s.pulls[n].state = "closed";
  });
  W.main(["--pr-poll"]);
});

test("admin Adopt PR (kind pr, mode adopt): fork PR tracked with a baseline; a foreign head → adopt_failed, nothing tracked", () => {
  patchState((s) => {
    s.pulls[80] = forkPr(80, "fix/by-hand");
    s.pulls[81] = forkPr(81, "fix/by-hand", { head: { ref: "fix/by-hand", sha: "e".repeat(40), repo: { full_name: "someone/neo", owner: "someone" } } });
  });
  enqueue("pr", 55, { mode: "adopt", pr_number: 81, target_repo: "madebydamo/neo" });
  W.main([]);
  const bad = prResults(55).pop();
  assert.equal(bad.pr_event, "adopt_failed");
  assert.match(bad.summary, /not from heimcloud\/neo/);
  assert.equal(fs.existsSync(recordFile(55)), false);
  enqueue("pr", 55, { mode: "adopt", pr_number: 80, target_repo: "madebydamo/neo" });
  W.main([]);
  const ok = prResults(55).pop();
  assert.equal(ok.pr_event, "adopted");
  assert.equal(ok.pr_number, 80);
  assert.equal(ok.branch, "fix/by-hand");
  const rec = JSON.parse(fs.readFileSync(recordFile(55), "utf8"));
  assert.equal(rec.adopted_by, "admin");
  assert.equal(rec.baseline_pending, true);
  patchState((s) => (s.pulls[80].state = "closed"));
  W.main(["--pr-poll"]);
});

test("fine-grained token: --check-token says so (exit 2, push ok), the PR loop is disabled and a lab pass falls back to the compare link", () => {
  const tf = path.join(tmp, "github-token");
  const FG = "github_pat_11FAKE0fineGrained0123456789";
  const setToken = (t, bump) => {
    fs.chmodSync(tf, 0o600);
    fs.writeFileSync(tf, `${t}\n`);
    fs.chmodSync(tf, 0o400);
    const at = new Date(Date.now() + bump * 1000);
    fs.utimesSync(tf, at, at);
  };
  setToken(FG, 10);
  patchState((s) => {
    s.token = FG;
    s.scopes = null;
    s.pushable = ["heimcloud/neo", "heimcloud/highsea.neo"];
  });
  try {
    const { ret, lines } = captureLog(() => W.main(["--check-token"]));
    const text = lines.join("\n");
    assert.equal(ret, 2, text);
    assert.match(text, /token kind: fine-grained, cannot open upstream PRs/);
    assert.match(text, /pr \(open upstream PRs, comment\): FAIL: .*fine-grained token: upstream PR creation unsupported/);
    assert.match(text, /PR loop: disabled \(compare links only\)/);
    assert.ok(!text.includes(FG));
    const st = JSON.parse(fs.readFileSync(path.join(data, "queue", "worker-status.json"), "utf8"));
    assert.equal(st.pr_token.pr_ok, false);
    assert.equal(st.pr_token.token_kind, "fine-grained");

    const posts = ghLog().filter((l) => l.method === "POST").length;
    const name = enqueue("fix", 56, { validation: true, report_hash: "validation-pr-loop-56", unit: "docker-ops.service" });
    W.main([]);
    const r = result("fix", name);
    assert.equal(r.status, "compare_ready", r.summary);
    assert.equal(r.pr_number, undefined);
    assert.match(r.summary, /PR loop disabled: token kind fine-grained, cannot open upstream PRs/);
    assert.equal(ghLog().filter((l) => l.method === "POST").length, posts, "no PR attempt");
    assert.match(W.main(["--pr-poll"]) === 0 ? "ok" : "x", /ok/);
  } finally {
    setToken(TOKEN, 20);
    patchState((s) => {
      s.token = TOKEN;
      s.scopes = "public_repo";
    });
  }
  assert.equal(W.prCapability(W.config(), { force: true }).pr_ok, true);
});
