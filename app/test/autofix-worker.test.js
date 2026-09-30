/**
 * End-to-end worker tests with a fake `hermes`, fake `heimcloud-autofix-env`
 * and local bare git repos standing in for upstream + fork. Synthetic data only.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-worker-"));
const data = path.join(tmp, "data");
const bin = path.join(tmp, "bin");
const upstream = path.join(tmp, "upstream.git");
const fork = path.join(tmp, "fork.git");

function sh(file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
}

before(() => {
  fs.mkdirSync(bin, { recursive: true });
  for (const k of ["triage", "fix"]) fs.mkdirSync(path.join(data, "queue", k), { recursive: true });
  // Fake credential wrapper: --check honours FAKE_TOKEN, otherwise exec.
  sh(path.join(bin, "fake-autofix-env"), `if [ "$1" = --check ]; then [ "\${FAKE_TOKEN:-1}" = 1 ]; exit $?; fi\nexec "$@"`);
  // Fake hermes: records argv + env, behaves per FAKE_HERMES_MODE.
  sh(
    path.join(bin, "hermes"),
    `printf '%s\\n' "$@" > "${tmp}/hermes-argv"
env | grep -E '^(GH_TOKEN|GITHUB_TOKEN|HERMES_HOME)=' > "${tmp}/hermes-env" || true
skill=""; prev=""
for a in "$@"; do [ "$prev" = -s ] && skill="$a"; prev="$a"; done
mode="\${FAKE_HERMES_MODE:-ok}"
if [ "$skill" = heimcloud-ops-triage ]; then
  echo 'thinking {not json}'
  echo '{"class":"software","severity":"warning","summary":"engine list stale","target_repo":"madebydamo/neo","fixable":true}'
  exit 0
fi
git switch -q -c fix/searxng-engines 2>/dev/null || git switch -q fix/searxng-engines
case "$mode" in
  ok) echo "limiter = true  # $(date +%s%N)" >> nix/services/searxng/default.nix ;;
  leak) echo "owner = ZZTEST0000" >> nix/services/searxng/default.nix ;;
  deny) mkdir -p nix/services/ops && echo x > nix/services/ops/x.nix ;;
  nocommit) echo '{"status":"ready_to_push","branch":"fix/searxng-engines","summary":"nothing"}'; exit 0 ;;
esac
git add -A && git commit -q -m "fix(searxng): drop stale engines"
echo '{"status":"ready_to_push","branch":"fix/searxng-engines","summary":"drop stale engines","commit_message":"fix(searxng): drop stale engines"}'`,
  );
  sh(path.join(bin, "fake-lab-test"), `echo "lab $1 $2"; [ "\${FAKE_LAB:-pass}" = pass ]`);

  const seed = path.join(tmp, "seed");
  execFileSync("git", ["init", "-q", "-b", "dev", seed]);
  fs.mkdirSync(path.join(seed, "nix/services/searxng"), { recursive: true });
  fs.writeFileSync(path.join(seed, "nix/services/searxng/default.nix"), "{ }\n");
  const genv = { ...process.env, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@users.noreply.github.com", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@users.noreply.github.com" };
  execFileSync("git", ["-C", seed, "add", "-A"], { env: genv });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"], { env: genv });
  execFileSync("git", ["clone", "-q", "--bare", seed, upstream]);
  execFileSync("git", ["clone", "-q", "--bare", seed, fork]);
  for (const r of [upstream, fork]) execFileSync("git", ["-C", r, "config", "uploadpack.allowFilter", "true"]);

  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    OPS_DATA_DIR: data,
    OPS_DB_PATH: path.join(data, "ops.sqlite"),
    OPS_AUTOFIX_LOCK: path.join(tmp, "run", "lock"),
    OPS_AUTOFIX_TRIAGE: "1",
    OPS_AUTOFIX_FIX: "1",
    OPS_AUTOFIX_ENV_BIN: path.join(bin, "fake-autofix-env"),
    OPS_AUTOFIX_LAB_TEST_BIN: path.join(tmp, "no-such-lab-test"),
    OPS_AUTOFIX_SCRATCH: path.join(tmp, "scratch"),
    OPS_AUTOFIX_UPSTREAM_URL: upstream,
    OPS_AUTOFIX_FORK_URL: fork,
    OPS_NEO_BASE_REF: "dev",
    OPS_AUTOFIX_MAX_ATTEMPTS: "2",
    GH_TOKEN: "ambient-should-be-stripped",
  });
  delete process.env.OPS_REDACT_EXTRA_SLUGS;
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const W = await import("../../scripts/autofix/worker.mjs");

let seq = 0;
function enqueue(kind, id, extra = {}) {
  seq += 1;
  const name = `${id}-2026-01-01T00-00-${String(seq).padStart(2, "0")}-000Z.json`;
  const p = path.join(data, "queue", kind, name);
  fs.writeFileSync(
    p,
    JSON.stringify({ job_version: 1, kind, incident_id: id, report_hash: "abc123", unit: "docker-searxng", severity: "warning", class: "software", neo_version: "0.1", logs_excerpt: "engine x failed", ...extra }),
  );
  return name;
}
function result(kind, name) {
  return JSON.parse(fs.readFileSync(path.join(data, "results", `${kind}-${name}`), "utf8"));
}

test("hermes argv matches the documented non-interactive call", () => {
  assert.deepEqual(W.hermesArgs("heimcloud-ops-fix", "/p.txt"), [
    "--yolo", "chat", "-Q", "--source", "tool", "--max-turns", "40", "-s", "heimcloud-ops-fix", "--query-file", "/p.txt",
  ]);
});

test("triage job: claimed, Hermes JSON parsed, result written, job moved to done", () => {
  const name = enqueue("triage", 13);
  assert.equal(W.main([]), 0);
  const r = result("triage", name);
  assert.equal(r.status, "triaged");
  assert.equal(r.class, "software");
  assert.ok(fs.existsSync(path.join(data, "queue", "done", `triage-${name}`)));
  assert.equal(fs.readdirSync(path.join(data, "queue", "triage")).length, 0);
  assert.equal(fs.readFileSync(path.join(tmp, "hermes-env"), "utf8").includes("GH_TOKEN"), false, "ambient token stripped");
});

test("fix job: branch pushed to fork with pinned identity, compare link against base ref", () => {
  process.env.FAKE_HERMES_MODE = "ok";
  const name = enqueue("fix", 13);
  W.main([]);
  const r = result("fix", name);
  assert.equal(r.status, "awaiting_lab_test", r.summary);
  assert.equal(r.lab, "skipped");
  assert.equal(r.branch, "fix/searxng-engines");
  assert.equal(r.compare_url, "https://github.com/madebydamo/neo/compare/dev...heimcloud:neo:fix/searxng-engines?expand=1");
  const author = execFileSync("git", ["-C", fork, "log", "-1", "--format=%an <%ae>|%cn <%ce>", "fix/searxng-engines"], { encoding: "utf8" }).trim();
  assert.equal(author, "heimcloud <heimcloud@users.noreply.github.com>|heimcloud <heimcloud@users.noreply.github.com>");
  assert.ok(fs.existsSync(path.join(data, "queue", "done", `fix-${name}`)));
});

test("fix job with an identifier in the diff is blocked before push (fail closed)", () => {
  process.env.FAKE_HERMES_MODE = "leak";
  const before = execFileSync("git", ["-C", fork, "rev-parse", "fix/searxng-engines"], { encoding: "utf8" }).trim();
  const name = enqueue("fix", 14);
  W.main([]);
  const r = result("fix", name);
  assert.equal(r.status, "redaction_blocked");
  assert.match(r.summary, /redaction_fail_closed:diff/);
  const afterSha = execFileSync("git", ["-C", fork, "rev-parse", "fix/searxng-engines"], { encoding: "utf8" }).trim();
  assert.equal(afterSha, before, "nothing pushed");
});

test("deny-listed path while lab shares ops host → denied", () => {
  process.env.FAKE_HERMES_MODE = "deny";
  const name = enqueue("fix", 15);
  W.main([]);
  assert.equal(result("fix", name).status, "denied");
});

test("no commit from Hermes → needs_human", () => {
  process.env.FAKE_HERMES_MODE = "nocommit";
  const name = enqueue("fix", 16);
  W.main([]);
  const r = result("fix", name);
  assert.equal(r.status, "needs_human");
  assert.match(r.summary, /no commit/);
});

test("missing token: Hermes still codes + commits, gates run, push skipped → ready_no_token with saved patch", () => {
  process.env.FAKE_HERMES_MODE = "ok";
  process.env.FAKE_TOKEN = "0";
  process.env.OPS_AUTOFIX_LAB_TEST_BIN = path.join(bin, "fake-lab-test");
  const forkBefore = execFileSync("git", ["-C", fork, "for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" });
  fs.rmSync(path.join(tmp, "hermes-argv"), { force: true });
  const name = enqueue("fix", 17);
  W.main([]);
  const r = result("fix", name);
  assert.equal(r.status, "ready_no_token", r.summary);
  assert.ok(fs.existsSync(path.join(tmp, "hermes-argv")), "Hermes ran");
  assert.equal(r.branch, "fix/searxng-engines");
  assert.equal(r.compare_url, undefined);
  assert.equal(r.lab, "deferred_until_push");
  assert.match(r.summary, /committed locally .*waiting for the fork-push token/);
  assert.match(r.summary, /heimcloud-ops-worker-push@fix-17-/);
  const forkAfter = execFileSync("git", ["-C", fork, "for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" });
  assert.equal(forkAfter, forkBefore, "nothing pushed");
  const patch = fs.readFileSync(r.patch_path, "utf8");
  assert.match(patch, /^From [0-9a-f]{40} /);
  assert.match(patch, /fix\(searxng\): drop stale engines/);
  const pending = JSON.parse(fs.readFileSync(r.pending_path, "utf8"));
  assert.equal(pending.branch, "fix/searxng-engines");
  assert.equal(pending.incident_id, 17);
  const status = JSON.parse(fs.readFileSync(path.join(data, "queue", "worker-status.json"), "utf8"));
  assert.equal(status.fork_push_token, false);
  assert.equal(JSON.stringify(status).includes("ghp_"), false);

  // Later push: token appears, no second Hermes run.
  process.env.FAKE_TOKEN = "1";
  process.env.FAKE_LAB = "pass";
  fs.rmSync(path.join(tmp, "hermes-argv"), { force: true });
  const scratch = path.dirname(r.pending_path);
  assert.equal(W.main(["--push-pending", scratch]), 0);
  assert.equal(fs.existsSync(path.join(tmp, "hermes-argv")), false, "Hermes not re-run");
  const pushed = JSON.parse(fs.readFileSync(path.join(data, "results", `push-${path.basename(scratch)}.json`), "utf8"));
  assert.equal(pushed.status, "compare_ready");
  assert.equal(pushed.incident_id, 17);
  assert.equal(
    execFileSync("git", ["-C", fork, "rev-parse", "fix/searxng-engines"], { encoding: "utf8" }).trim(),
    pending.head_sha,
  );
  assert.ok(fs.existsSync(`${r.pending_path}.done`));
  process.env.OPS_AUTOFIX_LAB_TEST_BIN = path.join(tmp, "no-such-lab-test");
});

test("push-pending replays the saved patch when the scratch clone is gone", () => {
  process.env.FAKE_HERMES_MODE = "ok";
  process.env.FAKE_TOKEN = "0";
  const name = enqueue("fix", 22);
  W.main([]);
  const r = result("fix", name);
  assert.equal(r.status, "ready_no_token");
  const scratch = path.dirname(r.pending_path);
  fs.rmSync(path.join(scratch, "neo"), { recursive: true, force: true });
  process.env.FAKE_TOKEN = "1";
  assert.equal(W.main(["--push-pending", scratch]), 0);
  const pushed = JSON.parse(fs.readFileSync(path.join(data, "results", `push-${path.basename(scratch)}.json`), "utf8"));
  assert.equal(pushed.status, "awaiting_lab_test", pushed.summary);
  assert.equal(
    execFileSync("git", ["-C", fork, "log", "-1", "--format=%s", "fix/searxng-engines"], { encoding: "utf8" }).trim(),
    "fix(searxng): drop stale engines",
  );
});

test("push-pending without token exits non-zero and pushes nothing", () => {
  process.env.FAKE_HERMES_MODE = "ok";
  process.env.FAKE_TOKEN = "0";
  const name = enqueue("fix", 23);
  W.main([]);
  const r = result("fix", name);
  assert.equal(W.main(["--push-pending", path.dirname(r.pending_path)]), 1);
  assert.ok(fs.existsSync(r.pending_path), "pending kept for a later push");
  delete process.env.FAKE_TOKEN;
});

test("missing token does not bypass the redaction gate", () => {
  process.env.FAKE_HERMES_MODE = "leak";
  process.env.FAKE_TOKEN = "0";
  const name = enqueue("fix", 24);
  W.main([]);
  const r = result("fix", name);
  assert.equal(r.status, "redaction_blocked");
  assert.equal(r.patch_path, undefined);
  delete process.env.FAKE_TOKEN;
});

test("lab test: pass → compare_ready; persistent failure → retries then needs_human without compare link", () => {
  process.env.FAKE_HERMES_MODE = "ok";
  process.env.OPS_AUTOFIX_LAB_TEST_BIN = path.join(bin, "fake-lab-test");
  process.env.FAKE_LAB = "pass";
  let name = enqueue("fix", 18);
  W.main([]);
  assert.equal(result("fix", name).status, "compare_ready");

  process.env.FAKE_LAB = "fail";
  name = enqueue("fix", 19);
  W.main([]);
  const r = result("fix", name);
  assert.equal(r.status, "needs_human");
  assert.equal(r.attempts, 2);
  assert.equal(r.compare_url, undefined);
  assert.equal(fs.readFileSync(path.join(tmp, "hermes-argv"), "utf8").includes("heimcloud-ops-fix"), true);
  process.env.OPS_AUTOFIX_LAB_TEST_BIN = path.join(tmp, "no-such-lab-test");
});

test("disabled kinds are left in the queue untouched", () => {
  process.env.OPS_AUTOFIX_FIX = "0";
  const name = enqueue("fix", 20);
  W.main([]);
  assert.ok(fs.existsSync(path.join(data, "queue", "fix", name)));
  fs.rmSync(path.join(data, "queue", "fix", name));
  process.env.OPS_AUTOFIX_FIX = "1";
});

test("stale lock from a dead pid is reclaimed; interrupted jobs are failed, not re-run", () => {
  const lock = process.env.OPS_AUTOFIX_LOCK;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "999999");
  const stale = path.join(data, "queue", "processing", "fix-21-2026-01-01T00-00-00-000Z.json");
  fs.writeFileSync(stale, "{}");
  W.main([]);
  assert.equal(fs.existsSync(lock), false);
  const r = JSON.parse(fs.readFileSync(path.join(data, "results", path.basename(stale)), "utf8"));
  assert.equal(r.status, "needs_human");
  assert.match(r.summary, /interrupted/);
  assert.ok(fs.existsSync(path.join(data, "queue", "failed", path.basename(stale))));
});

test("extractJson picks the last valid object from noisy output", () => {
  assert.deepEqual(W.extractJson('log {x} then {"a":{"b":"}"}} tail'), { a: { b: "}" } });
  assert.equal(W.extractJson("no json"), null);
});

test("denyListHit matches path prefixes, not substrings in content", () => {
  const cfg = W.config();
  assert.equal(W.denyListHit(["nix/services/opsx/a.nix"], cfg), null);
  assert.equal(W.denyListHit(["nix/services/ops/a.nix"], cfg), "nix/services/ops");
});
