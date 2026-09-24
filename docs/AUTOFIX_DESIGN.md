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
  J --> L["heimcloud-lab-test branch checks<br/>record generation; activate tip"]
  L --> M{Auto checks}
  M -->|pass| N[Compare link + anonymized evidence<br/>Damo opens upstream PR / merge]
  M -->|fail| O[Rollback to previous NixOS generation]
  O --> P{Attempts &lt; N=2?}
  P -->|yes| H
  P -->|no| Q[needs_human + Telegram<br/>NO PR]
```

## Hard rules

| Rule | Detail |
|------|--------|
| Local AI only | Triage, summaries, and coding run on **local Hermes** on the ops host (`hermes-agent.service`, `hermes gateway`, provider xai-oauth / `grok-build-latest`). No external/cloud coding agents. |
| Non-interactive call | As user `hermes`: `hermes --yolo chat -Q --source tool --max-turns 40 -s <skill> --query-file <prompt_file>` (same pattern as supervise). Auth in `$HERMES_HOME/auth.json` (`HERMES_HOME=/var/neo/DATA/AppData/hermes/.hermes`). Port 18789 is configured but not listening — do not depend on it. |
| GitHub from ops host only | No GitHub App is used in this phase. Credentials provide a fine-grained fork-push token at `/run/heimcloud-autofix/github-token`; `heimcloud-autofix-env <cmd>` sets the scoped Git helper for the child process, and `--check` non-zero means triage-only. Hermes pushes the fix branch to `heimcloud/neo`; the runner posts the compare link and prepared body in Ops, and Damo opens the upstream PR in the GitHub web UI. Never on lab machines; nix/flake fetches stay unauthenticated. |
| Lab pull | Public fork **branch tip** (e.g. `github:heimcloud/neo/fix/…`), never a SHA; **no** GitHub auth on lab boxes. |
| Redaction | Before any GitHub write: branch name, commit message, diff, PR title/body, evidence. `app/lib/redact.js` + DB `DISTINCT customer_repo_slug` + `OPS_REDACT_EXTRA_SLUGS`. **Fail closed** on hit; `app/test` enforces payload anonymity. |
| Branch names | `fix/<short-topic>` or `ops/incident-<n>` — no customer info. |
| No auto-merge | The runner does not open or merge a PR; Damo opens the upstream PR from the compare link and merges it. |

## Ops ↔ Hermes bridge (no container network change)

Ops runs `NetworkMode=internal` and cannot reach Hermes. Use the host filesystem:

1. Ops writes job JSON under `/var/neo/DATA/AppData/ops/queue/{triage,fix}/`.
2. A systemd **`.path`** unit starts oneshot `heimcloud-ops-worker@…` **as `hermes`**.
3. Worker invokes Hermes with skill `heimcloud-ops-triage` or `heimcloud-ops-fix`, writes results under a results dir.
4. Ops ingests results as `incident_events` (and status updates).

## Shared host: hattori today

Fleet audit (24 Sep): **hattori is both the ops host** (docker-ops, Hermes, Gitea, shop) **and the only lab box**. thatch is paused.

Until a second lab box exists:

- **Deny-list** auto-fixes that touch **ops, hermes, swag, or the hattori base system**.
- Before each lab test: **record current Neo generation**; on check failure **roll back automatically** (ops `/health`, Hermes unit, service under test).
- **Recommend:** revive **thatch** as the dedicated lab box. Customer machines are never test targets.

## Lab test

Host-side script owned by Fleet: `heimcloud-lab-test <branch> <checks>` — timeout, switch neo input override to fork branch tip + activate (or Fleet lab-deploy helper), run class-specific checks, then on failure switch back to the recorded previous NixOS generation (no re-eval).

**Rollback is never "switch the neo input back to `master`".** The lab host may run a neo branch that is ahead of `master` (e.g. Gitea service, Hermes skill materialize), so a `master` rollback can remove live services. Fix branches must be based on the neo ref the lab host currently runs, and rollback uses the previous-generation switch that restores the exact prior system. On pass, the fix branch may stay deployed until it merges if it is a superset of the running ref.

Example checks for Ops incident #10 (SearXNG): no `can't register engine` lines; no limiter / proxy-header warning; healthz 200; search returns results.

**On failure:** rollback → attach evidence to the incident → Hermes retry with failure context up to **N=2** → then stop, status **`needs_human`** (or leave triaged), **no PR**, notify Damo on existing Telegram.

## Schema / control plane

- New statuses: e.g. `fixing`, `testing`, `needs_human` (plus existing `open` / `triaged` / `pr_opened` / …). Treat model outages as `triage_failed` or leave `open` with backoff.
- Table `fix_attempts` (incident_id, attempt, branch, result, evidence_path, created_at).
- Idempotency: ingest remains unique on `report_hash`; workers must not double-start the same incident.
- Rate limit: **max concurrent fixes = 1** while ops and lab share a host.
- Audit: every step → `incident_events`.

## Phases

1. **Triage only** — queue + Hermes skill → class/summary events (no code push).
2. **Fix + lab-test stub (implemented, default OFF)** — see runner contract below. Hermes codes on a fork branch; worker pushes via `heimcloud-autofix-env`; the runner posts a compare link; `heimcloud-lab-test` if on PATH (Fleet owns it).
3. **Full loop** — automatic lab test, evidence, fork push, and compare link; Damo opens the upstream PR in the GitHub web UI.

**Ops incident #10** is the first **manually driven** example of the full loop (branch `fix/searxng-engines-limiter` on `heimcloud/neo`).

## Runner contract (ops plugin, opt-in)

**Default OFF.** `neo.services.ops.autofix.enable = false` installs nothing that calls Hermes.

| Piece | Detail |
|-------|--------|
| Queue | Container writes `/data/queue/{triage,fix}/<id>-<ts>.json` (host: `$appdata/ops/…`). Payload: incident id, report_hash, unit, severity, class, neo_version, redacted logs only. |
| Results | Worker writes `$appdata/ops/results/*.json`; admin/ingest applies `triage_result` / `fix_result` + `fix_attempts`. |
| Units | `heimcloud-ops-worker.path` + oneshot `heimcloud-ops-worker.service` (User=hermes, concurrency 1 via lock). Only when `autofix.enable` and triage/fix enable. |
| Skills | `skills/heimcloud-ops-triage`, `skills/heimcloud-ops-fix` materialized into `HERMES_HOME/skills` when autofix enable. |
| Credentials | `neo.services.credentials.ops.autofixForkPushToken` → `/run/heimcloud-autofix/github-token`. Worker: `heimcloud-autofix-env --check` then wrap git/gh. |
| Upstream PR | The worker pushes the `heimcloud/neo` branch and posts compare URL `https://github.com/madebydamo/neo/compare/master...heimcloud:neo:<branch>?expand=1` plus the prepared title/body in admin. Damo opens the upstream PR in the GitHub web UI. The worker's optional `GH_PR_TOKEN` → `gh pr create --draft` branch remains dormant and unused this phase; no `/run/heimcloud-autofix/pr-token` is provisioned. |
| Redaction | Fail-closed scan of branch, commit message, diff, PR title/body. `OPS_REDACT_EXTRA_SLUGS` via `neo.services.ops.redactExtraSlugsFile` (docker-ops `environmentFiles`) and the same path for the autofix worker (`autofix.redactExtraSlugsFile` defaults to it). |
| Deny-list | While `labSharesOpsHost` (default true): refuse diffs under `nix/services/{ops,hermes,swag}`, `nix/modules/core`. |

### Enable (Fleet)

```toml
# Persistent AppData EnvironmentFile (0600). Feeds docker-ops always (outbound
# redaction) and the autofix worker when enabled. Fleet must create the file.
[services.ops]
redactExtraSlugsFile = "/var/neo/DATA/AppData/ops/redact-extra.env"  # OPS_REDACT_EXTRA_SLUGS=…

[services.ops.autofix]
enable = true
maxAttempts = 2
labSharesOpsHost = true
# redactExtraSlugsFile defaults to services.ops.redactExtraSlugsFile

[services.ops.autofix.triage]
enable = true
autoEnqueue = false   # set true only when ready for OPS_AUTOTRIAGE=1

[services.ops.autofix.fix]
enable = true

[services.credentials.ops]
autofixForkPushToken = "…"  # fine-grained, heimcloud/neo contents:write only
```

Also ensure Hermes is enabled on the ops host. Deploy = activate ops + credentials tips on hattori.
Ensure `/var/neo/DATA/AppData/ops/redact-extra.env` exists (0600, `OPS_REDACT_EXTRA_SLUGS=…`); docker `--env-file` fails if missing.

## Open decisions (Damo)

1. **GitHub App and token scope** — GitHub App setup and automatic upstream PR creation are out of scope/deferred for this phase. The final phase flow uses the Credentials-provided fine-grained `heimcloud/neo` fork-push token; the broad `OPS_GITHUB_TOKEN` in the ops container remains as-is, with revocation an open item rather than a planned step.
2. **xAI quota / credential** dedicated to the pipeline (spending limit → 403 on 20 Sep); backoff + `triage_failed` when unavailable.
3. **Revive thatch** as dedicated lab box (unblocks deny-listed subsystems).
4. **Runtime secrets in the Nix store / Hermes unit env** — low priority for this phase; native processes on the machine and container isolation are trusted. Fleet/Credentials may remediate later.
