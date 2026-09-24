# Heimcloud Ops (Neo plugin)

Phase 1 incident desk for Heimcloud: secret-gated ingest, SQLite WAL, Tinyauth-gated admin, and a **Start fix** intent flow (fix PRs come from tested branches; no incident docs committed to target repos). No Hermes client plugin in this repo, no auto-fix agent, no auto-merge. Deploy = Fleet activates `main` tip.

Repo: <https://github.com/heimcloud/ops>

## Features

1. **`POST /api/incidents`** — protected by `OPS_INGEST_SECRET` (`Authorization: Bearer …` or `X-Ops-Secret`). Idempotent on `report_hash`.
2. **SQLite WAL** (`PRAGMA journal_mode=WAL`) at `OPS_DB_PATH` (default `/data/ops.sqlite`).
3. **Admin UI** at `/admin` — list incidents, set class/status, **Create PR** opens a draft PR on an allowlisted target repo (`madebydamo/neo` + `heimcloud/*` by default). Branch: `heimcloud/incident-<id>`.

## Schema

### `incidents`

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK |
| `report_hash` | TEXT UNIQUE — idempotent ingest key |
| `neo_version`, `plugin_urls`, `unit`, `logs_excerpt` | TEXT |
| `customer_repo_slug`, `severity`, `target_hint`, `target_repo` | TEXT |
| `status` | `open` \| `triaged` \| `pr_opened` \| `resolved` \| `closed` |
| `class` | `software` \| `human_config` \| `unknown` |
| `draft_pr_url`, `draft_pr_number`, `draft_branch` | set by Create PR |
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

## Admin Create PR

On an incident detail page, **Create PR**:

1. Resolves target repo from `target_repo` / `target_hint` (must match allowlist; default `madebydamo/neo`).
2. Creates branch `heimcloud/incident-<id>` from the repo default branch.
3. Commits checklist stub `docs/heimcloud-ops/incident-<id>.md` (documentation-only shell for human/Repair).
4. Opens a **draft** pull request with the incident body. Reuses an existing open PR for the same head if present.
5. Sets incident `status=pr_opened` and stores `draft_pr_url`. **No auto-merge.**

Requires `OPS_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` with write on the push target. `madebydamo/neo` is remapped: branches push to fork `heimcloud/neo`, draft PR opens against `madebydamo/neo`.

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
- `OPS_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` — draft PR API (neo writes go to `heimcloud/neo` fork)
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
- Auto-fix / Repair agent
- Auto-merge of draft PRs
