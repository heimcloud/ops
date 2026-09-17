# Customer SSH key & account security — concept + plan

## Problem
Anyone must **not** be able to POST an arbitrary SSH public key and claim another customer’s private credentials repo. Key registration and repo access must be bound to a **proven customer identity**.

## Two legitimate paths

### Path S — Services only (customer’s own hardware)
1. Customer buys services (Stripe Checkout) → Shop creates `customers` row + entitlements + `repo_slug` + provisioning job.
2. Customer authenticates to a **Customer Portal** (identity = Stripe checkout email / `stripe_customer_id`).
3. In portal: paste Neo homeserver pubkey (`/home/homeserver/.ssh/id_ed25519.pub`) **or** upload `.pub` file.
4. Shop stores `neo_ssh_public_key` → Credentials attaches **read-only** Gitea deploy key on `customers/<repo_slug>` only.
5. Portal shows: plugin URL `github:heimcloud/credentials`, private clone URL / instructions, entitled overlays (rathole/vpn/swag/backup/hermes).
6. Customer adds plugin + syncs repo on their Neo; only their key can fetch.

### Path H — Hardware from Heimcloud (we flash the box)
1. Order hardware (+ optional services) → customer row + entitlements + `repo_slug` (may exist before ship).
2. **Factory / setup station** (Fleet or setup UI, authenticated as Heimcloud staff — not public):
   - Format disks, install Neo NixOS, first `neo activate`.
   - Neo generates `/home/homeserver/.ssh/id_ed25519(.pub)` if missing.
   - Setup tool reads **pubkey**, POSTs to Shop internal API as that `customer_id` (staff token), Credentials attaches deploy key.
   - Credentials overlays for purchased services applied / synced onto the machine.
3. Ship machine already enrolled; customer can later **rotate** key only via authenticated portal (re-submit new pubkey after `neo-homeserver-ssh-key rotate`).
4. Optional: portal “claim device” with one-time setup code printed in box / email (binds physical unit → customer if order was gift/reseller).

## What is forbidden
- Unauthenticated `/ssh-key` or “claim this pubkey” endpoints.
- Public Gitea repos.
- Using sequential repo names.
- Letting Tinyauth-admin staff paths be the *only* long-term customer UX (staff is Path H factory; customers need Path S portal).

## Identity options (Authen… / Authentic…)

| Option | What it is | Fit for Heimcloud |
|--------|------------|-------------------|
| **A. Shop Customer Portal + magic link** | Email OTP / magic link to the Stripe-verified order email; session cookie on `shop.heimcloud.site/account` | **Recommended phase 1** — smallest, binds to billing identity, enough for SSH submit + repo status |
| **B. Authelia** | Lightweight forward-auth / OIDC gateway | Good edge gate; weak as full customer directory; Neo already has **tinyauth** for staff admin |
| **C. Authentik** | Full IdP (OIDC/SAML/LDAP, user portal, flows) | **Phase 2+** if we need SSO across Shop portal + Gitea + Ops + future apps, MFA enrollment, support impersonation |

**Recommendation:** Implement **A** now. Keep Tinyauth for Heimcloud **staff** admin (`/admin`). Evaluate **Authentik** when we want one login for Gitea UI + portal + support tools — not required to make SSH claim safe.

## Target UX (portal)

- `/account/login` — magic link to email (must match `customers.email` or be a verified Stripe customer email).
- `/account` — orders, active subscriptions, `repo_slug`, deploy-key status, mismatch warnings.
- `/account/ssh` — submit/rotate OpenSSH pubkey; shows last 4 fingerprint only after save.
- `/account/setup` — plugin install steps; for Path H, show “already enrolled” if key attached at factory.

## Data model additions (Shop ledger)

- `customers.auth_subject` (optional OIDC sub later)
- `magic_link_tokens` (hash, expires, customer_id) — or equivalent
- `device_setup_codes` (optional one-time for Path H claim)
- Existing: `neo_ssh_public_key`, `gitea_deploy_key_id`, `repo_slug`, entitlements

## Pipeline (unchanged core + auth gate)

```
Stripe paid → customer + entitlements + repo_slug + jobs
     ↓
Path S: portal login → SSH pubkey → deploy key
Path H: factory activate → capture pubkey → deploy key → ship
     ↓
Credentials overlay sync (rathole/vpn/swag/backup/hermes/ops)
```

## Implementation phases

### Phase 1 (security MVP)
1. Shop Customer Portal magic-link auth (email must match ledger).
2. Authenticated SSH submit/rotate UI → existing ssh-key API.
3. Portal shows repo + plugin instructions.
4. Factory script/docs for Path H: read pubkey → staff-authenticated attach.
5. Update REQUIREMENTS.md with REQ-SSH-* / REQ-AUTH-*.

### Phase 2
1. Stripe Customer Portal / Billing portal deep links.
2. Device setup codes for hardware claim.
3. MFA on customer portal (TOTP/WebAuthn).

### Phase 3 (optional IdP)
1. Stand up **Authentik** on Heimcloud ops host if SSO needed (Gitea OAuth app, shop OIDC).
2. Migrate magic-link users → Authentik; Tinyauth remains or also OIDC for staff.

## Threat notes
- Magic links: short TTL, single-use, rate-limit by email/IP.
- Staff factory token: separate from customer sessions; IP allowlist optional.
- Deploy keys: read-only; never write access for customer keys.
- Support must never ask customer to paste **private** key.
