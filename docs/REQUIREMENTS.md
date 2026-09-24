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
| REQ-E8 | Lab: hattori → `<lab-slug-a>`; thatch → `<lab-slug-b>`; agwanti hands-off | Mapping + Fleet policy |

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
| REQ-G3 | No auto-merge; Damo reviews every draft PR (fix PRs per REQ-G12; manual report-only PRs retired) | Draft PR + human gate |
| REQ-G4 | Neo contributions: **fork+PR** (`heimcloud/neo` → `madebydamo/neo`) | Create-PR routing |
| REQ-G5 | Allowlist: `madebydamo/neo`, `heimcloud/*`, explicit plugins | Config |
| REQ-G6 | Rate-limit / fingerprint; no secrets in PR bodies | Code review |
| REQ-G7 | Lab machines POST to ops with bearer from `ops/ingest.token` (credentials plugin tip `github:heimcloud/credentials`, not a pinned SHA). Prefer deterministic `neo-heimcloud-ops-report` oneshot; Hermes skill `heimcloud-ops-ingest` optional | Token present + smoke/oneshot POST |
| REQ-G8 | Nightly update / activate / dependency failures → auto incident | `neo-heimcloud-ops-report` oneshot on failure (+ `superviseUpdates` notify); pipeline-failure-probe drill |
| REQ-G9 | Lab boxes on neo **`master`** for testing (not long-lived feature branches) | Flake input ref |
| REQ-G10 | Hermes runs on the ops host (the machine serving `ops.heimcloud.site`) and the incident pipeline uses that local Hermes harness for triage/classification, incident summaries/responses and coding fixes on fork branches. No external or cloud coding agents in the loop. Design: [`AUTOFIX_DESIGN.md`](AUTOFIX_DESIGN.md) | Hermes service active on the ops host (`systemctl is-active` on the Hermes unit) **and** a sample incident gets a local Hermes triage result (class + summary recorded as an `incident_events` row) |
| REQ-G11 | No customer identifiers on GitHub (public or private): no customer slug, hostnames, domains, IPs, emails, usernames or slug-bearing plugin URLs in PR titles/bodies, commits, branch names or comments. Incidents referenced only by Ops incident # + `report_hash`; no incident docs committed to target repos | Redaction pass on every outbound payload + test that fails if a DB slug appears in the PR payload |
| REQ-G12 | Fix PRs are coded and tested before they exist: incident, then triage, then fix on a fork branch, then lab test on hattori only (Neo input at branch tip, never a SHA; no GitHub creds on lab machines), then automatic checks, then draft PR with anonymized evidence; human merge only. Design: [`AUTOFIX_DESIGN.md`](AUTOFIX_DESIGN.md) | Draft PR contains diff + lab test evidence; failed tests produce no PR |

## Deploy policy (Heimcloud org)

- **`main` tip is production.** No separate staging gate / ready-for-prod step.
- Ops (and other heimcloud plugins) deploy when **Fleet activates** the flake tip on the target box.
- Prefer flake refs like `github:heimcloud/credentials` / `github:heimcloud/ops` (branch tip), not `...@deadbeef` pins in smoke docs.

## H. Infra / fleet

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-H1 | `heimcloud.site` DNS → streamproxy VPS (already configured) | DNS lookup |
| REQ-H2 | Lab/test boxes: hattori, thatch; agwanti hands-off unless asked. Heimcloud `main` tip is production (no separate staging gate) | Fleet policy |
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
4. Gitea `customers/<lab-slug-a>` & `<lab-slug-b>` private + deploy keys  
5. Lab hattori/thatch: `neo-heimcloud-ops-report` / pipeline-failure-probe → new ops incident (credentials flake = `github:heimcloud/credentials` tip)  
6. Neo flake input on lab = `master`

---



## J. Customer SSH enrollment & auth (2026-09-17)

| ID | Requirement | Verify |
|----|-------------|--------|
| REQ-J1 | Two paths: **S** services-only (customer submits pubkey) and **H** hardware flash (Heimcloud captures Neo pubkey at setup) | Design + flows implemented |
| REQ-J2 | No unauthenticated SSH-key claim (prevents stealing another customer's repo) | Attempt unauth POST → 401/403 |
| REQ-J3 | Path S: Customer Portal login bound to Stripe/ledger email (magic link phase 1) | Login only works for known customer email |
| REQ-J4 | Path S: After auth, submit/rotate OpenSSH pubkey → RO Gitea deploy key on their `repo_slug` only | Key attached; other repos unaffected |
| REQ-J5 | Path H: Factory/setup after neo activate reads `/home/homeserver/.ssh/id_ed25519.pub` and attaches via staff-authenticated API | Factory checklist |
| REQ-J6 | Portal shows repo/plugin instructions; never asks for private key | UX review |
| REQ-J7 | Staff Tinyauth `/admin` ≠ customer portal; separate trust boundaries | Route separation |
| REQ-J8 | Phase 1 auth = shop magic link; Authentik optional later for SSO (Gitea/portal); Authelia not preferred as full customer IdP | Architecture decision recorded |

Full concept: [CUSTOMER_SSH_AND_AUTH.md](./CUSTOMER_SSH_AND_AUTH.md)

## Changelog
- 2026-09-24: autofix runner opt-in (queue/worker/skills; default off; compare-link fallback).
- 2026-09-24: AUTOFIX_DESIGN.md (local Hermes → lab-tested draft PRs; links from REQ-G10/G12).
- 2026-09-24: REQ-G10..G12 (local Hermes on ops host, anonymized PRs, tested-fix loop).

- 2026-09-17: Initial dump from Damo↔CEO conversation (product → shop → credentials overlays → ops/Hermes → user management).
- 2026-09-17: Added §J customer SSH enrollment paths S/H + auth plan (magic link first; Authentik later).
