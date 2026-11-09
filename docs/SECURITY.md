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
| `apps/server/db/migrations/0039_risk.sql`, `0040_risk_security.sql` | `held` status, transitions into and out of it, limits tenant isolation | M9 |
| `apps/server/src/modules/risk/risk.ts` | risk hold decision: blocked payer, live limits (D-094) | M9 |
| `packages/core/src/fees.ts` | fee base and rounding | M5 |
| `apps/server/src/modules/ledger/ledger.ts` | ledger postings, fee charge, settlement, manual resolution | M5 |
| `apps/server/db/migrations/0011_ledger_outbox_security.sql` | balanced append-only ledger, fee immutability, trigger-only outbox | M5 |
| `apps/server/src/modules/ledger/fee-balance.ts` | prepaid fee balance and the live-invoice block | M8 |
| `apps/server/db/migrations/0017_fees.sql`, `0018_fees_security.sql` | fixed fee snapshot, top-up journals, append-only top-ups, journal/top-up consistency | M8 |
| `apps/signer/src/signer.ts` | the only signing code: intent checks, re-derivation, limits, kill switch, one transaction per intent | M7 |
| `apps/signer/src/keys.ts`, `apps/signer/src/seed.ts` | key derivation by role; sealed seed file (dev/test only) | M7 |
| `apps/server/src/modules/custody/sweeper.ts` | sweeps: gas top-up, transfer to hot, confirmation, booking, settlement | M7 |
| `apps/server/src/modules/custody/payouts.ts` | sending approved withdrawals, confirm or release | M7 |
| `apps/server/src/modules/custody/treasury.ts` | hot ↔ cold transfers, on-chain verification of refills | M7 |
| `apps/server/src/modules/withdrawals/withdrawals.ts` | payout addresses, requests and holds, approvals, release | M7 |
| `apps/server/db/migrations/0029_custodial_ledger.sql` … `0038_treasury_security.sql` | custodial account kinds and journals, per-journal account allow-lists, sweep/withdrawal/treasury/platform-wallet guards, signer DB role | M7 |
| `contracts/src/Forwarder.sol`, `contracts/src/ForwarderFactory.sol` | forwarder custody: per-invoice CREATE2 contract that can only pay the merchant and the capped fee (audit before mainnet) | M12 |
| `packages/chains/src/evm/forwarder.ts`, `forwarder.artifacts.json` | forwarder address math and fee split (must equal the contracts), committed bytecode | M12 |
| `apps/server/src/modules/custody/forwarder.ts` | forwards: planning from on-chain balances, signer intents, confirmation, fee booking, settlement | M12 |
| `apps/server/src/modules/custody/payout-addresses.ts` | current payout address (withdrawals and forwarder destinations) | M12 |
| `apps/server/db/migrations/0049_deposit_accounts.sql`, `0050_deposit_accounts_security.sql`, `0051_sweeps_open_index.sql` | deposit accounts (immutable, address from the source of their custody mode), deposit invoices tied to their account, payment invoices never on an account address, sweeps per address | D-101 |
| `apps/server/src/modules/deposits/deposit-accounts.ts` | account issue/retire, deposit invoice per transfer | D-101 |
| `apps/server/db/migrations/0047_withdrawal_limits_payouts.sql`, `0048_withdrawal_limits_payouts_security.sql` | merchant limits (per tx, 24 h), user payouts (auto-approved, payout fee, destination check `payout_destination_allowed`), fee booked on confirmation, `payout.*` events | D-100 |
| `apps/server/db/migrations/0045_partial_payments.sql`, `0046_partial_payments_security.sql` | `partially_paid` status: custodial only, `underpaid` edge only, settlement journal allowed for it | D-099 |
| `apps/server/src/modules/custody/partials.ts` | closes underpaid custodial invoices after the deadline (scanned past it, fully swept) | D-099 |
| `apps/server/db/migrations/0043_forwarder.sql`, `0044_forwarder_security.sql` | forwarder params (immutable, tied to current payout address, fee wallet, factory, token), forward guards and fee cap, set-once factory | M12 |
| `apps/server/src/modules/custody/hot-wallet-policy.ts` | hot wallet cap (automatic hot → cold for the excess) and low-balance alerts | D-105 |
| `apps/server/src/modules/admin/settings.ts` | console settings, incl. the two-admin withdrawal threshold (capped by the env ceiling) | D-107 |
| `apps/server/src/modules/security/whitelist.ts` | merchant payout address whitelist and API IP whitelist (with the DB guard in migration 0058) | D-109 |
| `apps/server/db/migrations/0052_hot_wallet_policies.sql`, `0053_hot_wallet_policies_security.sql` | policies (system-only, no delete), automatic treasury rows: hot → cold only, at most the excess over the cap, one in flight | D-105 |

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
| `apps/server/src/modules/registry/registry.ts` | RPC pre-flight: network id, token decimals, two providers on mainnet (D-092) | M2/M11 |
| `apps/signer/src/config.ts` | signer limits, cold allowlist, seed KEK only from a file in production (D-010) | M7/M11 |
| `integrations/woocommerce/gateway-crypto/**` | marks WooCommerce orders paid: webhook signature, invoice re-read, amount check (D-093) | M10 |
| `apps/server/src/common/idempotency.ts` | Idempotency-Key claim/replay in the work transaction | M3 |
| `apps/server/src/modules/checkout/*.ts` | public pages: escaping, nonce CSP, data exposure | M3 |
| `apps/server/src/modules/payment-links/payment-links.routes.ts` | public invoice creation guards | M3 |
| `packages/core/src/rbac.ts` | permission matrix | M1 |
| `apps/server/src/modules/webhooks/webhooks.routes.ts` | webhook signing-secret generation, encryption, rotation | M3b |
| `apps/server/src/modules/webhooks/ssrf.ts`, `delivery.ts` | outbound SSRF guard (address pinning), signing, retry state | M6 |
| `apps/server/db/migrations/0014_webhooks_security.sql` | trigger-only delivery creation, tenant isolation | M6 |
| `apps/server/db/migrations/0041_sub_merchants.sql`, `0042_sub_merchants_security.sql` | sellers stay inside their merchant and mode (composite FKs, RLS), invoice seller immutable, seller-scoped webhook fan-out | M9 |
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
| Postgres restart / failover | Pool drops dead idle connections instead of crashing the process; next query reconnects | `chaos.test.ts` | M11 |
| Redis outage | Rate limits fail open (D-031); api client has no offline queue, so requests never wait on Redis | `chaos.test.ts` | M11 |
| Payment from a sanctioned / fraudulent payer, or a merchant suddenly taking far more than usual | Payer blocklist and live per-invoice / per-day limits hold the invoice for an admin decision (D-094) | `watcher.test.ts` | M9 |
| Lying RPC | Multi-provider failover; confirmation needs two providers to each see the receipt and the depth (D-092); mainnet refuses fewer than two providers; fresh re-verify at confirmation | `watcher.test.ts`, `custody.test.ts` | M11 |
| Webhook spoof (merchant side) | HMAC-SHA256 over `timestamp.rawBody`; constant-time compare; tested verification snippets (Node, PHP, Python, Go) | `webhooks.test.ts`, `ssrf.test.ts` | M6 |
| Webhook replay | Signed timestamp, receivers reject > 5 min skew; stable event id (`gateway-event-id`) for dedup | `webhooks.test.ts` | M6 |
| SSRF via webhook URL | All resolved addresses must be public (IANA special-purpose v4/v6 ranges, metadata, NAT64, 6to4, mapped); connect to the vetted address (DNS rebinding); no redirects; 10 s, 64 KiB caps; dev override refused in production | `ssrf.test.ts`, `webhooks.test.ts` | M6 |
| Insider tampering with audit trail | App role has no UPDATE/DELETE/TRUNCATE on `audit_logs`; trigger blocks even the owner; SHA-256 hash chain verified by `audit_verify()` | `db-security.test.ts` | M1 |
| Insider misuse (approvals) | Admin RBAC; reason on every change, audited in the same transaction; step-up TOTP for actions that lower a control (D-064); withdrawals need an admin approval with TOTP, two different admins at or above the Settings threshold, which can never exceed `WITHDRAWAL_TWO_PERSON_MIN` (so one console account cannot loosen it; DB guard: approvals only grow, one per admin) | `admin.test.ts`, `watcher.test.ts`, `platform-settings.test.ts` | M5b/M7/D-107 |
| Key theft | Seed only in the signer process (sealed file; in production its KEK only from a secret-manager file on tmpfs, never an env var; no KMS, D-010); signer takes intents not transactions, re-reads every record and re-derives every address from its own seed; hot/gas wallets must derive from that seed; per-token limits and cold allowlist in the signer's own env; kill switch (env + DB); HMAC on every request + mTLS in production, the HMAC secret held by the worker only (api and watcher never get it); seed file sealed with a pinned 16-byte GCM tag; signatures written only by the signer's DB role, append-only | `signer.test.ts`, `signer-unit.test.ts` | M7b |
| Dust / address poisoning | Ignore below `min_amount`; never display unsolicited transfers | planned | M4 |
| Invoice / index race | Atomic index allocation; unique `(family, address)`; one address per invoice (unique FK) | `custody.test.ts`, `invoices.test.ts` | M2/M3 |
| Duplicate invoice from client retries | Idempotency-Key claimed in the same transaction as the invoice; concurrent duplicates block on the unique index and replay; different body → 409 | `invoices.test.ts` (20 parallel same-key requests → 1 invoice) | M3 |
| Illegal invoice status change (bug or insider) | One app transition function + DB trigger against the same table; history written only by trigger; amount/address/token immutable; no deletes | `invoice.test.ts` (all 144 pairs), `invoices.test.ts` | M3 |
| Late payment auto-fulfilled | `expired`/`cancelled` → `late_payment` only; `late_payment` → `paid` is manual | `invoice.test.ts` | M3 |
| Custody mode switched under live money | Trigger locks `custody_mode` after the first live invoice | `invoices.test.ts` | M3 |
| Leaked `payouts:write` key drains the merchant balance to attacker wallets | Live payouts refused without both merchant limits; per-transaction and 24 h caps enforced by app, DB guard and signer; platform `SIGNER_LIMITS`; blocklist; scoped keys (rotate on leak) | `payouts.test.ts` | D-100 |
| A deposit credited twice, or to the wrong user | One deposit invoice per (account, tx hash:log index), unique index; created in the scan transaction; guard ties it to its account's user, address, token and custody | `deposit-accounts.test.ts` | D-101 |
| Payout sent into custody or another merchant's address (loops, mis-crediting) | `payout_destination_allowed`: no platform wallet, no deposit address of any merchant, no blocked address; checked by app, DB guard, signer | `payouts.test.ts` | D-100 |
| Partial payment credited too early or twice (custodial) | `underpaid` -> `partially_paid` only after the deadline, once the scanner passed it and every payment was swept; custodial only (DB guard); final status; one settlement journal per invoice (unique index); reconciliation `custodial_settlement` | `custodial-ledger.test.ts`, `invoice.test.ts` | D-099 |
| Custody turned off with funds still held (stranded balance) | Switch refused while any custodial balance or open custody invoice exists; withdrawals refused while `FEATURE_CUSTODIAL` is off | `custody-mode.test.ts` | D-098 |
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
| Merchant account taken over, payouts redirected | Payout address whitelist (D-109): payouts only to active whitelisted addresses (app + DB trigger); new live addresses wait `whitelist_activation_hours`; switching off is scheduled `whitelist_disable_hours` ahead and refused early by the DB; owners emailed on additions and scheduled switch-offs; all changes owner + 2FA, audited | `merchant-security.test.ts` | D-109 |
| Stolen merchant API key | Account IP whitelist for secret keys (D-109) on top of per-key allowlists; per-key fingerprint of every IP + client with first/last seen and blocked attempts, new clients flagged in the dashboard (D-110) | `merchant-security.test.ts` | D-109/D-110 |
| Admin console reached from anywhere | Console IP allowlist (D-107): off by default; when on, every `/admin/v1` route (login included) answers 404 outside it, checked before auth on each request; switching it on is refused unless the caller's own IP is listed (no self-lockout); env `ADMIN_IP_ALLOWLIST` applies as well; recovery by SQL (RUNBOOK) | `platform-settings.test.ts` | D-107 |
| Unattended admin console left signed in | Sliding admin session (D-106): the JWT is re-issued per request and dies after the idle limit (default 30 min) and at the latest the absolute limit after sign-in (default 12 h, `ast` claim); only a superadmin with step-up 2FA changes the limits (5–240 min, 1–24 h, DB checks), audited | `admin.test.ts` | D-106 |
| Privilege escalation (role) | Server-side permission matrix on every route; mass-assignment blocked by strict schemas | `ids-rbac.test.ts`, `api-keys.test.ts`, `auth.test.ts` | M1 |
| Secret leakage via logs / audit | Key-name + value-pattern redaction applied to logs and audit payloads; config errors print key names only | `logger.test.ts`, `config.test.ts`, `db-security.test.ts` | M0/M1 |
| Error detail leakage | Unknown errors → generic 500 `internal_error`; full error only in server logs | `app.test.ts` | M0 |
| Log injection via request id | Caller request id accepted only if `[A-Za-z0-9._-]{8,128}` | `app.test.ts` | M0 |
| Client IP spoofing | `X-Forwarded-For` trusted only for `TRUST_PROXY_HOPS` hops | `admin.test.ts` | M1 |
| Float money bugs | bigint only; lint bans `parseFloat`, `Number.parseFloat`, `.toFixed` | `money.test.ts` + eslint | M0 |
| Vulnerable base-image tooling | npm/corepack removed from runtime image; trivy image scan in CI | trivy (0 HIGH/CRITICAL) | M1 |
| Forwarder pays someone else (D-097) | The deposit address is CREATE2 over every constructor argument (merchant, fee wallet, token, rate, cap); the contract has no owner or other destination; params immutable and DB-tied to the current payout address and active fee wallet; the signer re-derives the address and checks the factory code hash before signing | `Forwarder.t.sol`, `forwarder.test.ts` | M12 |
| Wrong or malicious forwarder factory | Factory set once per chain (trigger); `chains:verify` and the signer compare its on-chain code hash with the committed artifact; the deploy CLI refuses mainnet | `forwarder.test.ts` | M12 |
| Forwarder fee above the agreed rate | Cap committed in the address (fee on the invoice amount); the contract enforces it across flushes; DB guard on confirmed forwards; no fixed fee in this mode | `Forwarder.t.sol`, `forwarder.test.ts` | M12 |
| Gas wallet drained by runaway flushes | Signer caps forwards per 24 h and gas per flush; gas price cap; kill switch | `forwarder.test.ts` | M12 |

## Known limits (accepted, revisit before launch)

- **RLS is a bug guard, not a privilege boundary.** The app role can set `app.system`; RLS catches forgotten
  `WHERE merchant_id = …`, not arbitrary SQL execution. SQL injection is prevented by parameterized queries only.
- **Hash chain cannot detect deletion of the newest rows** by someone who bypasses the trigger as superuser.
  Mitigation before launch: periodically export the latest `(seq, hash)` to write-once storage (anchoring).
- **Access JWTs are not revocable** for their 10-minute lifetime (logout/reuse detection kill the refresh token only).
- **Rate limiting fails open** if Redis is down (DB lockout still protects credentials). Alert on Redis health.
- **Two tabs refreshing at the same instant** look like refresh-token reuse and log the user out. Safe failure.
- **Signup has no email verification yet** (emails arrive in M10). Signup is rate limited and can be disabled (Settings, or `SIGNUP_ENABLED`).

## Rules

- Never log secrets, private keys, mnemonics, full API keys, or webhook secrets. The logger redacts by key name and by value pattern (`sk_*`, `pk_*`, extended private keys).
- The API never accepts secrets in query strings: request logs include the URL.
- Env is validated at boot; the process exits on invalid config. Only `.env.example` is committed.
- The app connects as a non-owner role (member of `gw_app`); migrations run as the owner. The app cannot create, alter or drop tables.
- Every DB access runs inside `withTenant` (one merchant) or `withSystem` (cross-tenant; auth lookups, admin, workers).
- Containers run as non-root with read-only filesystems, `no-new-privileges`, all capabilities dropped, and no package manager.
- CI: lint, typecheck, unit + integration tests (Testcontainers) with coverage gate, `pnpm audit`, gitleaks, semgrep, trivy (fs + image).

## Key management

No KMS (D-010): the signer's seed is a sealed file and its KEK (`SIGNER_SEED_KEK_FILE`) is written to tmpfs by the
secret manager at boot. Root on the signer host can read the seed, so the hot wallet holds only what payouts need and
the rest sits in the cold multisig. Non-custodial mode (M8) involves no private keys.

Data KEK (envelope encryption): `DATA_KEK` + `DATA_KEK_ID` from the secret manager. Rotation: add the new KEK first in the
list, keep the old one for decryption, re-seal rows in the background, then remove the old KEK.
