# Heimcloud Ops (Neo plugin)

Phase 1 incident desk for Heimcloud: secret-gated ingest, SQLite WAL, Tinyauth-gated admin, and a **Start fix** intent flow (fix PRs come from tested branches; no incident docs committed to target repos). No Hermes client plugin in this repo, no auto-merge. Deploy = Fleet activates `main` tip. Auto-fix loop design: [`docs/AUTOFIX_DESIGN.md`](docs/AUTOFIX_DESIGN.md).

Repo: <https://github.com/heimcloud/ops>

## Features

1. **`POST /api/incidents`** — protected by `OPS_INGEST_SECRET` (`Authorization: Bearer …` or `X-Ops-Secret`). Idempotent on `report_hash`.
2. **SQLite WAL** (`PRAGMA journal_mode=WAL`) at `OPS_DB_PATH` (default `/data/ops.sqlite`).
3. **Admin UI** at `/admin` — kanban board of incidents (drag and drop status, "needs my input" badges, detail drawer, filters); **Start triage / Start fix / Retry push** enqueue host jobs (fix PRs come from the tested-branch loop; see design doc).

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
| testing | no `passed`/`failed` lab result (lab skipped) | Lab test needed → Open compare link |
| needs_human | `lab: failed` / `redaction_blocked` / `denied` / Hermes gave up after retries / other | reason + worker summary → Start fix / Close |
| pr_opened | `compare_url` set | Open the PR from the compare link → Open compare link / Mark resolved |

Old triage results without `verdict` are mapped from `class` + `fixable` (human_config → config_error, software+fixable → code_fix, software+!fixable → not_actionable, unknown → uncertain).

**Filters**: column visibility, severity, class, unit, target repo, *Needs my input*, and free-text search (over redacted fields only). State lives in the URL query (wins) and `localStorage`. **Drawer**: click a card (`#incident-13` is linkable) for the redacted summary, events timeline (newest first, Europe/Zurich), fix attempts, lab result, compare link, draft branch and actions. The older per-incident page (`/admin/incidents/:id`, raw staff view with class/target edit) is still linked from the drawer.

**Anonymization**: every displayed text field on the board, drawer and `board.json` goes through `app/lib/redact.js` with the DB slugs + `OPS_REDACT_EXTRA_SLUGS`, plus a display-only username rule. Unit suffixes like `.service` stay readable. `customer_repo_slug` and `plugin_urls` are never rendered there. Links are only shown for `https://github.com/…` URLs that come through redaction unchanged. `app/test/board-admin.test.js` seeds synthetic identifiers and asserts that none of them reach the HTML or the JSON.

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

Fleet enable (hattori):

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

