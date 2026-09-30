/**
 * Worker queue control + self-lockout hardening: priority order, pause,
 * poison-job quarantine, malformed jobs, unwritable results, Hermes process
 * group kill on timeout, cancel of a running job, heartbeats, and the
 * systemd kick watchdog. Fake hermes / systemctl, synthetic data only.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-wctl-"));
const data = path.join(tmp, "data");
const bin = path.join(tmp, "bin");
const Q = path.join(data, "queue");

function sh(file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -u\n${body}\n`, { mode: 0o755 });
}

before(() => {
  fs.mkdirSync(bin, { recursive: true });
  // Fake hermes (triage skill only). Records the incident order; modes:
  //  ok (verdict), sleep (spawns a grandchild then hangs), cancel (raises the
  //  admin cancel flag for its own job, then hangs), beat (snapshots status).
  sh(
    path.join(bin, "hermes"),
    `q=""; prev=""
for a in "$@"; do [ "$prev" = --query-file ] && q="$a"; prev="$a"; done
head -1 "$q" | sed 's/.*#//' >> "${tmp}/order"
case "\${FAKE_HERMES_MODE:-ok}" in
  sleep) sleep 60 & echo $! > "${tmp}/grandchild.pid"; wait ;;
  cancel)
    for f in "$OPS_DATA_DIR"/queue/processing/*.json; do touch "$OPS_DATA_DIR/queue/control/cancel-$(basename "$f")"; done
    sleep 60 & echo $! > "${tmp}/grandchild.pid"; wait ;;
  beat) sleep 1; cp "$OPS_DATA_DIR/queue/worker-status.json" "${tmp}/status-mid.json" ;;
esac
echo '{"class":"software","severity":"warning","summary":"ok","target_repo":"madebydamo/neo","fixable":false,"verdict":"not_actionable"}'`,
  );
  // Fake systemctl: state from FAKE_<UNIT>_STATE="Active Sub Result"; calls logged.
  sh(
    path.join(bin, "systemctl"),
    `echo "$*" >> "${tmp}/systemctl.log"
if [ "$1" = show ]; then
  case "$2" in
    *.path) st="\${FAKE_PATH_STATE:-active waiting success}" ;;
    *) st="\${FAKE_SVC_STATE:-inactive dead success}" ;;
  esac
  set -- $st
  printf 'LoadState=loaded\\nActiveState=%s\\nSubState=%s\\nResult=%s\\nExecMainStatus=0\\nNRestarts=0\\nStateChangeTimestamp=@1790000000\\n' "$1" "$2" "$3"
fi
exit 0`,
  );
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    OPS_DATA_DIR: data,
    OPS_DB_PATH: path.join(data, "ops.sqlite"),
    OPS_AUTOFIX_LOCK: path.join(tmp, "run", "lock"),
    OPS_AUTOFIX_TRIAGE: "1",
    OPS_AUTOFIX_FIX: "1",
    OPS_AUTOFIX_ENV_BIN: path.join(bin, "no-such-env"),
    OPS_AUTOFIX_SCRATCH: path.join(tmp, "scratch"),
    OPS_AUTOFIX_KILL_GRACE_SEC: "0.3",
    OPS_AUTOFIX_CANCEL_POLL_MS: "100",
    OPS_AUTOFIX_HEARTBEAT_SEC: "0.2",
    OPS_SYSTEMCTL_BIN: path.join(bin, "systemctl"),
  });
  delete process.env.OPS_REDACT_EXTRA_SLUGS;
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(data, { recursive: true, force: true });
  for (const k of ["triage", "fix", "push", "processing", "done", "failed", "control"]) {
    fs.mkdirSync(path.join(Q, k), { recursive: true });
  }
  fs.mkdirSync(path.join(data, "results"), { recursive: true });
  for (const f of ["order", "grandchild.pid", "status-mid.json", "systemctl.log"]) fs.rmSync(path.join(tmp, f), { force: true });
  process.env.FAKE_HERMES_MODE = "ok";
  process.env.OPS_AUTOFIX_HERMES_TIMEOUT_SEC = "30";
});

const W = await import("../../scripts/autofix/worker.mjs");
const QC = await import("../lib/queue-control.js");

function enqueue(kind, id, sec, extra = {}) {
  const name = `${id}-2026-01-01T00-00-${String(sec).padStart(2, "0")}-000Z.json`;
  fs.writeFileSync(path.join(Q, kind, name), JSON.stringify({ job_version: 1, kind, incident_id: id, report_hash: "h", unit: "docker-x", severity: "warning", class: "software", logs_excerpt: "x", ...extra }));
  return name;
}
const order = () => fs.readFileSync(path.join(tmp, "order"), "utf8").split("\n").filter(Boolean).map(Number);
const status = () => JSON.parse(fs.readFileSync(path.join(Q, "worker-status.json"), "utf8"));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), "utf8"));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("priority ordering: priority > manual rank > kind (push > triage > fix) > enqueue time", () => {
  const j = (kind, name, at, extra = {}) => ({ kind, name, key: `${kind}/${name}`, priority: "normal", rank: null, enqueuedAt: at, ...extra });
  const sorted = QC.sortPending([
    j("fix", "1-a.json", 1),
    j("triage", "2-a.json", 5),
    j("push", "3-a.json", 9),
    j("triage", "4-a.json", 2),
    j("fix", "5-a.json", 0, { priority: "low" }),
    j("fix", "6-a.json", 8, { priority: "high" }),
  ]).map((x) => x.name);
  assert.deepEqual(sorted, ["6-a.json", "3-a.json", "4-a.json", "2-a.json", "1-a.json", "5-a.json"]);
  // Manual rank within a priority beats the kind default.
  const ranked = QC.sortPending([j("push", "3-a.json", 9, { rank: 1 }), j("fix", "1-a.json", 1, { rank: 0 })]).map((x) => x.name);
  assert.deepEqual(ranked, ["1-a.json", "3-a.json"]);
  assert.equal(QC.enqueuedAtFromName("7-2026-09-30T10-15-00-123Z.json"), Date.parse("2026-09-30T10:15:00.123Z"));
});

test("applyMove: moving across a priority boundary adopts the neighbour's priority", () => {
  const pending = [
    { kind: "triage", name: "1-a.json", key: "triage/1-a.json", priority: "high", rank: null, enqueuedAt: 1 },
    { kind: "triage", name: "2-a.json", key: "triage/2-a.json", priority: "normal", rank: null, enqueuedAt: 2 },
    { kind: "fix", name: "3-a.json", key: "fix/3-a.json", priority: "normal", rank: null, enqueuedAt: 3 },
  ];
  const up = QC.applyMove(pending, {}, "triage/2-a.json", "up");
  assert.equal(up["triage/2-a.json"].priority, "high");
  const again = QC.sortPending(pending.map((p) => ({ ...p, ...up[p.key] }))).map((p) => p.name);
  assert.deepEqual(again, ["2-a.json", "1-a.json", "3-a.json"]);
  const down = QC.applyMove(pending, {}, "fix/3-a.json", "top");
  assert.equal(down["fix/3-a.json"].priority, "high");
  assert.equal(QC.applyMove(pending, {}, "nope", "up"), null);
});

test("worker claims by priority file, re-read before every claim", () => {
  enqueue("triage", 1, 1);
  const b = enqueue("triage", 2, 2);
  const c = enqueue("triage", 3, 3);
  QC.writePriorityFile(Q, { jobs: { [`triage/${c}`]: { priority: "high" }, [`triage/${b}`]: { priority: "low" } } });
  assert.equal(W.main([]), 0);
  assert.deepEqual(order(), [3, 1, 2]);
  assert.equal(status().last_run.incident_id, 2);
  assert.equal(status().state, "idle");
});

test("pause: nothing is claimed while paused; resume drains", () => {
  const name = enqueue("triage", 4, 1);
  QC.setPaused(Q, true);
  assert.equal(W.main([]), 0);
  assert.ok(fs.existsSync(path.join(Q, "triage", name)));
  assert.equal(status().state, "paused");
  QC.setPaused(Q, false);
  W.main([]);
  assert.ok(fs.existsSync(path.join(Q, "done", `triage-${name}`)));
  assert.equal(status().state, "idle");
});

test("poison job: first crash requeues once, second crash quarantines as 'crashed worker'", () => {
  const name = "5-2026-01-01T00-00-01-000Z.json";
  fs.writeFileSync(path.join(Q, "processing", `triage-${name}`), JSON.stringify({ kind: "triage", incident_id: 5, _claims: 1 }));
  W.main([]);
  // Requeued, then claimed (claim 2) and finished normally.
  assert.ok(fs.existsSync(path.join(Q, "done", `triage-${name}`)));
  assert.equal(readJson(Q, "done", `triage-${name}`)._claims, 2);
  assert.ok(status().issues.some((i) => i.code === "requeued_after_crash"));

  fs.writeFileSync(path.join(Q, "processing", `triage-${name}`), JSON.stringify({ kind: "triage", incident_id: 5, _claims: 2 }));
  W.main([]);
  assert.ok(fs.existsSync(path.join(Q, "failed", `triage-${name}`)));
  assert.equal(readJson(Q, "failed", `triage-${name.replace(/\.json$/, "")}.reason.json`).reason, "crashed worker (2 claims)");
  const r = readJson(data, "results", `triage-${name}`);
  assert.equal(r.status, "triage_failed");
  assert.match(r.summary, /crashed worker/);
  assert.equal(status().issues[0].code, "poison_quarantined");
});

test("malformed job JSON goes to failed/ with a reason and a result", () => {
  const name = "6-2026-01-01T00-00-01-000Z.json";
  fs.writeFileSync(path.join(Q, "triage", name), "{not json");
  const good = enqueue("triage", 7, 2);
  assert.equal(W.main([]), 0);
  assert.ok(fs.existsSync(path.join(Q, "failed", `triage-${name}`)));
  assert.equal(readJson(Q, "failed", `triage-${name.replace(/\.json$/, "")}.reason.json`).code, "malformed_job");
  assert.equal(readJson(data, "results", `triage-${name}`).status, "triage_failed");
  assert.ok(fs.existsSync(path.join(Q, "done", `triage-${good}`)), "loop continues after a bad job");
  assert.ok(status().issues.some((i) => i.code === "malformed_job"));
});

test("unwritable results: job fails cleanly, worker exits 0 and keeps going", () => {
  fs.rmSync(path.join(data, "results"), { recursive: true });
  fs.writeFileSync(path.join(data, "results"), "not a dir");
  const a = enqueue("triage", 8, 1);
  const b = enqueue("triage", 9, 2);
  assert.equal(W.main([]), 0);
  for (const n of [a, b]) {
    assert.ok(fs.existsSync(path.join(Q, "failed", `triage-${n}`)));
    assert.equal(readJson(Q, "failed", `triage-${n.replace(/\.json$/, "")}.reason.json`).code, "results_unwritable");
  }
  assert.equal(fs.readdirSync(path.join(Q, "processing")).length, 0);
  assert.equal(status().issues[0].code, "results_unwritable");
  assert.equal(status().last_run.ok, false);
});

test("hermes timeout kills the whole process group (grandchildren too)", () => {
  process.env.FAKE_HERMES_MODE = "sleep";
  process.env.OPS_AUTOFIX_HERMES_TIMEOUT_SEC = "1";
  const name = enqueue("triage", 10, 1);
  const t0 = Date.now();
  W.main([]);
  assert.ok(Date.now() - t0 < 15_000);
  const gc = Number(fs.readFileSync(path.join(tmp, "grandchild.pid"), "utf8"));
  assert.equal(alive(gc), false, "grandchild of hermes must be killed");
  const r = readJson(data, "results", `triage-${name}`);
  assert.equal(r.status, "triage_failed");
  assert.match(r.summary, /timed out \(process group killed\)/);
  assert.ok(status().issues.some((i) => i.code === "hermes_killed"));
});

test("cancel running job: flag stops Hermes (process group), result leaves a sane status", () => {
  process.env.FAKE_HERMES_MODE = "cancel";
  const name = enqueue("triage", 11, 1);
  const t0 = Date.now();
  W.main([]);
  assert.ok(Date.now() - t0 < 15_000);
  assert.equal(alive(Number(fs.readFileSync(path.join(tmp, "grandchild.pid"), "utf8"))), false);
  const r = readJson(data, "results", `triage-${name}`);
  assert.equal(r.status, "triage_cancelled");
  assert.ok(fs.existsSync(path.join(Q, "failed", `triage-${name}`)));
  assert.equal(readJson(Q, "failed", `triage-${name.replace(/\.json$/, "")}.reason.json`).code, "cancelled");
  assert.equal(fs.existsSync(path.join(Q, "control", `cancel-triage-${name}`)), false, "flag cleaned up");
  assert.equal(W.cancelledResult("fix", { incident_id: 3 }, "hermes").status, "cancelled");
  assert.equal(W.cancelledResult("push", { incident_id: 3, job: "fix-3-x" }, "push").push_error, "cancelled");
});

test("heartbeat + stage are written while Hermes runs", () => {
  process.env.FAKE_HERMES_MODE = "beat";
  enqueue("triage", 12, 1);
  W.main([]);
  const mid = JSON.parse(fs.readFileSync(path.join(tmp, "status-mid.json"), "utf8"));
  assert.equal(mid.state, "running");
  assert.equal(mid.job.kind, "triage");
  assert.equal(mid.job.incident_id, 12);
  assert.equal(mid.job.stage, "hermes");
  assert.ok(Date.parse(mid.heartbeat_at) > Date.parse(mid.job.stage_at), "supervisor heartbeat after the stage write");
  assert.equal(mid.hermes_timeout_sec, 30);
  assert.equal(typeof mid.fork_push_token, "boolean");
});

test("kick: failed/start-limit units + pending jobs -> reset-failed and start; status file written", () => {
  enqueue("triage", 13, 1);
  process.env.FAKE_SVC_STATE = "failed failed start-limit-hit";
  process.env.FAKE_PATH_STATE = "failed failed trigger-limit-hit";
  const st = W.kick(W.config());
  const calls = fs.readFileSync(path.join(tmp, "systemctl.log"), "utf8");
  assert.match(calls, /reset-failed heimcloud-ops-worker\.path heimcloud-ops-worker\.service/);
  assert.match(calls, /start heimcloud-ops-worker\.path/);
  assert.match(calls, /start --no-block heimcloud-ops-worker\.service/);
  const file = readJson(Q, "systemd-status.json");
  assert.equal(file.pending, 1);
  assert.equal(file.units.service.result, "start-limit-hit");
  assert.deepEqual(st.wedged_before, ["heimcloud-ops-worker.path", "heimcloud-ops-worker.service"]);
  assert.equal(file.units.service.changed_at, new Date(1790000000 * 1000).toISOString());

  // Paused: units repaired but the worker is not started.
  fs.rmSync(path.join(tmp, "systemctl.log"));
  QC.setPaused(Q, true);
  process.env.FAKE_SVC_STATE = "inactive dead success";
  process.env.FAKE_PATH_STATE = "active waiting success";
  W.kick(W.config());
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, "systemctl.log"), "utf8"), /^(start|reset-failed)/m);
  delete process.env.FAKE_SVC_STATE;
  delete process.env.FAKE_PATH_STATE;
});
