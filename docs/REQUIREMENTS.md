# Heimcloud requirements dump

Living list of product/ops requirements from Damo → Heimcloud CEO.
When Damo says **"check if the requirements are met"**, verify each item with the stated check method and report pass/fail/partial + evidence.

Legend: **status** is operational note as of last dump update, not a live test.
IDs are stable (`REQ-…`) for linking test runs.

---

## A. Company & market

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-A1 | Brand/company: **Heimcloud**; site `heimcloud.site`; GitHub `@heimcloud`; email `heimcloud@proton.me` | DNS/GitHub/email accounts exist |
| REQ-A2 | Switzerland-first market entry | Shop CHF, CH shipping/legal stubs |
| REQ-A3 | Open-source **neo** stays free; Heimcloud sells hardware + services around it | Product copy + pricing model |
| REQ-A4 | GmbH later if solid; until then sole prop under Damo | Process/note only |

## B. Product catalog

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-B1 | Hardware SKU: ZimaBlade + NAS rack + SSD/HDD (media kit) | Shop `/kit` |
| REQ-B2 | Hardware SKU: NUC-class mini PC (TBD) — coming soon / interest | Shop `/mini-pc` |
| REQ-B3 | Orders on website; hardware fulfilled in **month-end batch** | Copy + ops process |
| REQ-B4 | Services (monthly subscriptions): public IP (rathole), AirVPN, Hermes AI tokens, backups (rsync.net) | Shop `/services` + Stripe prices |
| REQ-B5 | **Hardware = one-time**; **services = monthly** | Stripe Checkout modes |
| REQ-B6 | À la carte with caps / better combo pricing (goal) | Pricing config |
| REQ-B7 | Services-only on customer hardware is early edge case | Not optimized as main path |
| REQ-B8 | Shop visuals: not AI-default; hero shows hardware + service diagrams (polish deferred) | Manual UX review |

## C. Privacy & trust

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-C1 | Users keep full data control; Heimcloud must **not** hold customer root keys | Architecture review |
| REQ-C2 | Public IP via L4 streamproxy; TLS terminates on homeserver | Streamproxy/rathole design |
| REQ-C3 | Customer credential repos on Gitea are **private only** | Gitea repo visibility |
| REQ-C4 | Access via Neo homeserver SSH pubkey as **read-only deploy key** (`/home/homeserver/.ssh/id_ed25519.pub`) | Deploy key read_only=true |
| REQ-C5 | Key rotation: customer re-submits pubkey or pulls fail (by design) | Register/rotate path |
| REQ-C6 | Repo IDs are **opaque short slugs** (~8–10 chars), not sequential `customer-1` | Slug format |

## D. Shop (Neo plugin)

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-D1 | Shop is a **Neo plugin** (`github:heimcloud/shop`), not a standalone static host | Plugin install + `shop.*` |
| REQ-D2 | Live URL `https://shop.heimcloud.site` | HTTPS 200 |
| REQ-D3 | Stripe Checkout CHF; Test mode first; TWINT+cards as working choice | Stripe dashboard + checkout |
| REQ-D4 | Kit-only → `mode=payment`; services (±kit) → `mode=subscription` | Create session smoke |
| REQ-D5 | **SQLite + WAL** for customers/orders/entitlements/jobs (NOT MySQL/Postgres) | `PRAGMA journal_mode` / file backup docs |
| REQ-D6 | Stripe webhooks → upsert customer/order/entitlements + `provisioning_jobs` | Paid test → DB rows |
| REQ-D7 | Webhook URL `…/api/stripe/webhook`; secrets never in git | Env + gitignore |
| REQ-D8 | Tinyauth admin for shop ops UI | `/admin` → 302 tinyauth |
| REQ-D9 | Internal provisioning API (claim/complete/fail + ssh-key) for Credentials | Token-gated API |

## E. Credentials (plugin + repos + provisioner)

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-E1 | Public flake `github:heimcloud/credentials` (secrets only in private Gitea) | Repo visibility PUBLIC |
| REQ-E2 | Private per-customer repos on `git.heimcloud.site` under `customers/<slug>` | Gitea private |
| REQ-E3 | Repos are **config overlays** for existing Neo services, not new stub apps | Tree: `rathole/`, `vpn/`, `swag/`, `backup/`, `hermes/`, `ops/` |
| REQ-E4 | `public_ip` naming → **rathole** config | Folder/docs name |
| REQ-E5 | Import C: secrets→appdata `0600`; non-secrets→settings.toml hints | Importer behavior |
| REQ-E6 | Provisioner: Shop job → create/fill private repo (stubs/overlays) | Job → repo URL |
| REQ-E7 | No clash with core Hermes (`hermes_entitlement` removed/gated) | Plugin evaluates with Hermes |
| REQ-E8 | Lab: hattori → `KAKJWG9RM5`; thatch → `W4ZGSG7SYJ`; agwanti hands-off | Mapping + Fleet policy |

## F. Central user management

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-F1 | One central ledger linking: user, credentials `repo_slug`, orders, active subscriptions, SSH key | Shop admin (or agreed home) |
| REQ-F2 | Clear ownership: hattori/thatch **own** their credential repos | Admin shows machine↔slug |
| REQ-F3 | Detect mismatches: active sub vs missing overlay (and reverse) | Admin mismatch view |
| REQ-F4 | Pipeline: active subscription → ensure repo/overlay for that service | Job or sync path |

## G. Ops / Hermes self-improvement

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-G1 | Hermes company reports go to Heimcloud ops, **not** public `madebydamo/neo` Issues | Ingest target |
| REQ-G2 | `https://ops.heimcloud.site` ingest + SQLite WAL incidents | `/health` + POST |
| REQ-G3 | Manual **Create PR** only first; no auto-merge; Damo reviews | Draft PR + human gate |
| REQ-G4 | Neo contributions: **fork+PR** (`heimcloud/neo` → `madebydamo/neo`) | Create-PR routing |
| REQ-G5 | Allowlist: `madebydamo/neo`, `heimcloud/*`, explicit plugins | Config |
| REQ-G6 | Rate-limit / fingerprint; no secrets in PR bodies | Code review |
| REQ-G7 | Hermes skill `heimcloud-ops-ingest` on lab machines; bearer from `ops/ingest.token` | Skill published + smoke POST |
| REQ-G8 | Nightly update / activate / dependency failures → auto incident | `superviseUpdates` + failure drill |
| REQ-G9 | Lab boxes on neo **`master`** for testing (not long-lived feature branches) | Flake input ref |

## H. Infra / fleet

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-H1 | `heimcloud.site` DNS → streamproxy VPS (already configured) | DNS lookup |
| REQ-H2 | Lab: hattori, thatch for staging; agwanti hands-off unless asked | Fleet policy |
| REQ-H3 | Future: xAI token resale only; rsync.net reseller; AirVPN reseller TBD; Hostkey for public-IP VPSes | Backlog — not blocking |

## I. Agent team

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-I1 | CEO: overview, plan, credits | Role |
| REQ-I2 | Shop / Credentials / Fleet / Ops / Mail as named owners | Team roster |

---

## “Check requirements” runbook

1. Open this file.
2. For each REQ in scope (or all), run **Verify** column.
3. Report table: `ID | result | evidence | notes`.
4. Prefer live smokes: shop checkout (test card), webhook→DB, provisioning job→Gitea, ops ingest, Hermes skill POST, neo input=`master`, deploy-key read-only.

### Suggested smoke pack (minimal)

1. `curl -sS https://shop.heimcloud.site/` → 200  
2. `curl -sS https://ops.heimcloud.site/health` → ingest+github configured  
3. Stripe Test checkout kit → paid + SQLite customer/order  
4. Gitea `customers/KAKJWG9RM5` & `W4ZGSG7SYJ` private + deploy keys  
5. Hermes on hattori/thatch: force `heimcloud-ops-ingest` → new ops incident  
6. Neo flake input on lab = `master`

---

## Changelog

- 2026-09-17: Initial dump from Damo↔CEO conversation (product → shop → credentials overlays → ops/Hermes → user management).
