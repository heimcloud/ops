# Auto-fix loop design

**Goal:** the ops host turns incidents into **already-coded, lab-tested fix branches**. The runner pushes the branch to the `heimcloud/neo` fork and posts a compare link in Ops; Damo opens the upstream PR in the GitHub web UI. Humans merge; nothing auto-merges.

Implements [REQ-G10](REQUIREMENTS.md#g-ops--hermes-self-improvement) (local Hermes only) and [REQ-G12](REQUIREMENTS.md#g-ops--hermes-self-improvement) (test before PR). Outbound GitHub text follows [REQ-G11](REQUIREMENTS.md#g-ops--hermes-self-improvement) via `app/lib/redact.js`.

## Flow

```mermaid
flowchart TD
  A[Ingest incident<br/>idempotent on report_hash] --> B[Queue triage job]
  B --> C[heimcloud-ops-worker@<br/>as user hermes]
  C --> D["hermes --yolo chat -Q<br/>skill: heimcloud-ops-triage"]
  D --> E{Class + summary}
  E -->|ok| F[Status: triaged]
  E -->|model down / 403| X[triage_failed or leave open<br/>backoff + Telegram]
  F --> G[Queue fix job<br/>max concurrent = 1]
  G --> H["hermes skill: heimcloud-ops-fix<br/>branch fix/topic or ops/incident-N"]
  H --> I[Redaction scan fail-closed]
  I -->|clean| J[Push branch as heimcloud<br/>fork tip only]
  I -->|hit| K[Abort push; needs_human]
  J --> L0["lab job queued<br/>Hermes plans checks (whitelisted schema)"]
  L0 --> L["root heimcloud-ops-labtest@job<br/>locks, record generation + pins,<br/>arm watchdog, activate branch tip"]
  L --> M{Generic + incident checks}
  M --> O[ALWAYS switch back to the recorded system<br/>verify generation + byte-identical pins]
  O -->|pass| N[Compare link + anonymized evidence<br/>Damo opens upstream PR / merge]
  O -->|fail| P{Attempts &lt; maxAttempts?}
  P -->|yes: evidence fed back| H
  P -->|no| Q[needs_human<br/>NO PR]
```

## Hard rules

| Rule | Detail |
|------|--------|
| Local AI only | Triage, summaries, and coding run on **local Hermes** on the ops host (`hermes-agent.service`, `hermes gateway`, provider xai-oauth / `grok-build-latest`). No external/cloud coding agents. |
| Non-interactive call | As user `hermes`: `hermes --yolo chat -Q --source tool --max-turns 40 -s <skill> --query-file <prompt_file>` (same pattern as supervise). Auth in `$HERMES_HOME/auth.json` (`HERMES_HOME=/var/neo/DATA/AppData/hermes/.hermes`). Port 18789 is configured but not listening — do not depend on it. |
| GitHub from ops host only | No GitHub App is used in this phase. Credentials provide a fine-grained fork-push token at `/run/heimcloud-autofix/github-token`; `heimcloud-autofix-env <cmd>` sets the scoped Git helper for the child process, and `--check` non-zero means triage-only. Hermes pushes the fix branch to `heimcloud/neo`; the runner posts the compare link and prepared body in Ops, and Damo opens the upstream PR in the GitHub web UI. Never on lab machines; nix/flake fetches stay unauthenticated. |
| Lab pull | Public fork **branch tip** (e.g. `github:heimcloud/neo/fix/…`) as a one-off `--override-input` for the test build; never a SHA (or anything) written to persistent config; **no** GitHub auth on lab boxes. |
| Redaction | Before any GitHub write: branch name, commit message, diff, PR title/body, evidence. `app/lib/redact.js` + DB `DISTINCT customer_repo_slug` + `OPS_REDACT_EXTRA_SLUGS`. **Fail closed** on hit; `app/test` enforces payload anonymity. |
| Branch names | `fix/<short-topic>` or `ops/incident-<n>` — no customer info. |
| No auto-merge | The runner does not open or merge a PR; Damo opens the upstream PR from the compare link and merges it. |

## Ops ↔ Hermes bridge (no container network change)

Ops runs `NetworkMode=internal` and cannot reach Hermes. Use the host filesystem:

1. Ops writes job JSON under `/var/neo/DATA/AppData/ops/queue/{triage,fix}/`.
2. A systemd **`.path`** unit starts oneshot `heimcloud-ops-worker@…` **as `hermes`**.
3. Worker invokes Hermes with skill `heimcloud-ops-triage` or `heimcloud-ops-fix`, writes results under a results dir.
4. Ops ingests results as `incident_events` (and status updates).

## Shared ops/lab host

Fleet audit (24 Sep): **the ops host** (docker-ops, Hermes, Gitea, shop) **is also the only lab box**; the second lab box is paused.

Until a dedicated lab box exists:

- **Deny-list** auto-fixes that touch **ops, hermes, swag, or the base system** (see "Deny-path policy" below).
- Every lab test records the current generation and **always** switches back to it, test passed or not (ops `/health`, Hermes unit, service under test are checked in between).
- **Recommend:** revive the dedicated lab box. Customer machines are never test targets.

## Lab test (automated lab stage)

`neo.services.ops.autofix.lab.enable` (needs `autofix.fix.enable`) replaces the old Fleet-owned `heimcloud-lab-test` stub hook with an automated stage owned end to end by the worker + Hermes, with a deterministic root runner. Without it the worker keeps the old behaviour (`heimcloud-lab-test` if on PATH, else `awaiting_lab_test` = manual test).

### Flow

1. **Fix job** (worker, user `hermes`): Hermes codes, the worker gates (identity, deny-list, redaction) and pushes `fix/<topic>` to the fork, then enqueues `queue/lab/<id>-<ts>.json` (branch, attempt, gated `head_sha`, compare link + PR text for later) and returns `lab_queued` → incident **testing**, no compare link yet.
2. **Lab job** (worker, kind `lab`, claim order push › **lab** › triage › fix: a pushed branch should be tested before new Hermes work starts on the shared host):
   - stage *planning*: Hermes skill `heimcloud-ops-labtest` gets the redacted incident + changed file list and answers a JSON check plan. The worker validates it (`lab-checks.js`, whitelist below); nothing usable → default check (incident unit active). The validated list goes into the processing copy of the job (`lab_checks`, `lab_plan`).
   - `systemctl start --no-block heimcloud-ops-labtest@lab-<id>-<ts>.service` (the only privileged call), then it follows `/var/lib/heimcloud-ops-labtest/<instance>/status.json` into `worker-status.json` (`lab_stage`, `lab_step/lab_steps`) and waits for `result.json`.
3. **Root runner** (`scripts/autofix/labtest.mjs --run <instance>`, see "Root runner" below) tests and always rolls back.
4. **Verdict** (worker → `results/lab-…json`, `via: "lab"`, attached to the tested Hermes attempt in `fix_attempts`):

| Runner verdict | Worker status | Incident | Board |
|---|---|---|---|
| pass | `compare_ready` (+ compare link, PR text) | **pr_opened** (Awaiting PR) | "Open the PR from the compare link", "Lab passed ✓n ✗0" |
| fail, attempt < maxAttempts | `lab_retry` + new fix job (`attempt+1`, same branch, redacted `lab_failure` evidence) | **fixing** | no badge; card shows "Lab failed ✓n ✗m" |
| fail, last attempt | `needs_human` (no compare link) | **needs_human** | "Lab test failed after N attempt(s)" |
| error (network / rate limit / lock timeout / arm failure / branch moved) | `lab_error`, job → `failed/` | **testing** | "Lab test error" + Retry lab |
| cancelled (before activation only) | `awaiting_lab_test`, `lab: cancelled` | **testing** | "Lab test cancelled" + Retry lab |
| rollback not verified | `needs_human`, "ROLLBACK NOT VERIFIED" | **needs_human** | "Lab rollback NOT verified: check the host" |

Retry rule (unchanged semantics of `autofix.maxAttempts`, default 2 = the first Hermes attempt + **one** lab-driven retry; `maxAttempts = 3` gives two retries). A lab failure is fed back verbatim-but-redacted (verdict, failed checks, evidence lines) and Hermes adds a **new commit on the same branch**. Build failures of the host config with the branch are `fail` (Hermes can fix them); infrastructure problems are `error` (no attempt consumed, admin Retry lab).

### Root runner

`heimcloud-ops-labtest@<instance>.service` (root, `Type=oneshot`, `Group=hermes`, `UMask=0027`, state `/var/lib/heimcloud-ops-labtest` 0750, `KillMode=mixed`, `restartIfChanged=false`):

1. **Validate** the spec `<ops>/queue/processing/<instance>.json` (opened `O_NOFOLLOW`, ≤512 KiB): kind `lab`, incident id = instance, branch `^(fix|ops)/[A-Za-z0-9._-]+(/…)*$` without `..`, 40-hex `head_sha`, checks **re-validated** with the same schema (the worker's validation is not trusted).
2. **Locks**: `flock -n <state>/lab.lock` (one lab at a time), then Neo's activation lock `flock -w lockWaitSec /run/neo/locks/system.lock` (the exclusive lock `neo activate`/`update`/auto-update and generation switches take), plus a Neo holder file `<lockdir>/<pid>-<seq>.holder` (`kind: "ops-labtest"`, label "Ops lab test (incident #N)") so a blocked `neo activate` names the lab test. An auto-update never overlaps a lab test and vice versa; a busy lock past `lockWaitSec` is `error`.
3. **Record**: `/run/current-system`, `/run/booted-system`, the system profile generation number (`system-N-link`), the failed-unit set and `is-system-running`; snapshot the pin files `flake.lock`, `flake.nix`, `settings.toml` of the host config flake (sha256 + backup copy).
4. **Build** `nix build --no-link --no-write-lock-file --override-input <input> github:heimcloud/neo/<branch> <flake>#nixosConfigurations.<name>.config.system.build.toplevel`, unauthenticated (token env vars and `NIX_CONFIG` dropped). Plugins that `follows` the neo input follow the override. Then `nix flake metadata` with the same override must resolve to the gated `head_sha`: a branch that moved after gating is never activated.
5. **Arm the watchdog** (below) and verify its timer is active; if arming fails nothing is activated.
6. **Activate** `<lab-toplevel>/bin/switch-to-configuration test`: no bootloader entry, no new profile generation, so even a crash/reboot comes back on the recorded system.
7. **Settle** (`settleSec`, then up to 180 s while `is-system-running` is still starting), then **checks** (generic + incident).
8. **finally (always)**: `<recorded-system>/bin/switch-to-configuration test`, verify `/run/current-system` = recorded, profile generation and booted system unchanged, pin files byte-identical (a changed file is restored from the backup and reported), then **disarm** the watchdog (stop the timer). If anything cannot be verified the watchdog stays armed and the result says `rollback_unverified`.
9. Write `result.json` (verdict, per-check results, generation before/after, pins, watchdog, activation exit, tested rev, redacted evidence). SIGTERM/stop only skips remaining checks; the rollback still runs.

### Watchdog

Before activation the runner arms `systemd-run --unit=heimcloud-ops-labtest-watchdog-<instance> --on-active=<deadline>s … heimcloud-ops-labtest --watchdog <state>/<instance>/activation.json`: a **transient root timer in PID 1**, independent of the ops container, the worker, Hermes and the lab unit itself. Deadline = activation + settle + checks + rollback timeouts + 300 s. When it fires it: SIGKILLs the lab unit, takes the Neo system lock (60 s wait, proceeds without it), and switches back to the recorded system **only if** the host is still on the lab system (or on the recorded one mid-activation); a system activated by someone else in between is left alone. It restores pin files from the backups and writes `watchdog.json` (and `result.json` if the runner never did). A bad activation that kills ops, Hermes or the worker is therefore still rolled back; a reboot boots the recorded generation because the lab system was never made a boot entry.

### Privilege model

- The worker runs as `hermes` and gets exactly one privileged capability: a polkit rule allows `org.freedesktop.systemd1.manage-units` for `subject.user == "hermes"`, verb **`start`**, unit `^heimcloud-ops-labtest@lab-[0-9]{1,9}-[A-Za-z0-9-]{1,80}\.service$`. No stop/restart/other units, no `nixos-rebuild`, no sudo rule. The instance name only selects a spec file; everything in it is re-validated by the root runner, and the check list is data for fixed code paths (no shell, no arbitrary URLs).
- The runner's own tools are absolute store paths (`LABTEST_*_BIN`); results are written root-owned, group `hermes` read-only.
- **Caveat:** neo's Hermes module currently gives `hermes` wheel + passwordless sudo for all commands. The narrow entry point is defence in depth until that is removed; removing it is a Fleet/neo decision (Hermes supervise flows use it).

### Check schema (Hermes-selectable, `lab-checks.js`)

Plan: `{"checks": [ … ]}`, max 12, unknown types or fields rejected (the check is dropped and the error recorded in `lab_plan.notes`), ids `c1…` assigned by the validator.

| type | fields | runner |
|---|---|---|
| `unit_active` | `unit` (systemd unit regex; bare name → `.service`), `label?` | `systemctl is-active` = active (retried until the check timeout) |
| `journal_absent` | `unit`, `pattern` (literal, 4–200 chars, case-insensitive substring), `label?` | `journalctl -u <unit> --since @<activation> -o cat`: no line contains the pattern |
| `http_status` | `url` (plain http on 127.0.0.1/localhost/::1 only, no credentials) **or** `container` + `port` + `path` (container IP from `docker inspect`), `expect_status?` (100–599, default 200), `contains?` (literal), `label?` | one GET (no redirects, 10 s timeout), retried until the check timeout |

Generic checks, always run, not selectable: activation exit 0 (and no timeout); `systemctl --failed` empty; `is-system-running` = running (degraded tolerated only if it was degraded before the test **and** the failed set did not grow); ops `/health` 200 (container `ops` port 3000 on the internal network, via `docker inspect`); Hermes unit active.

### Host flake layout (assumptions, all configurable)

From neo's server profile: the host config flake lives at `neo-cli.configPath` (default `/var/neo/DATA/AppData/configuration`), its `flake.nix` is generated from `settings.toml` (`neo-cli.neoInput` / `neo-cli.server.neoInput`), the neo input is called `neo`, plugins are `pluginN` with `inputs.neo.follows = "neo"`, and neo activates `nixosConfigurations.neo`. Options under `neo.services.ops.autofix.lab`: `flake`, `nixosConfiguration`, `input`, `flakeUrl` (`{branch}` placeholder; e.g. `git+https://github.com/heimcloud/neo?ref={branch}` if the unauthenticated GitHub API rate limit bites), `opsHealth`, `hermesUnit`, timeouts. Not determinable from the repo: the host's actual `configPath`/`neoInput`, whether a plugin pins neo separately (no `follows`), and whether root's `nix.conf` carries `access-tokens`.

### Deny-path policy

While `labSharesOpsHost` (default true) the worker refuses diffs under `nix/services/{ops,hermes,swag}` and `nix/modules/core` (status `denied` → needs_human "Diff touches a deny-listed path"). These never reach the lab stage: a bad activation of the ops/Hermes/proxy/base modules could break the very pieces that watch and roll back the test. The root runner additionally refuses a branch whose tip is not the gated commit.

**Proposal (not enabled): lab-testing deny-listed fixes later.**
1. *VM first*: for deny-listed diffs, build `nixosConfigurations.vm` (the neo template already has one) with the override and run the same check schema inside a QEMU VM (`nixos-rebuild build-vm` / NixOS test driver) on the host; no activation on the host at all. Pass → compare link marked "VM-tested only".
2. *Dedicated lab box*: revive the paused lab machine; the same root runner runs there (the queue/results bridge would move to a small pull agent), so ops/Hermes/swag fixes can be activated for real without risking the ops host.
3. Only after one of these exists: flip `labSharesOpsHost = false` for that target. Until then deny-listed fixes stay `needs_human`.

**Rollback is never "switch the neo input back to `master`".** The lab host may run a neo branch that is ahead of `master` (e.g. Gitea service, Hermes skill materialize), so a `master` rollback can remove live services. Fix branches must be based on the neo ref the lab host currently runs, and rollback uses the previous-generation switch that restores the exact prior system. On pass, the fix branch may stay deployed until it merges if it is a superset of the running ref.

Example checks for Ops incident #10 (SearXNG): no `can't register engine` lines; no limiter / proxy-header warning; healthz 200; search returns results.

**On failure:** rollback (always, pass or fail) → attach evidence to the incident → Hermes retry with failure context up to `maxAttempts` → then stop, status **`needs_human`**, **no PR**.

## Schema / control plane

- New statuses: e.g. `fixing`, `testing`, `needs_human` (plus existing `open` / `triaged` / `pr_opened` / …). Treat model outages as `triage_failed` or leave `open` with backoff.
- Table `fix_attempts` (incident_id, attempt, branch, result, evidence_path, created_at).
- Idempotency: ingest remains unique on `report_hash`; workers must not double-start the same incident.
- Rate limit: **max concurrent fixes = 1** while ops and lab share a host.
- Audit: every step → `incident_events`.

## Phases

1. **Triage only** — queue + Hermes skill → class/summary events (no code push).
2. **Fix + lab-test stub (implemented, default OFF)** — see runner contract below. Hermes codes on a fork branch; worker pushes via `heimcloud-autofix-env`; the runner posts a compare link; `heimcloud-lab-test` if on PATH (Fleet owns it).
3. **Full loop (implemented, `autofix.lab.enable`, default OFF)** — automatic lab test with always-rollback, evidence, retry, fork push, and compare link; Damo opens the upstream PR in the GitHub web UI.

**Ops incident #10** is the first **manually driven** example of the full loop (branch `fix/searxng-engines-limiter` on `heimcloud/neo`).

## Runner contract (ops plugin, opt-in)

**Default OFF.** `neo.services.ops.autofix.enable = false` installs nothing that calls Hermes.

| Piece | Detail |
|-------|--------|
| Queue | Container writes `/data/queue/{triage,fix}/<id>-<ts>.json` (the worker itself writes `queue/lab/` and lab-retry `queue/fix/` jobs; the admin writes `queue/push/` and Retry lab `queue/lab/`) atomically (host: `$appdata/ops/queue/…`; `/data` is a bind mount of `$appdata/ops`). Payload (`job_version: 1`): incident id, report_hash, unit, severity, class, neo_version, redacted logs only — never a slug. The admin refuses to enqueue when the kind is disabled on the host (`OPS_AUTOFIX_FIX` / `OPS_AUTOFIX_TRIAGE`) or when a job for the incident is already queued/processing. |
| Permissions | `queue/`, `queue/{triage,fix,push,lab,processing,done,failed,control}`, `results/` are **Neo core uid : Neo core gid, 2770** (setgid), created for every host by the ops module (tmpfiles + docker-ops preStart + worker ExecStartPre, all `install -d`). The container runs as core uid:gid; with autofix on, `hermes` is added to the core group. Setgid keeps every job/result file in the core group; the worker runs with `UMask=0007`. Chosen over ACLs (ZFS datasets may have `acltype=off`) and over a new group (the container has no supplementary groups and fakeNss cannot resolve names). |
| Claim | Worker (lock in `RuntimeDirectory=/run/heimcloud-ops-worker`, stale-pid reclaim) renames `queue/<kind>/X.json` → `queue/processing/<kind>-X.json`, then → `queue/done/` or `queue/failed/`. Jobs left in `processing/` by a killed run are requeued once (claim 1) and quarantined to `failed/` with a result on the second crash (no re-run loop). Disabled kinds are never touched. |
| Results | Worker writes `$appdata/ops/results/<kind>-X.json`; the app ingests in a background loop (every `OPS_RESULTS_POLL_MS`, default 15 s, plus best-effort `fs.watch`) and on admin page loads / ingest — each file is claimed by rename to `.ingested.json` *before* it is applied, so no path double-applies → `triage_result` / `fix_result` events + `fix_attempts` (only Hermes fix attempts get a row: `no_token`, `ready_no_token`, `push_failed` and push-only results (`via: "push-pending"`) are events only), renames to `.ingested.json` (bad files → `.rejected.json`). Status map: `awaiting_lab_test` / `lab_queued` / `lab_error`→`testing`, `lab_retry`→`fixing`, `compare_ready`→`pr_opened`, `no_token` / `ready_no_token` / `push_failed`→`triaged`, anything else (redaction_blocked, denied, needs_human, lab failure, errors)→`needs_human`. Triage only promotes `open`→`triaged`. Lab results (`via: "lab"`) update the latest `fix_attempts` row (`lab_passed`/`lab_failed`/`lab_error`/`lab_cancelled` + `lab_report` in meta) instead of adding one, and never move a resolved/closed incident. |
| Units | `heimcloud-ops-worker.path` (`PathChanged` on each enabled kind dir; `PathExistsGlob` was level-triggered and re-fired while a job stayed pending, which hit the start limit and failed the path unit) + oneshot `heimcloud-ops-worker.service` (User=hermes, `wants`/`after` `heimcloud-autofix-materialize-token.service`, PATH = hermes-agent unit PATH + git/gh/node/sqlite + `/run/current-system/sw`). Only when `autofix.enable` and triage/fix enable. With `autofix.lab.enable`: the path unit also watches `queue/lab`, the worker gets `restartIfChanged = stopIfChanged = false` (a switch must not kill a running job) and a longer `TimeoutStartSec`, plus the root template `heimcloud-ops-labtest@.service` and the polkit rule (see "Lab test"). |
| Control dir | `queue/control/` (same 2770 perms): `priority.json` (`{version, jobs: {"kind/name": {priority, rank}}}`, written atomically by the app via tmp `wx` + rename), `paused.json`, `cancel-<processing name>`. `scripts/autofix/queue-control.js` is byte-identical to `app/lib/queue-control.js` (test-enforced). |
| Claim order | The worker re-lists pending jobs and re-reads `priority.json` before every claim: priority (high/normal/low) → manual rank → kind (push › lab › triage › fix) → enqueue time from the name. |
| Pause | Checked between jobs only; a running job is never killed. Resume touches a `.kick-*` file in each kind dir with pending jobs so `PathChanged` fires. |
| Cancel | Pending: the app renames to `failed/` with a reason sidecar. Running: cancel flag, checked by the worker between stages and by the supervisor every 2 s during clone/Hermes/lab (push is never interrupted). Result `triage_cancelled` / `cancelled` (→ `triaged`) / push `push_failed` (`push_error: cancelled`); a cancel during lab keeps the pushed branch (`awaiting_lab_test`). A running **lab** job: the cancel flag is passed to the root runner, which honours it only before activation (validating / waiting for the lock / building); once it is arming or activating the test finishes and rolls back as usual. |
| Supervisor | Hermes, clone, push and lab run under `worker.mjs --supervise`, which spawns the command in its own process group, heartbeats `worker-status.json`, and on timeout/cancel sends SIGTERM to the whole group, then SIGKILL after `OPS_AUTOFIX_KILL_GRACE_SEC` (10 s). Stragglers in the group are killed when the leader exits. |
| Worker status | `queue/worker-status.json` v2 (atomic): state idle/running/paused, pid, current job (kind, incident, priority, claims, stage, attempt), last run, token check (v1 fields kept), timeouts, `heartbeat_at`, and the last 20 redacted issues. |
| Lockout hardening | `--once` exits 0 even on per-job errors. The service has `StartLimitIntervalSec=120` / `StartLimitBurst=30`. Poison jobs: `_claims` is counted in the processing copy; a crashed job is requeued once and quarantined to `failed/` ("crashed worker") at 2 claims. Malformed JSON → `failed/` + result. An unwritable result (ENOSPC/EROFS/EACCES) → job `failed/` (reason `results_unwritable`), with no crash loop. A queue I/O error stops the drain instead of spinning. Stale lock → reclaimed + issue. |
| Kick timer | `heimcloud-ops-worker-kick.timer` (root, every 2 min) runs `heimcloud-ops-worker --kick`. It runs `systemctl reset-failed` on worker path/service when failed or start-limit-hit and jobs are pending, starts the path unit if inactive, and `start --no-block`s the service when jobs are pending and the queue isn't paused (this also covers an enqueue that lands while the path unit is unwatched during a run). It writes `queue/systemd-status.json` for the admin panel. |
| Skills | `skills/heimcloud-ops-triage`, `skills/heimcloud-ops-fix`, `skills/heimcloud-ops-labtest` (check plan) materialized into `HERMES_HOME/skills` when autofix enable. |
| Triage verdict | The triage skill also returns `verdict` (`code_fix` / `config_error` / `not_actionable` / `uncertain`) and `confidence` (0–1). The worker validates both (`triageVerdictFields`) and passes them into the `triage_result` payload. The admin board flags `uncertain` or confidence < 0.6 as "Triage unsure" (Start fix / Mark config error & close). Older results without these fields are mapped from `class` + `fixable`. |
| Admin board | Kanban on `/admin`: manual status moves go through a transition table (never into `fixing`/`testing`), with an `admin_update` event per move. "Needs my input" badges are derived from the latest `triage_result` / `fix_result` payloads (see README "Admin board"). Live updates via SSE `/admin/events` (`X-Accel-Buffering: no`, 15 s heartbeat) with 5 s ETag polling fallback; worker panel + `/admin/queue` controls (README "Live updates, worker panel, queue"). |
| Credentials | `neo.services.credentials.ops.autofixForkPushToken` → `/run/heimcloud-autofix/github-token`. Worker: `heimcloud-autofix-env --check` then wrap git/gh. |
| Fix run | Fresh partial clone (`--filter=blob:none`) of `autofix.neoBaseRef` (upstream first, fork second); Hermes runs **without** the push token, with git identity pinned to `heimcloud <heimcloud@users.noreply.github.com>`; the worker requires ≥1 commit, checks author/committer identity, deny-list by path prefix, then the redaction gate, then `heimcloud-autofix-env git push --force fork HEAD:refs/heads/<branch>` (fork `fix/*`/`ops/*` namespace is owned by this loop). Lab test: with `autofix.lab.enable` a lab job (see "Lab test"); otherwise `heimcloud-lab-test <branch> <class>` if on PATH; pass → `compare_ready`; fail → Hermes retry with redacted evidence up to `maxAttempts`, then `needs_human` without a compare link; absent → `awaiting_lab_test` (manual test). |
| No token | The fork-push token is checked only right before push. Without it the fix job still runs Hermes, requires a commit, runs identity/deny-list/redaction gates, saves `fix.patch` + `push-pending.json` in the job scratch dir (`$HERMES_STATE/workspace/autofix/<job>/`, clone kept), skips push and lab test (the lab pulls the pushed fork branch), and ends `ready_no_token` → incident `triaged` with an event naming the local branch. Later: `systemctl start heimcloud-ops-worker-push@<job>.service` re-gates and pushes without a second Hermes run (replays the patch if the clone is gone), then lab-tests. The worker records the last runtime token check in `queue/worker-status.json`; the admin warns (does not block) on Start fix when it is false, falling back to `OPS_AUTOFIX_TOKEN_CONFIGURED` from Nix. |
| Push failure | Any `git push` error after a successful Hermes run (auth, network, rejected) is **not** a Hermes failure: no Hermes retry, the per-job attempt budget (`maxAttempts`, Hermes lab retries only) is untouched. The worker saves `fix.patch` + `push-pending.json` exactly like `ready_no_token`, keeps the clone and returns `push_failed` with `push_error` = `auth`/`network`/`rejected`/`unknown` and a one-line message naming the retry (admin **Retry push** or `heimcloud-ops-worker-push@<job>.service`). Raw git output only goes to the journal with URL userinfo stripped; never to results/DB. Incident → `triaged`. |
| Retry push | Admin shows **Retry push** on `needs_human`/`triaged` incidents whose latest `fix_result` is `ready_no_token`/`push_failed` (or the legacy `needs_human` "git push to fork failed" whose `evidence_path` is under `/autofix/<job>/`). It writes `queue/push/<id>-<ts>.json` `{kind:"push", incident_id, job}` (job name taken from the DB, `fix-<id>-…`, must match the incident); the path unit watches `queue/push` when fix is enabled and the worker runs the same code as `--push-pending` (per-job lock in the scratch dir). Event `push_enqueued`. |
| Recovery | `--push-pending` / push jobs also work on a scratch clone **without** `push-pending.json` (jobs from before `push_failed`): branch = current branch of the clone (must be `fix/*`/`ops/*`), base = recorded `base_sha` from `results/<job>(.ingested).json`, else merge-base with `origin/<neoBaseRef>`; incident/class/severity from `queue/done|failed/<job>.json` or the name. The fork remote is re-added and identity, deny-list and redaction gates run again before push; then lab test + compare link as usual. Find `<job>`: `ls $HERMES_STATE/workspace/autofix/ \| grep "^fix-<id>-"`, or `job`/`evidence_path` in the incident's latest `fix_result` event, or `queue/done/fix-<id>-*.json`. |
| Toolchain | `autofix.extraPackages` (internal; default cargo, rustc, clippy, rustfmt, stdenv.cc, pkg-config, openssl(+dev), gnumake: what the neo `cli/` crane build uses, no rust-toolchain file) is on the worker/push@ PATH and in `users.users.hermes.packages` (Hermes's terminal tool rebuilds PATH from the NixOS profiles). Worker env sets `CARGO_TARGET_DIR` outside the clone plus `PKG_CONFIG_PATH`/`OPENSSL_*` for openssl-sys. The fix skill runs `cargo check`/`cargo test` for `cli/` changes and `nix-instantiate --parse` for nix changes when available; an unavailable check (no network for crates) is a note, not a failure. |
| Upstream PR | The worker pushes the `heimcloud/neo` branch and posts compare URL `https://github.com/madebydamo/neo/compare/<neoBaseRef>...heimcloud:neo:<branch>?expand=1` plus the prepared title/body in admin. Damo opens the upstream PR in the GitHub web UI. The worker's optional `GH_PR_TOKEN` → `gh pr create --draft` branch remains dormant and unused this phase; no `/run/heimcloud-autofix/pr-token` is provisioned. |
| Redaction | Fail-closed scan of branch, commit message, diff, PR title/body. `OPS_REDACT_EXTRA_SLUGS` via `neo.services.ops.redactExtraSlugsFile` (docker-ops `environmentFiles`) and the same path for the autofix worker (`autofix.redactExtraSlugsFile` defaults to it). |
| Deny-list | While `labSharesOpsHost` (default true): refuse diffs under `nix/services/{ops,hermes,swag}`, `nix/modules/core` (see "Deny-path policy"). |
| Lab stage | `lab-checks.js` (schema) is byte-identical in `app/lib` and `scripts/autofix` (test-enforced). Worker env: `OPS_AUTOFIX_LAB=1`, `OPS_AUTOFIX_LAB_STATE_DIR`, `OPS_AUTOFIX_LAB_WAIT_SEC`, `OPS_AUTOFIX_LAB_PLAN_TIMEOUT_SEC`, `OPS_SYSTEMCTL_BIN`. Container env `OPS_AUTOFIX_LAB` (board: no "Lab test needed" badge while an automated lab job is queued/running). Runner env `LABTEST_*` from the `autofix.lab` options. |

### Enable (Fleet)

```toml
# Persistent AppData EnvironmentFile (0600). Feeds docker-ops always (outbound
# redaction) and the autofix worker when enabled. Fleet must create the file.
[services.ops]
redactExtraSlugsFile = "/var/neo/DATA/AppData/ops/redact-extra.env"  # OPS_REDACT_EXTRA_SLUGS=…

[services.ops.autofix]
enable = true
neoBaseRef = "master"  # the neo branch the host pins (github:madebydamo/neo/<ref>)
maxAttempts = 2
labSharesOpsHost = true
# redactExtraSlugsFile defaults to services.ops.redactExtraSlugsFile

[services.ops.autofix.triage]
enable = true
autoEnqueue = false   # set true only when ready for OPS_AUTOTRIAGE=1

[services.ops.autofix.fix]
enable = true

[services.ops.autofix.lab]
enable = true                      # automated lab stage (root runner + polkit rule)
# flake = "/var/neo/DATA/AppData/configuration"   # the host config flake (neo-cli.configPath)
# nixosConfiguration = "neo"
# input = "neo"
# flakeUrl = "github:heimcloud/neo/{branch}"

[services.credentials.ops]
autofixForkPushToken = "…"  # fine-grained, heimcloud/neo contents:write only
```

Also ensure Hermes is enabled on the ops host. Deploy = activate ops + credentials tips on the ops host.
Ensure `/var/neo/DATA/AppData/ops/redact-extra.env` exists (0600, `OPS_REDACT_EXTRA_SLUGS=…`); docker `--env-file` fails if missing.

## Open decisions (Damo)

1. **GitHub App and token scope** — GitHub App setup and automatic upstream PR creation are out of scope/deferred for this phase. The final phase flow uses the Credentials-provided fine-grained `heimcloud/neo` fork-push token; the broad `OPS_GITHUB_TOKEN` in the ops container remains as-is, with revocation an open item rather than a planned step.
2. **xAI quota / credential** dedicated to the pipeline (spending limit → 403 on 20 Sep); backoff + `triage_failed` when unavailable.
3. **Revive the dedicated lab box** (unblocks deny-listed subsystems; see the proposal under "Deny-path policy").
5. **Hermes's general sudo** (neo's Hermes module: wheel + passwordless sudo for all commands) makes the narrow lab entry point defence in depth only. Removing it is a Fleet/neo decision.
4. **Runtime secrets in the Nix store / Hermes unit env** — low priority for this phase; native processes on the machine and container isolation are trusted. Fleet/Credentials may remediate later.
