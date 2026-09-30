/**
 * Root lab runner (scripts/autofix/labtest.mjs) against a fake host: fake
 * nix / systemctl / systemd-run / journalctl on PATH, a fake store with two
 * "systems" whose switch-to-configuration flips a fake /run/current-system,
 * a fake profile (generation 41) and a fake config flake. Real flock(1).
 * Synthetic data only.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LABTEST = path.resolve(here, "../../scripts/autofix/labtest.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-labtest-"));
const B = path.join(tmp, "bin");
const F = path.join(tmp, "fake");
const STORE = path.join(tmp, "store") + "/";
const BASE = path.join(STORE, "aaaa-nixos-system-base");
const LAB = path.join(STORE, "bbbb-nixos-system-lab");
const OTHER = path.join(STORE, "cccc-nixos-system-other");
const CUR = path.join(tmp, "run", "current-system");
const BOOTED = path.join(tmp, "run", "booted-system");
const PROFILE = path.join(tmp, "profiles", "system");
const FLAKE = path.join(tmp, "flake");
const OPS = path.join(tmp, "ops");
const STATE = path.join(tmp, "state");
const LOCKS = path.join(tmp, "locks");
const INST = "lab-7-2026-09-30T10-00-00-000Z";
// Neo sources (deployed input vs fork branch) the runner diffs for protected paths.
const SRC_DEPLOYED = path.join(STORE, "dddd-source");
const SRC_BRANCH = path.join(STORE, "eeee-source");
const APP_NODE_MODULES = path.resolve(here, "../node_modules");
const PIN_LOCK = '{"nodes":{"neo":{"locked":{"rev":"0000synthetic"}}},"version":7}\n';

let server;
let port;
let health = 200;
let lt;

function sh(file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -u\n${body}\n`, { mode: 0o755 });
}

function system(dir, extra = "") {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  sh(
    path.join(dir, "bin", "switch-to-configuration"),
    `echo "switch $(basename "$(dirname "$(dirname "$0")")") $*" >> "${F}/log"
${extra}
ln -sfn "$(dirname "$(dirname "$0")")" "${CUR}"`,
  );
}

before(async () => {
  for (const d of [B, F, STORE, path.dirname(CUR), path.dirname(PROFILE), FLAKE, path.join(OPS, "queue", "processing"), path.join(OPS, "queue", "control"), STATE, LOCKS]) {
    fs.mkdirSync(d, { recursive: true });
  }
  system(
    BASE,
    `: > "${F}/failed"; cp "${F}/failed-pre" "${F}/failed" 2>/dev/null || true
[ -n "\${FAKE_LAB_ONLY_UNIT:-}" ] && [ -e "${F}/lab-was-active" ] && echo "\${FAKE_LAB_ONLY_UNIT} not-found failed failed Lab only" >> "${F}/failed"
[ -n "\${FAKE_STILL_FAILED:-}" ] && [ -e "${F}/lab-was-active" ] && echo "\${FAKE_STILL_FAILED} loaded failed failed Real" >> "${F}/failed"
[ -n "\${FAKE_ROLLBACK_HEALS:-}" ] && rm -f "${F}/ops-down"
true`,
  );
  system(
    LAB,
    `touch "${F}/lab-was-active"
[ -n "\${FAKE_LAB_FAILS_UNIT:-}" ] && echo "\${FAKE_LAB_FAILS_UNIT} loaded failed failed Demo" >> "${F}/failed"
[ -n "\${FAKE_LAB_ONLY_UNIT:-}" ] && echo "\${FAKE_LAB_ONLY_UNIT} loaded failed failed Lab only" >> "${F}/failed"
[ -n "\${FAKE_LAB_HANG:-}" ] && sleep 30
[ -n "\${FAKE_LAB_KILLS_OPS:-}" ] && touch "${F}/ops-down"
[ -n "\${FAKE_LAB_KILLS_HERMES:-}" ] && { grep -vx hermes-agent.service "${F}/active" > "${F}/active.tmp" || true; mv "${F}/active.tmp" "${F}/active"; }
[ -n "\${FAKE_ACTIVATE_OUT:-}" ] && printf '%s\n' "\${FAKE_ACTIVATE_OUT}" >&2
[ -n "\${FAKE_LAB_SYSSTATE:-}" ] && echo "\${FAKE_LAB_SYSSTATE}" > "${F}/sysstate"
ln -sfn "$(dirname "$(dirname "$0")")" "${CUR}"
exit "\${FAKE_ACTIVATE_EXIT:-0}"`,
  );
  system(OTHER);
  sh(
    path.join(B, "nix"),
    `echo "nix $*" >> "${F}/log"
case "$*" in
  *"flake metadata"*"--override-input"*)
    echo '{"locks":{"root":"root","nodes":{"root":{"inputs":{"neo":"neo_2"}},"neo_2":{"locked":{"type":"github","rev":"'"\${FAKE_REV:-${"1".repeat(40)}}"'"}}}}}'
    exit 0 ;;
  *"flake metadata --json --no-write-lock-file ${FLAKE}")
    echo '{"locks":{"root":"root","nodes":{"root":{"inputs":{"neo":"neo_2"}},"neo_2":{"locked":{"type":"github","owner":"madebydamo","repo":"neo","rev":"${"9".repeat(40)}","narHash":"sha256-synthetic"}}}}}'
    exit 0 ;;
  *"flake metadata --json "*)
    [ -n "\${FAKE_META_FAIL:-}" ] && exit 1
    echo '{"path":"${SRC_BRANCH}","revision":"'"\${FAKE_REV:-${"1".repeat(40)}}"'"}'
    exit 0 ;;
  *" eval --raw --expr "*"builtins.fetchTree"*)
    printf '%s' "${SRC_DEPLOYED}"
    exit 0 ;;
esac
case "\${FAKE_NIX_MODE:-ok}" in
  fail) echo "error: builder for '/nix/store/x-demo.drv' failed with exit code 1" >&2; exit 1 ;;
  net) echo "error: unable to download 'https://api.github.com/x': HTTP error 503" >&2; exit 1 ;;
  touchlock) echo '{"changed":true}' > "${FLAKE}/flake.lock" ;;
esac
echo "${LAB}"`,
  );
  sh(
    path.join(B, "systemctl"),
    `echo "systemctl $*" >> "${F}/log"
case "$1" in
  --failed) cat "${F}/failed" 2>/dev/null ;;
  is-system-running) if [ -s "${F}/failed" ]; then echo degraded; exit 1; else cat "${F}/sysstate" 2>/dev/null || echo running; fi ;;
  is-active)
    case "$2" in
      *.timer) if [ -e "${F}/timer-$2" ]; then echo active; else echo inactive; exit 3; fi ;;
      *) if grep -qx "$2" "${F}/active" 2>/dev/null; then echo active; else echo inactive; exit 3; fi ;;
    esac ;;
  stop) rm -f "${F}/timer-$2" ;;
  restart)
    echo "$2" >> "${F}/restarted"
    case "$2" in
      docker-ops.service) [ -n "\${FAKE_OPS_RESTART_FAILS:-}" ] || rm -f "${F}/ops-down" ;;
      hermes-agent.service) echo hermes-agent.service >> "${F}/active" ;;
    esac ;;
  reset-failed) shift; [ "$1" = -- ] && shift; for u in "$@"; do grep -v "^$u " "${F}/failed" > "${F}/failed.tmp"; mv "${F}/failed.tmp" "${F}/failed"; done ;;
esac
exit 0`,
  );
  sh(
    path.join(B, "systemd-run"),
    `echo "systemd-run $*" >> "${F}/log"
[ -n "\${FAKE_SDRUN_FAIL:-}" ] && exit 1
for a in "$@"; do case "$a" in --unit=*) touch "${F}/timer-\${a#--unit=}.timer" ;; esac; done
exit 0`,
  );
  fs.writeFileSync(
    path.join(B, "sqlite3"),
    `#!${process.execPath}
const Database = require(${JSON.stringify(path.join(APP_NODE_MODULES, "better-sqlite3"))});
const a = process.argv.slice(2);
if (a[0] !== "-readonly" || a[1] !== "-json") process.exit(2);
require("fs").appendFileSync(${JSON.stringify(path.join(F, "log"))}, "sqlite3 " + a.join(" ") + "\\n");
const db = new Database(a[2], { readonly: true, fileMustExist: true });
const rows = db.prepare(a[3]).all();
process.stdout.write(rows.length ? JSON.stringify(rows) : "");
`,
    { mode: 0o755 },
  );
  sh(path.join(B, "journalctl"), `echo "journalctl $*" >> "${F}/log"; cat "${F}/journal" 2>/dev/null; exit 0`);
  server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(fs.existsSync(path.join(F, "ops-down")) ? 503 : health);
      res.end("ok");
    } else if (req.url === "/svc") {
      res.writeHead(200);
      res.end("search results ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "localhost", r));
  port = server.address().port;
  Object.assign(process.env, env());
  lt = await import(LABTEST);
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function env(extra = {}) {
  return {
    PATH: `${B}:${process.env.PATH}`,
    LABTEST_OPS_DIR: OPS,
    LABTEST_STATE_DIR: STATE,
    LABTEST_FLAKE: FLAKE,
    LABTEST_SYSTEM_LOCK: path.join(LOCKS, "system.lock"),
    LABTEST_LOCK_WAIT_SEC: "5",
    LABTEST_SETTLE_SEC: "0",
    LABTEST_SETTLE_MAX_SEC: "1",
    LABTEST_CHECK_TIMEOUT_SEC: "1",
    LABTEST_POLL_MS: "20",
    LABTEST_KILL_GRACE_SEC: "1",
    LABTEST_ACTIVATE_TIMEOUT_SEC: "20",
    LABTEST_OPS_HEALTH: `http://localhost:${port}/health`,
    LABTEST_PROFILE: PROFILE,
    LABTEST_CURRENT: CUR,
    LABTEST_BOOTED: BOOTED,
    LABTEST_STORE_PREFIX: STORE,
    OPS_REDACT_EXTRA_SLUGS: "ZZSYNTH01Q",
    LABTEST_OPS_UID: String(process.getuid()),
    LABTEST_SQLITE_BIN: path.join(B, "sqlite3"),
    LABTEST_DB_PATH: path.join(OPS, "ops.sqlite"),
    LABTEST_PROTECTED_WATCHDOG_SEC: "120",
    LABTEST_PROTECTED_PROBE_SEC: "1",
    LABTEST_RECOVER_SEC: "1",
    ...extra,
  };
}

const CHECKS = [
  { type: "unit_active", unit: "docker-demo.service" },
  { type: "journal_absent", unit: "docker-demo.service", pattern: "engine failed to load" },
  { type: "http_status", url: `http://localhost:${0}/svc`, contains: "results" },
];

function spec(extra = {}) {
  return {
    kind: "lab",
    incident_id: 7,
    branch: "fix/labtest-demo",
    head_sha: "1".repeat(40),
    lab_checks: CHECKS.map((c) => (c.type === "http_status" ? { ...c, url: `http://localhost:${port}/svc` } : c)),
    ...extra,
  };
}

function neoSource(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [f, body] of [
    ["nix/services/hermes/default.nix", "{ hermes = true; }\n"],
    ["nix/services/searxng/default.nix", "{ }\n"],
    ["nix/modules/core/default.nix", "{ core = true; }\n"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
}

function reset(s = spec()) {
  for (const f of fs.readdirSync(F)) fs.rmSync(path.join(F, f), { force: true });
  neoSource(SRC_DEPLOYED);
  neoSource(SRC_BRANCH);
  fs.writeFileSync(path.join(F, "active"), "hermes-agent.service\ndocker-demo.service\n");
  fs.writeFileSync(path.join(F, "failed"), "");
  fs.writeFileSync(path.join(F, "failed-pre"), "");
  fs.rmSync(CUR, { force: true });
  fs.rmSync(BOOTED, { force: true });
  fs.symlinkSync(BASE, CUR);
  fs.symlinkSync(BASE, BOOTED);
  fs.rmSync(PROFILE, { force: true });
  fs.rmSync(path.join(path.dirname(PROFILE), "system-41-link"), { force: true });
  fs.symlinkSync(BASE, path.join(path.dirname(PROFILE), "system-41-link"));
  fs.symlinkSync("system-41-link", PROFILE);
  fs.writeFileSync(path.join(FLAKE, "flake.lock"), PIN_LOCK);
  fs.writeFileSync(path.join(FLAKE, "flake.nix"), "{ outputs = _: {}; }\n");
  fs.writeFileSync(path.join(FLAKE, "settings.toml"), '[neo-cli]\nneoInput = "github:madebydamo/neo"\n');
  fs.rmSync(path.join(OPS, "queue", "control", `cancel-${INST}.json`), { force: true });
  fs.writeFileSync(path.join(OPS, "queue", "processing", `${INST}.json`), JSON.stringify(s));
  health = 200;
  for (const k of ["FAKE_LAB_ONLY_UNIT", "FAKE_STILL_FAILED", "FAKE_REV", "FAKE_NIX_MODE", "FAKE_ACTIVATE_EXIT", "FAKE_LAB_FAILS_UNIT", "FAKE_SDRUN_FAIL", "FAKE_LAB_HANG", "FAKE_ACTIVATE_OUT", "FAKE_LAB_SYSSTATE", "FAKE_LAB_KILLS_OPS", "FAKE_LAB_KILLS_HERMES", "FAKE_ROLLBACK_HEALS", "FAKE_OPS_RESTART_FAILS", "FAKE_META_FAIL"]) delete process.env[k];
  Object.assign(process.env, env());
}

const log = () => (fs.existsSync(path.join(F, "log")) ? fs.readFileSync(path.join(F, "log"), "utf8") : "");
const cfg = () => lt.labConfig(process.env);
beforeEach(() => reset());

test("pass: override only the neo input, activate with test, run all checks, roll back, verify, disarm", async () => {
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "pass", r.reason);
  assert.equal(r.checks.length, 8);
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks));
  assert.deepEqual(r.checks.slice(0, 5).map((c) => c.id), ["activate", "failed_units", "system_running", "ops_health", "hermes_active"]);
  const l = log();
  assert.match(l, /nix .*build --no-link --print-out-paths --no-write-lock-file --override-input neo github:heimcloud\/neo\/fix\/labtest-demo .*#nixosConfigurations\.neo\.config\.system\.build\.toplevel/);
  assert.doesNotMatch(l, /nixos-rebuild|switch-to-configuration switch|switch \S+ switch/);
  // lab activated with "test" (no boot entry / profile change), then the previous system.
  const switches = l.split("\n").filter((x) => x.startsWith("switch "));
  assert.deepEqual(switches, ["switch bbbb-nixos-system-lab test", "switch aaaa-nixos-system-base test"]);
  assert.ok(l.indexOf("systemd-run") < l.indexOf("switch bbbb"), "watchdog armed before activation");
  assert.match(l, /systemd-run --unit=heimcloud-ops-labtest-watchdog-lab-7-\S+ .*--on-active=\d+s .*--watchdog \S+activation\.json/);
  assert.equal(fs.realpathSync(CUR), BASE);
  assert.equal(r.generation.before, 41);
  assert.equal(r.generation.after, 41);
  assert.equal(r.generation.restored, true);
  assert.equal(r.generation.booted_unchanged, true);
  assert.equal(r.pins.identical, true);
  assert.deepEqual(r.watchdog, { armed: true, disarmed: true, fired: false, deadline_sec: r.watchdog.deadline_sec });
  assert.ok(!fs.readdirSync(F).some((f) => f.startsWith("timer-")), "watchdog timer stopped");
  assert.ok(!fs.readdirSync(LOCKS).some((f) => f.endsWith(".holder")), "neo holder file removed");
  const onDisk = JSON.parse(fs.readFileSync(path.join(STATE, INST, "result.json"), "utf8"));
  assert.equal(onDisk.verdict, "pass");
  assert.equal(JSON.parse(fs.readFileSync(path.join(STATE, INST, "status.json"), "utf8")).stage, "done");
});

test("failing activation: checks fail, rollback still happens and is verified", async () => {
  process.env.FAKE_ACTIVATE_EXIT = "1";
  process.env.FAKE_LAB_FAILS_UNIT = "docker-demo.service";
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "fail");
  assert.equal(r.failed_stage, "activating");
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by.activate.ok, false);
  assert.equal(by.failed_units.ok, false);
  assert.match(by.failed_units.detail, /docker-demo\.service/);
  assert.equal(by.system_running.ok, false);
  assert.equal(fs.realpathSync(CUR), BASE);
  assert.equal(r.generation.restored, true);
  assert.equal(r.watchdog.disarmed, true);
  assert.equal(fs.readFileSync(path.join(F, "failed"), "utf8"), "", "previous system's failed set is back");
});

test("incident check failure: journal still has the error signature, service health 500", async () => {
  fs.writeFileSync(path.join(F, "journal"), "starting\nERROR: engine failed to load: ZZSYNTH01Q at ops@example.org\n");
  health = 500;
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "fail");
  const by = Object.fromEntries(r.checks.map((c) => [c.type === "journal_absent" ? "journal" : c.id, c]));
  assert.equal(by.journal.ok, false);
  assert.equal(by.ops_health.ok, false);
  assert.match(by.ops_health.detail, /HTTP 500/);
  assert.match(log(), /journalctl -u docker-demo\.service --since @\d+ -o cat --no-pager -q/);
  const all = JSON.stringify(r);
  assert.doesNotMatch(all, /ZZSYNTH01Q|ops@example\.org/, "evidence is redacted");
  assert.ok(r.evidence.some((l) => /engine failed to load/.test(l)));
  assert.equal(r.generation.restored, true);
});

test("degraded before the test is tolerated only if the failed set does not grow", async () => {
  fs.writeFileSync(path.join(F, "failed-pre"), "old-thing.service loaded failed failed Old\n");
  fs.writeFileSync(path.join(F, "failed"), "old-thing.service loaded failed failed Old\n");
  let r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "pass", r.reason);
  assert.match(r.checks.find((c) => c.id === "system_running").detail, /degraded/);
  reset();
  fs.writeFileSync(path.join(F, "failed-pre"), "old-thing.service loaded failed failed Old\n");
  fs.writeFileSync(path.join(F, "failed"), "old-thing.service loaded failed failed Old\n");
  process.env.FAKE_LAB_FAILS_UNIT = "docker-demo.service";
  r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "fail");
  assert.equal(r.checks.find((c) => c.id === "failed_units").ok, false);
});

test("lock contention: Neo system lock held → lock timeout, nothing built or activated", async () => {
  const held = await lt.holdFlock(cfg(), path.join(LOCKS, "system.lock"));
  assert.ok(held.ok);
  try {
    process.env.LABTEST_LOCK_WAIT_SEC = "1";
    const r = await lt.runLab(cfg(), INST);
    assert.equal(r.verdict, "error");
    assert.equal(r.lock_timeout, true);
    assert.doesNotMatch(log(), /^nix |^switch |systemd-run/m);
  } finally {
    held.release();
  }
  const lab = await lt.holdFlock(cfg(), path.join(STATE, "lab.lock"));
  try {
    const r = await lt.runLab(cfg(), INST);
    assert.equal(r.lab_busy, true);
  } finally {
    lab.release();
  }
});

test("lock-file restore: a build that rewrites flake.lock is detected and restored byte-identically", async () => {
  process.env.FAKE_NIX_MODE = "touchlock";
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.pins.identical, false);
  assert.equal(r.pins.restored, true);
  assert.equal(r.pins.ok, true);
  assert.equal(fs.readFileSync(path.join(FLAKE, "flake.lock"), "utf8"), PIN_LOCK);
  assert.ok(r.evidence.some((l) => /pin files changed.*flake\.lock.*restored/.test(l)));
});

test("watchdog cannot be armed → no activation at all", async () => {
  process.env.FAKE_SDRUN_FAIL = "1";
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "error");
  assert.equal(r.failed_stage, "arming_watchdog");
  assert.doesNotMatch(log(), /^switch /m);
});

test("build failure is a lab failure (fed back to Hermes); network errors are infra errors; neither activates", async () => {
  process.env.FAKE_NIX_MODE = "fail";
  let r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "fail");
  assert.equal(r.failed_stage, "build");
  assert.ok(r.evidence.some((l) => /builder for/.test(l)));
  assert.doesNotMatch(log(), /^switch |systemd-run/m);
  reset();
  process.env.FAKE_NIX_MODE = "net";
  r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "error");
});

test("invalid spec (branch injection, wrong kind) and unknown check types are refused", async () => {
  reset(spec({ branch: "fix/x; rm -rf /" }));
  let r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "error");
  assert.match(r.reason, /invalid fix branch/);
  assert.equal(log(), "");
  reset(spec({ kind: "fix" }));
  r = await lt.runLab(cfg(), INST);
  assert.match(r.reason, /not a lab job/);
  reset(spec({ lab_checks: [{ type: "shell", cmd: "id" }, { type: "unit_active", unit: "docker-demo.service" }] }));
  r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "pass");
  assert.equal(r.checks.length, 6);
  assert.match(r.plan_errors[0], /unknown check type/);
  assert.equal((await lt.runLab(cfg(), "../etc")).verdict, "error");
});

test("cancel before activation is honoured; nothing is activated", async () => {
  fs.writeFileSync(path.join(OPS, "queue", "control", `cancel-${INST}.json`), "{}");
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "cancelled");
  assert.doesNotMatch(log(), /^switch /m);
});

test("watchdog: rolls back when the lab system is still active and writes a result; leaves a newer system alone", async () => {
  const dir = path.join(STATE, INST);
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, "result.json"), { force: true });
  const act = {
    version: 1,
    instance: INST,
    phase: "activating",
    before: BASE,
    lab: LAB,
    current_link: CUR,
    profile: PROFILE,
    store_prefix: STORE,
    rollback_timeout_sec: 20,
    lab_unit: `heimcloud-ops-labtest@${INST}.service`,
    systemctl: path.join(B, "systemctl"),
    flock: "flock",
    system_lock: path.join(LOCKS, "system.lock"),
    flake: FLAKE,
    pins: [],
  };
  fs.writeFileSync(path.join(dir, "activation.json"), JSON.stringify(act));
  fs.rmSync(CUR);
  fs.symlinkSync(LAB, CUR);
  const w = await lt.runWatchdog(path.join(dir, "activation.json"), process.env);
  assert.equal(w.fired, true);
  assert.equal(w.restored, true);
  assert.equal(fs.realpathSync(CUR), BASE);
  assert.match(log(), /systemctl kill --signal=SIGKILL heimcloud-ops-labtest@lab-7-/);
  const res = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.equal(res.verdict, "error");
  assert.equal(res.watchdog.fired, true);
  assert.match(res.reason, /watchdog rolled back/);

  fs.rmSync(CUR);
  fs.symlinkSync(OTHER, CUR);
  const w2 = await lt.runWatchdog(path.join(dir, "activation.json"), process.env);
  assert.equal(w2.fired, false);
  assert.equal(fs.realpathSync(CUR), OTHER);
  fs.writeFileSync(path.join(dir, "activation.json"), JSON.stringify({ ...act, phase: "restored" }));
  assert.equal((await lt.runWatchdog(path.join(dir, "activation.json"), process.env)).fired, false);
});

test("trap: SIGTERM during the run still rolls back (separate process)", async () => {
  const child = spawn(process.execPath, [LABTEST, "--run", INST], {
    env: { ...process.env, ...env({ LABTEST_SETTLE_SEC: "4" }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = path.join(STATE, INST, "status.json");
  const deadline = Date.now() + 15000;
  for (;;) {
    let st = null;
    try {
      st = JSON.parse(fs.readFileSync(status, "utf8")).stage;
    } catch {
      /* not yet */
    }
    if (st === "settling") break;
    if (Date.now() > deadline) throw new Error(`never reached settling (${st})`);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(fs.realpathSync(CUR), LAB, "lab system active while settling");
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  const r = JSON.parse(fs.readFileSync(path.join(STATE, INST, "result.json"), "utf8"));
  assert.equal(r.verdict, "error");
  assert.match(r.reason, /stopped during checks; rolled back/);
  assert.equal(r.generation.restored, true);
  assert.equal(fs.realpathSync(CUR), BASE);
});

test("root refuses a fork branch that moved after gating (tip != head_sha) and a spec without head_sha", async () => {
  process.env.FAKE_REV = "2".repeat(40);
  let r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "error");
  assert.match(r.reason, /moved after the worker gated it/);
  assert.doesNotMatch(log(), /^switch /m, "never activated");
  assert.equal(r.watchdog.armed, false);
  delete process.env.FAKE_REV;
  reset(spec({ head_sha: undefined }));
  r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "error");
  assert.match(r.reason, /gated commit/);
  assert.doesNotMatch(log(), /nix .*build/);
});

test("after rollback: lab-only failed units (not-found) are reset, a real unit still failed is reported", async () => {
  process.env.FAKE_LAB_ONLY_UNIT = "neo-labtest-fail.service";
  process.env.FAKE_STILL_FAILED = "docker-demo2.service";
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "fail", r.reason);
  assert.equal(r.checks.find((c) => c.id === "failed_units").ok, false);
  assert.match(r.checks.find((c) => c.id === "failed_units").detail, /neo-labtest-fail\.service/);
  assert.equal(r.generation.restored, true);
  assert.deepEqual(r.post_rollback, { reset_lab_only: ["neo-labtest-fail.service"], still_failed: ["docker-demo2.service"] });
  assert.match(log(), /systemctl reset-failed -- neo-labtest-fail\.service/);
  const failedNow = fs.readFileSync(path.join(F, "failed"), "utf8");
  assert.doesNotMatch(failedNow, /neo-labtest-fail/);
  assert.match(failedNow, /docker-demo2\.service/, "real failure is not hidden");
  assert.ok(r.evidence.some((l) => /still failed after rollback/.test(l)));
});

// switch-to-configuration-ng output when a service user's user manager has no
// bus (no lingering): the per-user child fails, the parent exits 4.
const USER_BUS_OUT = [
  "activating the configuration...",
  "setting up /etc...",
  "reloading user units for svcagent...",
  "Error: Failed to open dbus connection",
  "",
  "Caused by:",
  "    Failed to connect to socket /run/user/990/bus: No such file or directory",
  "warning: user activation for svcagent failed",
  "restarting sysinit-reactivation.target",
  "the following new units were started: neo-labtest-demo.service",
  "switching to system configuration /nix/store/bbbb-nixos-system-lab failed (status 4)",
].join("\n");

test("exit 4 from the user bus only (no new failed units, system running) passes with a warning", async () => {
  process.env.FAKE_ACTIVATE_EXIT = "4";
  process.env.FAKE_ACTIVATE_OUT = USER_BUS_OUT;
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "pass", r.reason);
  const act = r.checks.find((c) => c.id === "activate");
  assert.equal(act.ok, true);
  assert.match(act.detail, /^exit 4 tolerated: user bus unavailable/);
  assert.doesNotMatch(act.detail, /svcagent/, "no user names in the check detail");
  assert.ok(r.evidence.includes("activation exit 4 tolerated: user bus unavailable"), JSON.stringify(r.evidence));
  assert.equal(r.activation.exit_code, 4);
  assert.equal(r.activation.tolerated_exit4, true);
  assert.equal(r.activation.warning, "exit 4 tolerated: user bus unavailable");
  assert.equal(r.generation.restored, true);
});

test("exit 4 stays a failure: new failed unit, degraded system, system-level errors, unknown cause", async () => {
  const cases = [
    { name: "newly failed unit", env: { FAKE_LAB_FAILS_UNIT: "docker-demo.service" }, out: USER_BUS_OUT, why: /newly failed units/ },
    { name: "degraded without failed units", env: { FAKE_LAB_SYSSTATE: "degraded" }, out: USER_BUS_OUT, why: /system degraded/ },
    { name: "system unit failed to start", out: `${USER_BUS_OUT}\nFailed to start neo-labtest-fail.service: Unit failed`, why: /system-level failure: Failed to start neo-labtest-fail/ },
    { name: "system units failed", out: `${USER_BUS_OUT}\nwarning: the following units failed: neo-labtest-fail.service`, why: /system-level failure: warning: the following units failed/ },
    { name: "logind", out: "Unable to list users with logind: timeout\nswitching to system configuration x failed (status 4)", why: /system-level failure: Unable to list users/ },
    { name: "no signature", out: "something odd happened", why: /unknown exit-4 cause/ },
  ];
  for (const c of cases) {
    reset();
    process.env.FAKE_ACTIVATE_EXIT = "4";
    process.env.FAKE_ACTIVATE_OUT = c.out;
    Object.assign(process.env, c.env || {});
    const r = await lt.runLab(cfg(), INST);
    const act = r.checks.find((x) => x.id === "activate");
    assert.equal(r.verdict, "fail", c.name);
    assert.equal(act.ok, false, c.name);
    assert.match(act.detail, /^exit 4 not tolerated: /, c.name);
    assert.match(act.detail, c.why, c.name);
    assert.ok(!r.evidence.some((l) => /tolerated/.test(l)), c.name);
    assert.equal(r.activation.tolerated_exit4, undefined, c.name);
    assert.equal(r.generation.restored, true, c.name);
  }
  // Pre-degraded host: tolerated only while the failed set does not grow.
  reset();
  fs.writeFileSync(path.join(F, "failed-pre"), "old-thing.service loaded failed failed Old\n");
  fs.writeFileSync(path.join(F, "failed"), "old-thing.service loaded failed failed Old\n");
  process.env.FAKE_ACTIVATE_EXIT = "4";
  process.env.FAKE_ACTIVATE_OUT = USER_BUS_OUT;
  assert.equal((await lt.runLab(cfg(), INST)).verdict, "pass");
  reset();
  fs.writeFileSync(path.join(F, "failed-pre"), "old-thing.service loaded failed failed Old\n");
  fs.writeFileSync(path.join(F, "failed"), "old-thing.service loaded failed failed Old\n");
  process.env.FAKE_ACTIVATE_EXIT = "4";
  process.env.FAKE_ACTIVATE_OUT = USER_BUS_OUT;
  process.env.FAKE_LAB_FAILS_UNIT = "docker-demo.service";
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "fail");
  assert.equal(r.checks.find((c) => c.id === "activate").ok, false);
  // Other non-zero exits are never tolerated.
  reset();
  process.env.FAKE_ACTIVATE_EXIT = "2";
  process.env.FAKE_ACTIVATE_OUT = USER_BUS_OUT;
  assert.equal((await lt.runLab(cfg(), INST)).checks.find((c) => c.id === "activate").ok, false);
});

test("classifyActivationExit4: user-level lines are fine, system-level lines and truncation are not", () => {
  const k = lt.classifyActivationExit4;
  assert.equal(k(USER_BUS_OUT).tolerable, true);
  assert.equal(k(USER_BUS_OUT).userBus, true);
  assert.deepEqual(k(USER_BUS_OUT).users, ["svcagent"]);
  const userUnits = "warning: user activation for svcagent failed\nFailed to restart user unit demo.service: x\nwarning: the following user units failed: demo.service\nFailed to restart nixos-activation.service: x";
  assert.equal(k(userUnits).tolerable, true);
  assert.equal(k(userUnits).userBus, false);
  assert.equal(k(`${USER_BUS_OUT}\nFailed to reload docker-demo.service: x`).tolerable, false);
  assert.equal(k(`${USER_BUS_OUT}\nFailed to stop docker-demo.service`).tolerable, false);
  assert.equal(k(`${USER_BUS_OUT}\nFailed to restart sysinit-reactivation.target: x`).tolerable, false);
  assert.equal(k(USER_BUS_OUT, { truncated: true }).tolerable, false);
  assert.equal(k("").tolerable, false);
});

test("incident checks carrying the worker's ids (c1…) run; a rejected check is a visible evidence note", async () => {
  const L = await import("../lib/lab-checks.js");
  // What the worker writes: validateCheckPlan output, ids included.
  const planned = L.validateCheckPlan({ checks: [{ type: "unit_active", unit: "docker-demo" }, { type: "journal_absent", unit: "docker-demo.service", pattern: "engine failed to load", id: "journal-1" }] });
  assert.deepEqual(planned.errors, []);
  assert.deepEqual(planned.checks.map((c) => c.id), ["c1", "journal-1"]);
  reset(spec({ lab_checks: planned.checks }));
  let r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "pass", r.reason);
  assert.deepEqual(r.plan_errors, []);
  assert.equal(r.checks.length, 5 + 2);
  assert.deepEqual(r.checks.slice(5).map((c) => c.id), ["c1", "journal-1"]);
  assert.ok(!r.evidence.some((l) => /dropped/.test(l)));
  // A bad check (here: a malformed id) is dropped, and says so on the card.
  reset(spec({ lab_checks: [{ type: "unit_active", unit: "docker-demo.service", id: "no spaces allowed" }, { type: "unit_active", unit: "docker-demo.service", id: "c2" }] }));
  r = await lt.runLab(cfg(), INST);
  assert.equal(r.checks.length, 6);
  assert.match(r.plan_errors[0], /^#1: unit_active: id must be/);
  assert.ok(r.evidence.some((l) => /^check #1 dropped: unit_active: id must be/.test(l)), JSON.stringify(r.evidence));
});

// ---------------------------------------------------------------- protected runs

const Database = (await import("better-sqlite3")).default;
const L = await import("../lib/lab-checks.js");
const crypto = await import("node:crypto");
const KEY = "a".repeat(64);
function approvalDb() {
  const db = new Database(path.join(OPS, "ops.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS incident_events (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT, meta_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  return db;
}
function approvalKey() {
  const dir = path.join(OPS, "private");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const f = path.join(dir, "lab-approval.key");
  if (!fs.existsSync(f)) fs.writeFileSync(f, KEY, { mode: 0o400 });
}
/** What the app writes on "Approve lab test": DB event + signed approval in the spec. */
function approved(s = spec(), { meta = {}, instance = INST, at = new Date().toISOString(), tamper = null } = {}) {
  approvalKey();
  const db = approvalDb();
  const id = Number(
    db
      .prepare("INSERT INTO incident_events (incident_id, kind, message, meta_json) VALUES (?, ?, ?, ?)")
      .run(7, meta.kind || "lab_approved", "Lab test approved", JSON.stringify({ lab_job: instance, head_sha: s.head_sha, branch: s.branch, approved_by: "admin", ...meta })).lastInsertRowid,
  );
  db.close();
  const msg = L.labApprovalMessage({ incident_id: 7, instance, branch: s.branch, head_sha: s.head_sha, event_id: id, approved_at: at });
  const sig = crypto.createHmac("sha256", KEY).update(msg).digest("hex");
  const out = { ...s, protected: { areas: ["hermes"], paths: ["nix/services/hermes"], core: false }, approved_by: "admin", approval: { v: 1, by: "admin", event_id: id, approved_at: at, sig } };
  if (tamper) tamper(out);
  return out;
}
const touchHermes = () => fs.writeFileSync(path.join(SRC_BRANCH, "nix/services/hermes/default.nix"), "{ hermes = true; extra = 1; }\n");

test("protected change without approval: detected by the runner itself, nothing built or activated", async () => {
  touchHermes();
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "error");
  assert.equal(r.failed_stage, "approval");
  assert.equal(r.approval_required, true);
  assert.deepEqual(r.protected.paths, ["nix/services/hermes"]);
  assert.equal(r.protected.label, "hermes");
  assert.equal(r.protected.detected, true);
  assert.match(r.reason, /protected change \(hermes\) needs an admin approval; nothing built or activated/);
  assert.doesNotMatch(log(), /nix .*build|^switch |systemd-run/m);
  // Base system: flagged as core.
  reset();
  fs.writeFileSync(path.join(SRC_BRANCH, "nix/modules/core/default.nix"), "{ core = false; }\n");
  fs.mkdirSync(path.join(SRC_BRANCH, "nix/services/swag"), { recursive: true });
  fs.writeFileSync(path.join(SRC_BRANCH, "nix/services/swag/new.nix"), "{ }\n");
  const r2 = await lt.runLab(cfg(), INST);
  assert.equal(r2.approval_required, true);
  assert.deepEqual(r2.protected.areas.sort(), ["base system", "swag"]);
  assert.equal(r2.protected.core, true);
  // Unrelated change: normal run, no approval needed.
  reset();
  fs.writeFileSync(path.join(SRC_BRANCH, "nix/services/searxng/default.nix"), "{ limiter = true; }\n");
  const r3 = await lt.runLab(cfg(), INST);
  assert.equal(r3.verdict, "pass", r3.reason);
  assert.equal(r3.protected, undefined);
  // Cannot tell (source not fetchable) → treated as protected (fail closed).
  reset();
  process.env.FAKE_META_FAIL = "1";
  const r4 = await lt.runLab(cfg(), INST);
  assert.equal(r4.approval_required, true);
  assert.equal(r4.protected.unknown, true);
  assert.doesNotMatch(log(), /^switch /m);
  // A spec that claims "protected" without an approval is refused too.
  reset(spec({ protected: { paths: ["nix/services/hermes"] } }));
  assert.equal((await lt.runLab(cfg(), INST)).approval_required, true);
  // Lab host not shared with ops: no protected-path gate.
  reset();
  touchHermes();
  const r5 = await lt.runLab(lt.labConfig({ ...process.env, LABTEST_SHARES_OPS_HOST: "false" }), INST);
  assert.equal(r5.verdict, "pass", r5.reason);
});

test("approved protected run: HMAC + DB event verified, short watchdog, services verified after rollback, approval single-use", async () => {
  touchHermes();
  const s = approved();
  reset(s);
  touchHermes();
  const r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "pass", `${r.reason} ${JSON.stringify(r.checks)}`);
  assert.equal(r.protected.approved, true);
  assert.equal(r.protected.approval_event_id, s.approval.event_id);
  assert.equal(r.watchdog.deadline_sec, 120, "protected watchdog deadline");
  assert.match(log(), /systemd-run .*--on-active=120s/);
  assert.match(log(), /sqlite3 -readonly -json \S+ops\.sqlite SELECT id, incident_id, kind, meta_json FROM incident_events WHERE id = \d+;/);
  assert.ok(r.evidence.some((l) => /^protected run \(hermes\): approved by admin \(event #\d+\); watchdog 120 s/.test(l)), JSON.stringify(r.evidence));
  assert.ok(r.evidence.includes("after rollback: ops /health ok (HTTP 200)"));
  assert.ok(r.evidence.includes("after rollback: Hermes ok (active)"));
  assert.equal(r.post_rollback_services.ok, true);
  assert.equal(r.services_unhealthy, undefined);
  assert.equal(r.generation.restored, true);
  assert.ok(fs.existsSync(path.join(STATE, "approvals", `${s.approval.event_id}.used`)));
  // Same approval again (e.g. a worker re-queues the spec): refused.
  reset(s);
  touchHermes();
  const again = await lt.runLab(cfg(), INST);
  assert.equal(again.approval_invalid, true);
  assert.match(again.reason, /approval rejected: approval already used/);
  assert.doesNotMatch(log(), /^switch /m);
});

test("approval forgery / mismatch is refused before building", async () => {
  const cases = [
    ["bad signature", approved(spec(), { tamper: (o) => (o.approval.sig = "0".repeat(64)) }), /signature invalid/],
    ["other branch", approved(spec(), { tamper: (o) => (o.branch = "fix/other") }), /signature invalid/],
    ["event for another job", approved(spec(), { meta: { lab_job: "lab-7-other" } }), /does not match this job/],
    ["event of another kind", approved(spec(), { meta: { kind: "admin_update" } }), /does not match this job/],
    ["missing event", approved(spec(), { tamper: (o) => { o.approval.event_id = 999999; o.approval.sig = crypto.createHmac("sha256", KEY).update(L.labApprovalMessage({ incident_id: 7, instance: INST, branch: o.branch, head_sha: o.head_sha, event_id: 999999, approved_at: o.approval.approved_at })).digest("hex"); } }), /not found in the ops DB/],
    ["expired", approved(spec(), { at: new Date(Date.now() - 4 * 86400_000).toISOString() }), /expired/],
    ["not by admin", approved(spec(), { tamper: (o) => (o.approval.by = "worker") }), /malformed/],
  ];
  for (const [name, s, why] of cases) {
    reset(s);
    touchHermes();
    const r = await lt.runLab(cfg(), INST);
    assert.equal(r.approval_invalid, true, name);
    assert.match(r.reason, why, name);
    assert.doesNotMatch(log(), /nix .*build|^switch /m, name);
  }
  // Key readable by others (or owned by another uid) → no approval is trusted.
  const s = approved();
  fs.chmodSync(path.join(OPS, "private", "lab-approval.key"), 0o440);
  reset(s);
  touchHermes();
  let r = await lt.runLab(cfg(), INST);
  assert.match(r.reason, /approval key has the wrong owner, mode or size/);
  fs.chmodSync(path.join(OPS, "private", "lab-approval.key"), 0o400);
  reset(s);
  touchHermes();
  r = await lt.runLab(lt.labConfig({ ...process.env, LABTEST_OPS_UID: String(process.getuid() + 1) }), INST);
  assert.match(r.reason, /approval key dir has the wrong owner or mode/);
});

test("approved protected run: ops down after activation → immediate rollback, ops restarted and verified", async () => {
  const s = approved();
  reset(s);
  touchHermes();
  process.env.FAKE_LAB_KILLS_OPS = "1";
  const t0 = Date.now();
  const r = await lt.runLab(cfg(), INST);
  assert.ok(Date.now() - t0 < 15000, "no full check timeouts");
  assert.equal(r.verdict, "fail");
  assert.match(r.reason, /protected run: ops \/health down \(HTTP 503\) after activation; rolled back immediately/);
  assert.equal(r.protected_probe.ops_health, false);
  assert.ok(r.checks.filter((c) => !c.generic).every((c) => c.ok === false && /rolled back immediately/.test(c.detail)));
  assert.ok(r.evidence.some((l) => /ops \/health down \(HTTP 503\) after activation → rolling back immediately/.test(l)));
  assert.ok(r.evidence.includes("after rollback: ops /health down (HTTP 503); restarting docker-ops.service"));
  assert.ok(r.evidence.includes("after restart of docker-ops.service: ops /health ok (HTTP 200)"));
  assert.equal(r.post_rollback_services.ops_health.restarted, true);
  assert.equal(r.post_rollback_services.ok, true);
  assert.equal(r.generation.restored, true);
  assert.equal(fs.realpathSync(CUR), BASE);
  // Rollback heals ops by itself: no restart.
  const s2 = approved();
  reset(s2);
  touchHermes();
  process.env.FAKE_LAB_KILLS_OPS = "1";
  process.env.FAKE_ROLLBACK_HEALS = "1";
  const r2 = await lt.runLab(cfg(), INST);
  assert.equal(r2.post_rollback_services.ops_health.restarted, false);
  assert.doesNotMatch(log(), /systemctl restart docker-ops/);
});

test("approved protected run: Hermes killed and not back after rollback → restarted; ops that stays down is flagged", async () => {
  let s = approved();
  reset(s);
  touchHermes();
  process.env.FAKE_LAB_KILLS_HERMES = "1";
  let r = await lt.runLab(cfg(), INST);
  assert.equal(r.verdict, "fail");
  assert.match(r.reason, /Hermes inactive after activation/);
  assert.match(log(), /systemctl restart hermes-agent\.service/);
  assert.ok(r.evidence.includes("after restart of hermes-agent.service: Hermes ok (active)"));
  assert.equal(r.services_unhealthy, undefined);
  s = approved();
  reset(s);
  touchHermes();
  process.env.FAKE_LAB_KILLS_OPS = "1";
  process.env.FAKE_OPS_RESTART_FAILS = "1";
  r = await lt.runLab(cfg(), INST);
  assert.equal(r.services_unhealthy, true);
  assert.equal(r.services_reason, "ops /health");
  assert.ok(r.evidence.includes("after restart of docker-ops.service: ops /health STILL DOWN (HTTP 503)"));
  assert.equal(r.generation.restored, true, "the rollback itself is still verified");
});

test("watchdog of a protected run also verifies and restarts ops / Hermes", async () => {
  const dir = path.join(STATE, INST);
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, "result.json"), { force: true });
  fs.writeFileSync(path.join(F, "ops-down"), "");
  const act = {
    version: 1,
    instance: INST,
    phase: "activating",
    before: BASE,
    lab: LAB,
    current_link: CUR,
    profile: PROFILE,
    store_prefix: STORE,
    rollback_timeout_sec: 20,
    lab_unit: `heimcloud-ops-labtest@${INST}.service`,
    systemctl: path.join(B, "systemctl"),
    flock: "flock",
    system_lock: path.join(LOCKS, "system.lock"),
    flake: FLAKE,
    pins: [],
    protected: true,
    ops_health: `http://localhost:${port}/health`,
    ops_unit: "docker-ops.service",
    hermes_unit: "hermes-agent.service",
    recover_sec: 1,
  };
  fs.writeFileSync(path.join(dir, "activation.json"), JSON.stringify(act));
  fs.rmSync(CUR);
  fs.symlinkSync(LAB, CUR);
  const w = await lt.runWatchdog(path.join(dir, "activation.json"), { ...process.env, LABTEST_POLL_MS: "20" });
  assert.equal(w.restored, true);
  assert.equal(w.services.ok, true);
  assert.equal(w.services.ops_health.restarted, true);
  const res = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.ok(res.evidence.includes("after restart of docker-ops.service: ops /health ok (HTTP 200)"), JSON.stringify(res.evidence));
  assert.equal(res.services_unhealthy, false);
});
