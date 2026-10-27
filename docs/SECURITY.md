# Security

> **An independent security audit is required before any mainnet funds flow through this system.**

## Money-critical files (mandatory human review)

Every file with a `// MONEY-CRITICAL` header is listed here and in the coverage gate in `vitest.config.ts` (≥90%).

| File | Purpose | Since |
|---|---|---|
| `packages/core/src/money.ts` | decimal string ↔ bigint minor units | M0 |
| `packages/core/src/confirmations.ts` | tiered confirmation depth + finality rule | M2 |
| `packages/chains/src/evm/deriver.ts` | xpub validation (private keys refused), address derivation, key fingerprint | M2 |
| `packages/chains/src/evm/transfers.ts` | Transfer log decoding, exact-contract filter | M2 |
| `apps/server/src/modules/custody/custody.ts` | custody strategy selection, atomic index allocation | M2 |
| `apps/server/src/db/seed-registry.ts` | chain + token registry (contract addresses, decimals, tiers) | M2 |
| `apps/server/db/migrations/0003_registry_security.sql` | address/xpub/token immutability, custody-mode and chain guards | M2 |
| `packages/core/src/invoice.ts` | invoice state machine, underpay/overpay classification | M3 |
| `apps/server/src/modules/invoices/invoices.ts` | invoice creation (amount parsing, address allocation), transitions, expiry | M3 |
| `apps/server/db/migrations/0005_invoices_security.sql` | DB transition table, invoice immutability, trigger-only history, custody-mode lock | M3 |
| `apps/server/src/modules/xpubs/xpubs.routes.ts` | merchant xpub dashboard routes (decide every future deposit address) | M3b |
| `apps/server/src/modules/xpubs/xpubs.ts` | xpub registration, live change cooldown, change application, derivation report | M8 |
| `apps/server/src/modules/xpubs/ownership.ts` | ownership proof: signature of address 0/0 over a recent challenge | M8 |
| `packages/chains/src/evm/secrets.ts` | detects seed phrases / private keys pasted as an xpub | M8 |
| `apps/server/db/migrations/0016_xpub_security.sql` | pending change immutability, key uniqueness across pending changes, proof immutability | M8 |
| `apps/server/src/modules/watcher/scanner.ts` | payment detection, reorg handling, confirmation, invoice reconciliation, fencing | M4 |
| `apps/server/db/migrations/0009_payments_security.sql` | payment/invoice consistency, immutable amounts, confirmed is final | M4 |
| `packages/core/src/fees.ts` | fee base and rounding | M5 |
| `apps/server/src/modules/ledger/ledger.ts` | ledger postings, fee charge, settlement, manual resolution | M5 |
| `apps/server/db/migrations/0011_ledger_outbox_security.sql` | balanced append-only ledger, fee immutability, trigger-only outbox | M5 |
| `apps/server/src/modules/ledger/fee-balance.ts` | prepaid fee balance and the live-invoice block | M8 |
| `apps/server/db/migrations/0017_fees.sql`, `0018_fees_security.sql` | fixed fee snapshot, top-up journals, append-only top-ups, journal/top-up consistency | M8 |

## Security-critical files (mandatory human review)

Not money-moving, but a bug here breaks authentication, tenant isolation or audit integrity.

| File | Purpose | Since |
|---|---|---|
| `apps/server/db/migrations/0001_security.sql` | DB roles, append-only audit, hash chain, RLS | M1 |
| `apps/server/src/common/db.ts` | tenant / system transaction context | M1 |
| `apps/server/src/common/crypto/*.ts` | envelope encryption, TOTP, argon2id, constant-time compare | M1 |
| `apps/server/src/modules/auth/*.ts` | sessions, refresh rotation, CSRF, guards, lockout, admin auth | M1 |
| `apps/server/src/modules/api-keys/api-keys.ts` | API key format, hashing, authentication | M1 |
| `apps/server/src/common/logger.ts` | secret redaction | M0 |
| `apps/server/src/common/idempotency.ts` | Idempotency-Key claim/replay in the work transaction | M3 |
| `apps/server/src/modules/checkout/*.ts` | public pages: escaping, nonce CSP, data exposure | M3 |
| `apps/server/src/modules/payment-links/payment-links.routes.ts` | public invoice creation guards | M3 |
| `packages/core/src/rbac.ts` | permission matrix | M1 |
| `apps/server/src/modules/webhooks/webhooks.routes.ts` | webhook signing-secret generation, encryption, rotation | M3b |
| `apps/server/src/modules/webhooks/ssrf.ts`, `delivery.ts` | outbound SSRF guard (address pinning), signing, retry state | M6 |
| `apps/server/db/migrations/0014_webhooks_security.sql` | trigger-only delivery creation, tenant isolation | M6 |
| `apps/server/src/modules/ledger/reconciliation.ts` | detects ledger/payment/invoice drift | M5 |
| `apps/server/src/modules/email/*.ts` | emailed tokens (hash-only storage, single use), encrypted outbox, delivery | M10 |
| `apps/server/src/modules/auth/dashboard-auth.routes.ts` | verification, password reset (2FA still required), session revocation | M1/M10 |
| `apps/server/src/modules/team/team.routes.ts` | invitations, role changes, removal, invite acceptance | M10 |
| `apps/server/db/migrations/0022_team_security.sql` | immutable invites, merchant always keeps an owner | M10 |
| `apps/server/db/migrations/0020_email_security.sql` | single-use tokens, final outbox states, tenant isolation | M10 |
| `apps/server/src/modules/admin/admin.routes.ts` | admin console: suspension, 2FA reset, kill switches, manual resolve, audit access | M5b |
| `apps/admin/src/api.ts`, `apps/admin/nginx.conf` | admin CSRF header; admin origin serves only /admin/ and its API path | M5b |
| `apps/dashboard/src/api.ts` | CSRF header, single-flight refresh (reuse detection would revoke the session) | M3b |
| `apps/dashboard/nginx.conf`, `security-headers.conf` | dashboard CSP and the only proxied API path | M3b |

## Assets

Merchant and customer funds; platform HD seed (custodial); hot/cold wallet keys; merchant xpubs (integrity, not secrecy);
API keys; webhook secrets; TOTP secrets; ledger integrity; audit log integrity.

## Actors

Anonymous internet; malicious payer; malicious merchant; compromised merchant account; malicious platform tenant;
lying/compromised RPC provider; network attacker; insider (developer, admin, ops); supply-chain attacker.

## Threat model

Status: `planned` until the mitigation's milestone lands, then the test that proves it is named.

| Attack | Mitigation | Test | Milestone |
|---|---|---|---|
| Fake token / spoofed Transfer log | Adapter keeps only logs emitted by the exact allowlisted contract (re-checked even after the RPC's address filter); strict decoding (3 topics, 32-byte data, mined, not removed); receipt status; re-verify at confirmation | `transfers.test.ts`, `evm-adapter.test.ts` (fake emitter); re-verify planned M4 | M2/M4 |
| Wrong network behind an RPC URL | `chains:verify` checks every RPC individually reports the configured chain id; watcher refuses to start otherwise (M4) | `custody.test.ts` (registry verification) | M2 |
| Wrong token decimals (10¹² error) | Seed pins decimals; on-chain `decimals()` checked by `chains:verify`; decimals immutable under a token id (trigger) | `custody.test.ts`, `evm-adapter.test.ts` | M2 |
| Token contract swap under an existing id | DB trigger: chain, contract, decimals immutable; app role cannot delete tokens/chains | `custody.test.ts` | M2 |
| Address reuse / index collision | One counter per key space, row-locked `UPDATE … RETURNING`; counters only move forward (trigger); unique (family, address) and (source, index); address rows immutable and undeletable | `custody.test.ts` (50 concurrent allocations, rollback, exhaustion) | M2 |
| Cross-merchant address attribution | Composite FK (xpub id, merchant, mode, family); key fingerprint unique across ALL merchants and the platform wallet (xpub/tpub encodings of one key collide) | `custody.test.ts` | M2 |
| Non-custodial merchant on platform keys | DB guard: address source must match custody mode; strategy selection exhaustive; custodial behind feature flag | `custody.test.ts` | M2 |
| Reorg double-credit | Block-hash ring per chain; unique `(chain_id, tx_hash, log_index)`; credit only after finality + confirmations | planned | M4 |
| Lying RPC | Multi-provider failover; quorum of two providers above value threshold; fresh re-verify at confirmation | planned | M4 |
| Webhook spoof (merchant side) | HMAC-SHA256 over `timestamp.rawBody`; constant-time compare; tested verification snippets (Node, PHP, Python, Go) | `webhooks.test.ts`, `ssrf.test.ts` | M6 |
| Webhook replay | Signed timestamp, receivers reject > 5 min skew; stable event id (`gateway-event-id`) for dedup | `webhooks.test.ts` | M6 |
| SSRF via webhook URL | All resolved addresses must be public (IANA special-purpose v4/v6 ranges, metadata, NAT64, 6to4, mapped); connect to the vetted address (DNS rebinding); no redirects; 10 s, 64 KiB caps; dev override refused in production | `ssrf.test.ts`, `webhooks.test.ts` | M6 |
| Insider tampering with audit trail | App role has no UPDATE/DELETE/TRUNCATE on `audit_logs`; trigger blocks even the owner; SHA-256 hash chain verified by `audit_verify()` | `db-security.test.ts` | M1 |
| Insider misuse (approvals) | Admin RBAC; reason on every change, audited in the same transaction; step-up TOTP for actions that lower a control (D-064); withdrawals need an admin approval with TOTP, two different admins at or above `WITHDRAWAL_TWO_PERSON_MIN` (DB guard: approvals only grow, one per admin) | `admin.test.ts`, `watcher.test.ts` | M5b/M7 |
| Key theft | Seed only in the signer process (sealed file in dev; KMS required in production, refused otherwise); signer takes intents not transactions, re-reads every record and re-derives every address from its own seed; hot/gas wallets must derive from that seed; per-token limits and cold allowlist in the signer's own env; kill switch (env + DB); HMAC on every request + mTLS in production; signatures written only by the signer's DB role, append-only | `signer.test.ts`, `signer-unit.test.ts` | M7b |
| Dust / address poisoning | Ignore below `min_amount`; never display unsolicited transfers | planned | M4 |
| Invoice / index race | Atomic index allocation; unique `(family, address)`; one address per invoice (unique FK) | `custody.test.ts`, `invoices.test.ts` | M2/M3 |
| Duplicate invoice from client retries | Idempotency-Key claimed in the same transaction as the invoice; concurrent duplicates block on the unique index and replay; different body → 409 | `invoices.test.ts` (20 parallel same-key requests → 1 invoice) | M3 |
| Illegal invoice status change (bug or insider) | One app transition function + DB trigger against the same table; history written only by trigger; amount/address/token immutable; no deletes | `invoice.test.ts` (all 144 pairs), `invoices.test.ts` | M3 |
| Late payment auto-fulfilled | `expired`/`cancelled` → `late_payment` only; `late_payment` → `paid` is manual | `invoice.test.ts` | M3 |
| Custody mode switched under live money | Trigger locks `custody_mode` after the first live invoice | `invoices.test.ts` | M3 |
| Checkout XSS / data leak | Escape-everything templating, script data via escaped JSON, `default-src 'none'` + per-response nonce, `frame-ancestors 'none'`, no-store; page shows no metadata/order ids | `invoices.test.ts` (hostile merchant name) | M3 |
| Address-burning via payment links | Invoice creation is POST-only (prefetch-safe), 5/10 min per IP, per-link cap on pending invoices (bounds wallet gap) | `invoices.test.ts` | M3 |
| Open redirect / javascript: URLs | success/cancel URLs must be http(s) (https in prod) without credentials | `invoices.test.ts` | M3 |
| Scanner DoS (log volume) | Adaptive chunking; in-memory address set; lag alerts | planned | M4 |
| Xpub substitution | Fresh TOTP; ownership signature by address `0/0` required for live keys; replacing a live key waits 24 h as a cancellable pending change shown in the dashboard; audit + log alert; xpub identity and proof immutable (triggers); email notice in M10 | `xpubs.test.ts`, `custody.test.ts` | M2/M8 |
| Private key submitted as xpub | Seed phrase / hex key / WIF / xprv detected before parsing, refused with a "treat it as exposed" message, recorded as `security.secret_submitted` (kind only); deriver also refuses private versions; input never echoed | `secrets.test.ts`, `deriver.test.ts`, `xpubs.test.ts` | M2/M8 |
| Widget postMessage spoofing / clickjacking | Checkout framable only by merchant-allowlisted exact origins (CSP `frame-ancestors`, else `'none'` + XFO DENY); frame posts only to that origin (never `*`); widget accepts messages only from its own iframe and the gateway origin, for its invoice; `onPaid` is display-only (fulfil from webhooks) | `widget.test.ts` + headless browser check | M10 |
| API key leak | HMAC-SHA256(pepper) storage, shown once; prefix lookup with constant-time compare even for unknown prefixes; scopes; IP allowlist; expiry; revocation; suspended merchant = dead keys; 2FA step-up to create; value-pattern log redaction | `api-keys.test.ts`, `crypto.test.ts`, `logger.test.ts` | M1 |
| Credential brute force | argon2id (m=19 MiB, t=2, p=1); per-account lockout (5 fails → 15 min, doubling, 24 h cap); per-IP rate limit 10/min on auth routes; identical errors + dummy hash for unknown accounts | `auth.test.ts` | M1 |
| Session theft / refresh replay | 10-min access JWT; httpOnly SameSite=Strict cookies; refresh rotation with reuse detection that revokes the whole family | `auth.test.ts` | M1 |
| Account takeover via email (password reset) | Reset token: 256-bit, SHA-256 stored, single use, 1 h, emailed via encrypted outbox; with 2FA on, reset also needs an authenticator or recovery code (failures count toward lockout); every session revoked; "password changed" email; forgot always answers 202 (no enumeration), one email/min/account | `email.test.ts` | M10 |
| Account takeover redirects payouts | Payout address changes need owner + TOTP, wait 24 h in live mode (owners emailed, cancellable), EIP-55 checksum against typos; a withdrawal is only sent to the address that is current when signing; owners emailed on every request | `withdrawals.test.ts` | M7 |
| Withdrawal double spend / over-withdrawal | Amount held at request under the merchant row lock; DB guards on states and approvals; the signer re-checks the hold and signs once per withdrawal; reconciliation `withdrawal_journal`, `negative_merchant_balance`, `negative_custody` | `withdrawals.test.ts` | M7 |
| Unnoticed sign-in with stolen credentials | Sign-in from a browser without a known device token (random, httpOnly cookie, hash stored) emails the user time, IP and browser, after 2FA passed; tokens bound to their user (trigger); client text sanitized | `email.test.ts` | M10 |
| Fake or mistyped signup email reaching live mode | Live API keys, xpubs, invoices, webhooks need a verified email (link token, 48 h, single use) | `email.test.ts` | M10 |
| Removed or demoted team member keeps access | Sessions revoked on role change and removal; removed users cannot sign in, refresh or reset; access tokens expire within 10 min; management routes re-read roles from the DB | `team.test.ts` | M10 |
| Admin escalates to owner / account left ownerless | Admins cannot grant or manage owner/admin; nobody changes their own role; last owner protected by API check and deferred DB trigger | `team.test.ts` | M10 |
| CSV/formula injection via exported merchant text | Cells starting with = + - @ tab CR are prefixed with `'`; RFC 4180 quoting; exports audited, bounded | `csv.test.ts`, `exports.test.ts` | M10 |
| Secrets in email at rest / in logs | Outbox payload (recipient, subject, body) envelope-encrypted, erased once sent or failed; only error codes stored; no-SMTP fallback logs subject only | `email.test.ts` | M10 |
| CSRF / login CSRF | Double-submit token + Origin allowlist on all cookie-authenticated state changes; Origin check on signup/login | `auth.test.ts` | M1 |
| TOTP replay | Last accepted time step persisted; codes at or below it refused | `crypto.test.ts`, `auth.test.ts`, `api-keys.test.ts` | M1 |
| TOTP secret theft from DB | Envelope encryption (per-value DEK, AES-256-GCM, KEK wrap, AAD bound to row) | `crypto.test.ts`, `auth.test.ts` | M1 |
| Cross-tenant access (IDOR) | Repository scoping by `merchant_id` + Postgres RLS (no context = no rows; wrong-tenant writes rejected) | `db-security.test.ts`, `api-keys.test.ts` | M1 (extended each milestone) |
| Rogue or compromised admin account lingers | Superadmin-only management with step-up TOTP and audited reasons; role and disabled state re-read on every admin request; credential reset bumps a session epoch carried in admin tokens (old sessions die at once; epoch cannot go down, trigger); nobody manages their own account; last active superadmin kept by API check + deferred trigger | `admins.test.ts` | M9 |
| Admin takeover via merchant session | Separate table, JWT secret, audience, cookie names/path and origin; password + TOTP every login; disabled admins cut off on next request; optional IP allowlist (404 outside) | `admin.test.ts` | M1 |
| Privilege escalation (role) | Server-side permission matrix on every route; mass-assignment blocked by strict schemas | `ids-rbac.test.ts`, `api-keys.test.ts`, `auth.test.ts` | M1 |
| Secret leakage via logs / audit | Key-name + value-pattern redaction applied to logs and audit payloads; config errors print key names only | `logger.test.ts`, `config.test.ts`, `db-security.test.ts` | M0/M1 |
| Error detail leakage | Unknown errors → generic 500 `internal_error`; full error only in server logs | `app.test.ts` | M0 |
| Log injection via request id | Caller request id accepted only if `[A-Za-z0-9._-]{8,128}` | `app.test.ts` | M0 |
| Client IP spoofing | `X-Forwarded-For` trusted only for `TRUST_PROXY_HOPS` hops | `admin.test.ts` | M1 |
| Float money bugs | bigint only; lint bans `parseFloat`, `Number.parseFloat`, `.toFixed` | `money.test.ts` + eslint | M0 |
| Vulnerable base-image tooling | npm/corepack removed from runtime image; trivy image scan in CI | trivy (0 HIGH/CRITICAL) | M1 |

## Known limits (accepted, revisit before launch)

- **RLS is a bug guard, not a privilege boundary.** The app role can set `app.system`; RLS catches forgotten
  `WHERE merchant_id = …`, not arbitrary SQL execution. SQL injection is prevented by parameterized queries only.
- **Hash chain cannot detect deletion of the newest rows** by someone who bypasses the trigger as superuser.
  Mitigation before launch: periodically export the latest `(seq, hash)` to write-once storage (anchoring).
- **Access JWTs are not revocable** for their 10-minute lifetime (logout/reuse detection kill the refresh token only).
- **Rate limiting fails open** if Redis is down (DB lockout still protects credentials). Alert on Redis health.
- **Two tabs refreshing at the same instant** look like refresh-token reuse and log the user out. Safe failure.
- **Signup has no email verification yet** (emails arrive in M10). Signup is rate limited and can be disabled (`SIGNUP_ENABLED`).

## Rules

- Never log secrets, private keys, mnemonics, full API keys, or webhook secrets. The logger redacts by key name and by value pattern (`sk_*`, `pk_*`, extended private keys).
- The API never accepts secrets in query strings: request logs include the URL.
- Env is validated at boot; the process exits on invalid config. Only `.env.example` is committed.
- The app connects as a non-owner role (member of `gw_app`); migrations run as the owner. The app cannot create, alter or drop tables.
- Every DB access runs inside `withTenant` (one merchant) or `withSystem` (cross-tenant; auth lookups, admin, workers).
- Containers run as non-root with read-only filesystems, `no-new-privileges`, all capabilities dropped, and no package manager.
- CI: lint, typecheck, unit + integration tests (Testcontainers) with coverage gate, `pnpm audit`, gitleaks, semgrep, trivy (fs + image).

## Key management

Key ceremony, backup, rotation, recovery and the multisig/cold-wallet treasury policy are written in M7, after the KMS
decision (D-010). Non-custodial mode (M8) involves no private keys.

Data KEK (envelope encryption): `DATA_KEK` + `DATA_KEK_ID` from the secret manager. Rotation: add the new KEK first in the
list, keep the old one for decryption, re-seal rows in the background, then remove the old KEK.
