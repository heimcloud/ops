# Heimcloud Ops (Neo plugin)

Phase 1 incident desk for Heimcloud: secret-gated ingest, SQLite WAL, Tinyauth-gated admin, and a **Start fix** intent flow (fix PRs come from tested branches; no incident docs committed to target repos). No Hermes client plugin in this repo, no auto-merge. Deploy = Fleet activates `main` tip. Auto-fix loop design: [`docs/AUTOFIX_DESIGN.md`](docs/AUTOFIX_DESIGN.md).

Repo: <https://github.com/heimcloud/ops>

## Features

1. **`POST /api/incidents`** — protected by `OPS_INGEST_SECRET` (`Authorization: Bearer …` or `X-Ops-Secret`). Idempotent on `report_hash`.
2. **SQLite WAL** (`PRAGMA journal_mode=WAL`) at `OPS_DB_PATH` (default `/data/ops.sqlite`).
3. **Admin UI** at `/admin` — kanban board of incidents (drag and drop status, "needs my input" badges, detail drawer, filters); **Start triage / Start fix / Retry push / Retry lab / Approve lab test / Skip lab** act on host jobs (fix PRs come from the tested-branch loop; see design doc).

## Schema

### `incidents`

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK |
| `report_hash` | TEXT UNIQUE — idempotent ingest key |
| `neo_version`, `plugin_urls`, `unit`, `logs_excerpt` | TEXT |
| `customer_repo_slug`, `severity`, `target_hint`, `target_repo` | TEXT |
| `status` | `open` \| `triaged` \| `fixing` \| `testing` \| `needs_human` \| `pr_opened` \| `resolved` \| `closed` |
| `class` | `software` \| `human_config` \| `unknown` |
| `draft_pr_url`, `draft_pr_number`, `draft_branch` | tested branch / PR preparation metadata |
| `created_at`, `updated_at` | ISO text |

### `incident_events`

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK |
| `incident_id` | FK → incidents |
| `kind`, `message`, `meta_json` | audit trail |
| `created_at` | ISO text |

## Example ingest

```bash
curl -sS -X POST "http://localhost:3000/api/incidents" \
  -H "Content-Type: application/json" \
  -H "X-Ops-Secret: $OPS_INGEST_SECRET" \
  -d '{
    "report_hash": "abc123deadbeef",
    "neo_version": "0.9.0",
    "plugin_urls": ["github:heimcloud/shop"],
    "unit": "docker-shop.service",
    "logs_excerpt": "Error: connection refused",
    "customer_repo_slug": "cust-EXAMPLE01",
    "severity": "high",
    "target_hint": "madebydamo/neo"
  }'
```

Bearer also works: `-H "Authorization: Bearer $OPS_INGEST_SECRET"`.

## Admin board

`/admin` is a server-rendered kanban board, progressively enhanced by `app/public/js/board.js` (vanilla JS, no framework, no CDN/fonts; CSS in `app/public/css/board.css`, light + dark via `prefers-color-scheme`). Without JS every card still has working forms.

**Columns** (= lifecycle status): Open · Triaged · Fixing · Testing · Needs human · Awaiting PR (`pr_opened`) · Done (`resolved` + `closed`, tagged on the card). Column headers carry the per-status counts that used to be tiles, plus how many cards in the column need input. Fixing/Testing are marked worker-owned.

**Moving cards**: drag and drop (native HTML5) or the **Move to…** select on each card/drawer (keyboard + touch). Moves are optimistic and roll back on error. They go through the existing update path `POST /admin/incidents/:id` (form, or JSON with `Content-Type: application/json`), which checks the transition table below (409 + message otherwise), refuses stale moves (`expect_from`), and always writes an `admin_update` event `status X -> Y` with `meta.from` / `meta.to`. All admin POSTs require same-origin (`Sec-Fetch-Site`, or `Origin` = Host when that header is missing). `ADMIN_READ_ONLY` removes drag handles, menus and buttons, and the server answers 403.

| From | Allowed manual targets |
|------|------------------------|
| open | triaged, needs_human, resolved, closed |
| triaged | open, needs_human, resolved, closed |
| fixing | needs_human (unstick a dead job) |
| testing | pr_opened (manual lab test passed), needs_human, triaged, resolved, closed |
| needs_human | triaged, resolved, closed |
| pr_opened | triaged, needs_human, resolved, closed |
| resolved | open, triaged, closed |
| closed | open, triaged, resolved |

Nothing can be moved *into* `fixing` / `testing` by hand: **Start fix** and the worker results set those.

**Needs my input** (`needsHumanInput()` in `app/lib/board.js`, pure + unit-tested) uses only the incident row, its latest `triage_result` / `fix_result` payloads, `*_enqueued` events and `fix_attempts`. Nothing is flagged while a triage/fix/push job queued after the last result is still pending.

| Status | Condition | Badge → action |
|--------|-----------|----------------|
| open | no triage result / `triage_failed` | Not triaged yet / Triage failed → Start triage |
| open, triaged | triage `verdict` `uncertain`, or `confidence` < 0.6 | Triage unsure → Start fix / Mark config error & close |
| open, triaged | verdict `config_error` / `not_actionable` / `code_fix` | Mark config error & close / Close / Start fix |
| triaged | latest fix result `ready_no_token` / `push_failed` | Push pending / Push failed → Retry push |
| testing | no `passed`/`failed` lab result (lab skipped, or automated lab off) — **no badge** while an automated lab job is queued/running (`OPS_AUTOFIX_LAB`) | Lab test needed → Open compare link |
| testing | automated lab `lab_error` / lab job cancelled | Lab test error / Lab test cancelled → Retry lab |
| needs_human | lab rollback not verified | Lab rollback NOT verified: check the host |
| needs_human | latest fix result `lab_approval_needed` (protected path: ops / hermes / swag / base system while the lab shares the ops host); stays until acted on | Protected path (hermes): approve lab test → **Approve lab test** (base system: "Approve lab test (base system!)", stronger confirm) / **Skip lab, open compare link** / Close |
| needs_human | protected lab run: ops / Hermes still down after rollback + restart | Ops/Hermes still down after the lab rollback: check the host |
| needs_human | `lab: failed` / `redaction_blocked` / `denied` (legacy) / Hermes gave up after retries / other | reason + worker summary → Start fix / Close |
| testing | `lab_approved` event after the last result (approved protected lab job queued/running) | **no badge** |
| pr_opened | `compare_url` set, lab skipped by the admin (`lab_skipped` after the last fix result) | Open the PR from the compare link (NOT lab-tested) → Open compare link / Mark resolved; card chip "NOT lab-tested" |
| pr_opened | `compare_url` set | Open the PR from the compare link → Open compare link / Mark resolved |

Old triage results without `verdict` are mapped from `class` + `fixable` (human_config → config_error, software+fixable → code_fix, software+!fixable → not_actionable, unknown → uncertain).

**Filters**: column visibility, severity, class, unit, target repo, *Needs my input*, and free-text search (over redacted fields only). State lives in the URL query (wins) and `localStorage`. **Drawer**: click a card (`#incident-13` is linkable) for the redacted summary, events timeline (newest first, Europe/Zurich), fix attempts, lab result, compare link, draft branch and actions. The older per-incident page (`/admin/incidents/:id`, raw staff view with class/target edit) is still linked from the drawer.

**Anonymization**: every displayed text field on the board, drawer and `board.json` goes through `app/lib/redact.js` with the DB slugs + `OPS_REDACT_EXTRA_SLUGS`, plus a display-only username rule. Unit suffixes like `.service` stay readable. `customer_repo_slug` and `plugin_urls` are never rendered there. Links are only shown for `https://github.com/…` URLs that come through redaction unchanged. `app/test/board-admin.test.js` seeds synthetic identifiers and asserts that none of them reach the HTML or the JSON.

### Live updates, worker panel, queue

**Live updates** (`app/lib/live.js`, `app/public/js/live.js`). The server computes a revision from DB watermarks (max event / fix-attempt / `updated_at` / count) plus an fs signature of the queue dirs, `queue/control/*`, `queue/worker-status.json` and `queue/systemd-status.json`.
- `GET /admin/events` (SSE) sends `retry: 3000`, then a `hello` (or a catch-up `change` when `Last-Event-ID` is stale).
- It sends `event: change` with the changed incident ids and `worker: true|false` whenever the revision moves (checked every `OPS_LIVE_TICK_MS`, default 1.5 s, one shared ticker).
- It also sends a `: hb` comment plus `event: ping` every `OPS_LIVE_HEARTBEAT_MS` (15 s).
- Headers: `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, so nginx/SWAG do not buffer the stream. The 15 s heartbeat stays well below SWAG's `proxy_read_timeout` (240 s).
- The client falls back to polling `GET /admin/live.json` every 5 s (15 s in a hidden tab) with `If-None-Match` (304 when unchanged) when EventSource is missing, errors 4×, or goes silent. It retries SSE every 2 min.
- On a change it fetches `/admin/cards?ids=…` and `/admin/worker.json` and patches the page. It never replaces a card being dragged or with a pending move/focused control (those are flushed after `dragend`/blur). An open drawer is refreshed in place, keeping its scroll position, open `<details>` and `<pre>` scroll.
- The header shows **Live** / **Reconnecting** / **Polling**.

**Worker panel** (board strip + `/admin/queue`) reads `queue/worker-status.json` (written atomically by the host worker at every stage transition and every `OPS_AUTOFIX_HEARTBEAT_SEC`, default 30 s, while Hermes runs). It shows:
- the state: Running / Idle / Paused / **Stale** (running but heartbeat older than `OPS_WORKER_STALE_SEC`, default 300 s) / Not reporting;
- the current job: kind, incident, stage `cloning`/`hermes n/m`/`checks`/`push`/`lab`, started + elapsed, claims, cancel requested;
- the last run result + time, fork-push token (bool), Hermes/lab timeouts;
- systemd health from `queue/systemd-status.json`, written by the root `heimcloud-ops-worker-kick` timer: the path unit is watching, service state, start-limit-hit / failed, stale report, last watchdog action;
- recent worker issues (poison quarantine, requeue after crash, stale lock, Hermes timeout, unwritable results, malformed job, cancelled).

**Queue** (`/admin/queue`, `/admin/queue.json`). Pending jobs are shown in claim order: priority (high/normal/low) → manual order → kind (push › triage › fix) → enqueue time. Processing, recent failed (with reason) and recent done (with result) are listed too. Controls (JSON or form POSTs, same-origin, 403 under `ADMIN_READ_ONLY`):

| Action | Effect | Event |
|--------|--------|-------|
| Priority select / ⤒ ↑ ↓ | writes `queue/control/priority.json` atomically; the worker re-reads it before every claim | `job_priority` / `job_reordered` |
| Cancel (pending) | renames the job to `queue/failed/` + `*.reason.json`; a pending fix returns the incident `fixing → triaged` | `job_cancelled` |
| Cancel running job | writes `queue/control/cancel-<job>`; the worker checks it between stages and its supervisor polls it during clone/Hermes/lab, then SIGTERM → SIGKILL to the child's process group; incident gets a `cancelled` / `triage_cancelled` result (fix → `triaged`) | `job_cancel_requested`, then the result |
| Retry (failed) | re-enqueues a fresh job of the same kind (refused for resolved/closed incidents); the failed file is marked retried | `{kind}_enqueued` "retry of failed job …" |
| Pause / Resume | `queue/control/paused.json`; the worker checks it between jobs and never kills a running job | — |

## Admin Start fix

**Start fix** (board card, drawer, or incident page) enqueues a host fix job (status → `fixing`) and does **not** open a GitHub PR or commit into the target repo. Coded fixes come from the lab-tested loop described in [`docs/AUTOFIX_DESIGN.md`](docs/AUTOFIX_DESIGN.md) (local Hermes → fork branch → lab test → compare link); Damo opens the upstream PR in the GitHub web UI. **No auto-merge.**

Outbound GitHub text is built only from incident #, `report_hash`, unit, severity, class, `neo_version`, and a redacted logs excerpt (`app/lib/redact.js`, plus `OPS_REDACT_EXTRA_SLUGS`).

## Run locally

```bash
cd app
cp ../.env.example .env   # set OPS_INGEST_SECRET; optional GITHUB_TOKEN
npm install
OPS_DB_PATH=./data/ops.sqlite OPS_INGEST_SECRET=devsecret npm start
# Admin: http://localhost:3000/admin
# Health: http://localhost:3000/health
```

Env placeholders (never commit secrets):

- `OPS_INGEST_SECRET` — ingest shared secret
- `OPS_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` — container GitHub API credentials, kept as-is; the autofix runner uses the separate Credentials fork-push token
- `OPS_DB_PATH` — SQLite path (WAL)
- `OPS_TARGET_ALLOWLIST` — default `madebydamo/neo,heimcloud/*`

## As a Neo plugin

Same dendritic flake pattern as [heimcloud/shop](https://github.com/heimcloud/shop):

```nix
# In a Neo homeserver flake inputs / plugin list:
ops.url = "github:heimcloud/ops";
# Enable:
neo.services.ops = {
  enabled = true;
  ingestSecret = "...";       # from secrets
  githubToken = "...";        # from secrets
  # subdomain default: ops  →  ops.<domain>
  admin.auth = true;          # Tinyauth on /admin when tinyauth enabled
};
```

Build OCI image: `nix build .#heimcloud-ops` / `.#default`; NixOS `imageFile` = `self.packages.<system>.heimcloud-ops` (or `.#default`).

### Deploy

Production: **hattori** / **ops.heimcloud.site** via **Fleet**. Heimcloud org policy: **`main` tip is production** — no separate staging / ready-for-prod gate. Fleet activates tip; Ops does not own an extra promote step.

Client reporting (not this repo): credentials tip `github:heimcloud/credentials` ships `neo-heimcloud-ops-report` oneshot + `ops/ingest.token`.

## Out of scope (phase 1)

- Hermes client plugin (reporting lives in credentials / Neo units)
- Automatic upstream PR creation / GitHub App
- Auto-merge

## Autofix runner (opt-in, default off)

Host-side loop: queue → local Hermes → fork branch → compare link. Design: [`docs/AUTOFIX_DESIGN.md`](docs/AUTOFIX_DESIGN.md).

Fleet enable (ops host):

1. Credentials: set `[services.credentials.ops] autofixForkPushToken` (fine-grained, `heimcloud/neo` contents:write). Materializes `/run/heimcloud-autofix/github-token`.
2. Ops settings:

```toml
[services.ops]
# Default; feeds docker-ops environmentFiles (outbound redaction) always.
redactExtraSlugsFile = "/var/neo/DATA/AppData/ops/redact-extra.env"

[services.ops.autofix]
enable = true
# redactExtraSlugsFile defaults to services.ops.redactExtraSlugsFile

[services.ops.autofix.triage]
enable = true
# autoEnqueue = true   # optional OPS_AUTOTRIAGE

[services.ops.autofix.fix]
enable = true
```

3. EnvironmentFile contents (0600) at that path: `OPS_REDACT_EXTRA_SLUGS=<burned-slug-list>`. Fleet must create it or docker `--env-file` fails.
4. Activate. Confirm no worker units when `autofix.enable = false`. Confirm docker-ops has `OPS_REDACT_EXTRA_SLUGS` set (do not print the value).
5. Admin **Start fix** enqueues a job; worker runs as `hermes`, pushes the fork branch, and posts a compare link. Damo opens the upstream PR from the incident page in the GitHub web UI.

### Automated lab stage (opt-in)

```toml
[services.ops.autofix.lab]
enable = true      # needs autofix.fix.enable
# flake = "/var/neo/DATA/AppData/configuration"   # host config flake (neo-cli.configPath)
# nixosConfiguration = "neo"                      # nixosConfigurations.<name>
# input = "neo"                                   # the input overridden with the fix branch
# flakeUrl = "github:heimcloud/neo/{branch}"      # public fork, unauthenticated
# lockWaitSec = 1800; buildTimeoutSec = 3600; activateTimeoutSec = 900; settleSec = 30; checkTimeoutSec = 60; planTimeoutSec = 600
```

After a fix branch is pushed the worker queues a **lab** job: Hermes (skill `heimcloud-ops-labtest`) plans whitelisted checks, and the worker starts the root unit `heimcloud-ops-labtest@lab-<id>-<ts>.service` (allowed for `hermes` by a polkit rule for exactly that unit pattern, verb start). The runner takes the lab lock and Neo's activation lock, builds the host flake with only `neo` overridden to the fork branch (`--no-write-lock-file`), arms an independent transient systemd rollback timer, activates with `switch-to-configuration test`, runs the generic + incident checks, **always** switches back to the recorded system, verifies the generation and byte-identical `flake.lock`/`flake.nix`/`settings.toml`, and disarms the timer. Pass → compare link (Awaiting PR); fail → Hermes retry with the redacted evidence (per `maxAttempts`), then needs_human. Details: [`docs/AUTOFIX_DESIGN.md#lab-test-automated-lab-stage`](docs/AUTOFIX_DESIGN.md#lab-test-automated-lab-stage).

Board: the Testing card shows live lab progress (`lab · Building`, `Activating`, `Checks 3/8`, `Rolling back`, `Restored`) without a human badge; results show as "Lab passed/failed ✓n ✗m" on the card and a per-check list (generation before/after, watchdog, pins, tested commit, redacted evidence) in the drawer. `/admin/queue` lists lab jobs (claim order push › lab › triage › fix); cancel of a running lab job is honoured only before activation.

