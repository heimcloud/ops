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
true`,
  );
  system(
    LAB,
    `touch "${F}/lab-was-active"
[ -n "\${FAKE_LAB_FAILS_UNIT:-}" ] && echo "\${FAKE_LAB_FAILS_UNIT} loaded failed failed Demo" >> "${F}/failed"
[ -n "\${FAKE_LAB_ONLY_UNIT:-}" ] && echo "\${FAKE_LAB_ONLY_UNIT} loaded failed failed Lab only" >> "${F}/failed"
[ -n "\${FAKE_LAB_HANG:-}" ] && sleep 30
ln -sfn "$(dirname "$(dirname "$0")")" "${CUR}"
exit "\${FAKE_ACTIVATE_EXIT:-0}"`,
  );
  system(OTHER);
  sh(
    path.join(B, "nix"),
    `echo "nix $*" >> "${F}/log"
case "$*" in *"flake metadata"*)
  echo '{"locks":{"root":"root","nodes":{"root":{"inputs":{"neo":"neo_2"}},"neo_2":{"locked":{"type":"github","rev":"'"\${FAKE_REV:-${"1".repeat(40)}}"'"}}}}}'
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
  sh(path.join(B, "journalctl"), `echo "journalctl $*" >> "${F}/log"; cat "${F}/journal" 2>/dev/null; exit 0`);
  server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(health);
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

function reset(s = spec()) {
  for (const f of fs.readdirSync(F)) fs.rmSync(path.join(F, f), { force: true });
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
  for (const k of ["FAKE_LAB_ONLY_UNIT", "FAKE_STILL_FAILED", "FAKE_REV", "FAKE_NIX_MODE", "FAKE_ACTIVATE_EXIT", "FAKE_LAB_FAILS_UNIT", "FAKE_SDRUN_FAIL", "FAKE_LAB_HANG"]) delete process.env[k];
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
