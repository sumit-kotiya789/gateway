# Decisions

Append-only log. Each entry: decision, reason, revisit trigger.

## D-001 Fastify over NestJS (2026-10-20)
Zod-native schemas via type provider give OpenAPI 3.1 without decorator duplication; less DI ceremony.
Module boundaries enforced by folder layout + dependency-cruiser rules (added when modules exist).

## D-002 Drizzle + hand-written SQL migrations (2026-10-20)
Triggers, roles, RLS and append-only rules need raw SQL anyway. Prisma's Decimal/row-lock story is weaker.

## D-003 pnpm workspace monorepo (2026-10-20)
`packages/core` (pure domain), `apps/server` (api/worker/watcher, one image), `apps/signer` (isolated, M7).
Internal packages export TypeScript source; production images are esbuild bundles, so no per-package build step.

## D-004 Node 22 LTS (2026-10-20)
Node 20 reached end-of-life April 2026. Move to Node 24 LTS before mainnet launch (in LAUNCH_CHECKLIST).

## D-005 TypeScript 6.0 (2026-10-20)
TypeScript 7 (native) is not yet supported by typescript-eslint (peer `<6.1`). Revisit when it is.

## D-006 Amount strings: reject excess precision, canonical output trims zeros (2026-10-20)
`toMinorUnits("1.0000001", 6)` is an error, never rounded. `fromMinorUnits` returns `"25"` not `"25.000000"`.
Rejected inputs: exponent notation, signs, leading zeros, leading/trailing dot, whitespace, non-ASCII digits.

## D-007 Build order: non-custodial (M8) before custodial (M7) (2026-10-20, owner)
MVP = M0–M6 + M8. Pause after M8 for owner review. Custodial is behind a feature flag, off in production by default.

## D-008 Confirmation policy (2026-10-20, owner)
Credit when the block is at or below the chain's `finalized` tag AND tiered minimum confirmations are met.
If the RPC does not support `finalized`, fall back to confirmation count only.

## D-009 Non-custodial fee balance (2026-10-20, owner)
At zero prepaid fee balance: block new invoices. Low-balance alerts. Optional small fixed grace amount per merchant.

## D-010 Key custody (2026-10-20, owner)
KMS provider undecided. Dev KEK behind a `KeyEncryptionKey` interface. Decision required before M7.

## D-011 Fees default 1% + 0, rounded down (2026-10-20)
`fee = floor(amount * bps / 10000) + fixed`. Rounding favors the merchant. Platform fee wallet is separate and multisig-ready by config.

## D-012 Deployment target: plain VMs + docker compose (2026-10-20, owner)
Kubernetes covered as a documentation note only.

## D-013 Hosted checkout wallet support (2026-10-20, owner)
Injected EVM wallet only. WalletConnect behind a config flag (needs a project id).

## D-014 Test vs live isolation via `livemode` column (2026-10-20)
Every merchant-scoped row carries `livemode`; test keys can only reach testnet chains and test wallet accounts.

## D-015 Defense-in-depth tenant isolation with Postgres RLS (2026-10-20)
Repository-level `merchant_id` scoping plus RLS policies keyed on `SET LOCAL app.merchant_id`.

## D-016 Active deposit-address set in process memory + Postgres LISTEN/NOTIFY (2026-10-20)
No Redis needed for matching. Periodic full refresh guards against missed notifications.

## D-017 Watcher leader election via Postgres advisory lock + fencing epoch (2026-10-20)
Cursor writes include `WHERE leader_epoch = $epoch`; a stale leader's writes affect zero rows.

## D-018 One HD index counter per EVM key space, not per chain (2026-10-20)
An address never serves two invoices on any EVM chain. Wrong-EVM-chain payments remain recoverable (custodial) and attributable.

## D-019 Signer takes intents, not raw transactions (2026-10-20)
`Signer.sign(intent)`: signer re-reads the referenced withdrawal/sweep, checks allowlist and caps, builds the tx itself.
Amends the original `sign(tx, keyRef)` interface.

## D-020 Hosted checkout server-rendered by api; dashboard is a Vite + React SPA (2026-10-20)
Checkout stays tiny with strict nonce CSP. No Next.js runtime to operate.

## D-021 CI scanners run from container images, not third-party actions (2026-10-20)
Only `actions/*` used. gitleaks, semgrep, trivy run as pinned images. Reduces action supply-chain risk.
Revisit: pin `actions/*` by commit SHA before launch.

## D-022 Mailpit instead of MailHog for local email (2026-10-20)
MailHog is unmaintained. Mailpit is the maintained drop-in.

## D-024 MVP adds two UI milestones (2026-10-20, owner)
M3b minimal merchant dashboard and M5b minimal admin console join the MVP. Order otherwise unchanged.
Admin endpoints needed by M5b (kill switches, risk flags, manual resolve) are pulled forward from M9.

## D-025 Admin console is a separate app on a separate origin (2026-10-20)
`apps/admin` is served from its own origin with its own session cookie and auth domain (`admin_users`), mandatory 2FA,
optional IP allowlist. A merchant-dashboard XSS or session cannot reach admin routes.

## D-026 Schema grows per milestone (2026-10-20)
Forward-only migrations; each milestone adds the tables it uses. drizzle-kit generates table DDL from
`src/db/schema.ts`; roles, RLS, triggers live in hand-written `*_security.sql`-style custom migrations.

## D-027 argon2id via hash-wasm (2026-10-20)
WebAssembly, no native addon, so the server stays a single esbuild bundle. Node 22 has no built-in argon2.
Params: OWASP minimum m=19 MiB, t=2, p=1.

## D-028 TOTP and API-key crypto on node:crypto; JWT via jose (2026-10-20)
TOTP (RFC 6238) and base32 are ~60 lines, tested against RFC vectors. JWT handling uses a maintained library.

## D-029 Dashboard and admin served same-origin with the API path they call (2026-10-20)
A reverse proxy serves each SPA and forwards its API path, so cookies are first-party, double-submit CSRF works, and no
CORS is needed (the CORS plugin was removed). Origins are still allowlisted for the Origin check.

## D-030 Step-up 2FA is per action (2026-10-20)
Sensitive actions (API key creation; later withdrawals, payout addresses, xpub changes) need a fresh TOTP code in
`x-totp-code`. Replay protection means a user may wait up to 30 s after a login code. No "recent MFA" window.

## D-031 Rate limiting fails open on Redis outage (2026-10-20)
Availability over strictness for API traffic; DB-backed account lockout still stops credential brute force.

## D-032 Deferred out of M1 (2026-10-20)
- Idempotency keys: M3 (first state-changing merchant-API POST).
- Team invite/management endpoints: M3b with the dashboard (needs email; RBAC is enforced and tested now).
- Email verification, new-device emails, password reset, 2FA disable/reset, recovery-code regeneration: M10 (emails).
- Admin refresh tokens: none by design; admins re-login every 15 min.
- Platforms table: M9.

## D-033 Recovery codes: 10 × 64-bit, SHA-256 hashed (2026-10-20)
High-entropy random codes do not need a slow hash. Case and dashes are ignored on input.

## D-034 Runtime image has no package manager (2026-10-20)
npm/corepack/yarn are deleted from the final stage. They carried the only HIGH CVEs trivy found and are never used at runtime.

## D-035 Confirmation depth = latest - txBlock (2026-10-21)
Spec rule taken literally: credit when `latest - txBlock >= required` (one stricter than counting the mining block),
AND the tx block is at or below the `finalized` tag when the chain reports one (D-008).

## D-036 BSC registry defaults (2026-10-21)
USDT BEP-20 `0x55d398326f99059fF775485246999027B3197955`, 18 decimals. Min confirmations 15; tiers ≥10k USDT → 30,
≥100k → 60. Dust threshold 0.01 USDT. Reorg depth 64. Mainnet chain seeded **disabled** (launch checklist enables it).
BSC testnet has no official USDT: we deploy our own mock and register it via `BSC_TESTNET_USDT_ADDRESS`.

## D-037 RPC URLs hold `${ENV}` placeholders (2026-10-21)
Provider API keys stay in the secret manager. URLs with unset variables are dropped, never called with a blank key.
Verification output never prints URLs.

## D-038 Extended keys unique by fingerprint across merchants and platform (2026-10-21)
`sha256(pubkey || chaincode)`, so xpub and tpub encodings of one key collide. Enforced by unique indexes plus a
cross-table trigger. Prevents a merchant registering the platform's (public) xpub, and two merchants sharing addresses.

## D-039 Strict Transfer decoding in our code, not viem's ABI decoder (2026-10-21)
Exactly 3 topics (ERC-721 Transfer has 4), exactly 32 bytes of data, clean address topics, mined and not removed.
Emitter address re-checked after the RPC's own filter.

## D-040 Test contracts compiled once with Foundry; artifacts committed (2026-10-21)
`contracts/src/Mocks.sol` (MockERC20, FeeOnTransferERC20, FakeTransferEmitter). `pnpm contracts:build` recompiles in
the Foundry container and refreshes `packages/chains/test/fixtures/mocks.json`. Tests need no Solidity toolchain.

## D-041 Derivation counters are BIGINT (2026-10-21)
`next_index` can reach 2^31 (= exhausted) which does not fit INTEGER. Allocation refuses rows at the limit (clean 409)
instead of overflowing.

## D-042 Custodial allocation fails as 503 when no platform wallet exists (2026-10-21)
A missing platform wallet is an operator problem, not a merchant input error. Platform wallet registration ships with M7.

## D-043 Invoice lifecycle details (2026-10-21)
- Created in `created`, moved to `pending` in the same transaction once the address is allocated (both recorded).
- Underpaid invoices do not expire to `expired`: funds were received, the merchant decides (accept → `paid`, or refund).
- Late-payment watch window: deposit addresses stay watched 30 days after expiry (`watch_until`).
- Tolerance: per-merchant `underpay_tolerance_bps` (default 50 = 0.5%, max 5%), snapshotted onto each invoice.
- Amount must be ≥ the token's dust threshold (`min_amount`), else the payment could never be credited.

## D-044 Idempotency semantics (2026-10-21)
Optional `Idempotency-Key` (1–255 printable ASCII) on every state-changing merchant-API POST. Scope: merchant + mode.
Stored only on success, in the same transaction as the side effect: a failed request never burns the key. Replays return
the original status/body with `idempotent-replayed: true`. Retention: 24 h (worker job `purge-idempotency-keys`, hourly).

## D-045 Hosted checkout: server-rendered, polling (2026-10-21)
Status polling every 5 s (SSE optional later). The invoice id is the capability (UUIDv7, 74 random bits) and pages are
rate-limited (60/min/IP). Signed return parameters on success/cancel redirects arrive with webhook secrets (M6).

## D-046 Payment links create invoices via POST (2026-10-21)
`GET /pay/:id` shows the offer; `POST /pay/:id` creates the invoice. Link unfurlers and prefetchers cannot burn addresses.
Per-link `max_pending_invoices` (default 20) bounds the derivation gap; 5 creations / 10 min / IP.

## D-047 Worker process uses BullMQ job schedulers (2026-10-21)
`expire-invoices` every 15 s. Handlers are idempotent and concurrency-safe (`FOR UPDATE SKIP LOCKED`), so several workers
can run without leader election.

## D-048 Illegal-transition audit is written without awaiting (2026-10-21)
The caller's transaction may hold the audit-chain advisory lock and is about to roll back; awaiting a second connection
would deadlock. The audit row lands immediately after the rollback; failures are logged.

## D-023 Log redaction by key name, plus value patterns for API keys and extended private keys (2026-10-20)
Hex strings are never value-redacted: tx hashes and raw private keys share a format, so private keys are protected
by never holding them outside the signer and by key-name rules. API never accepts secrets in query strings
(request logs include the URL).

## D-049 Dashboard test/live mode is per request, not per session (2026-10-21)
Each dashboard call carries `livemode` (query or body). One login sees both modes; switching remounts the page so no
state crosses modes. The API key, not the session, decides the mode on the merchant API.

## D-050 Minimal xpub registration pulled into M3b from M8 (2026-10-21)
Without it a non-custodial merchant cannot create any invoice. Flow: preview the first 5 addresses, merchant confirms they
match the wallet, then register with a fresh TOTP (`custody:manage`, owner only). Registering retires the previous active
xpub in the same transaction. The full xpub is never returned (hint, fingerprint and first address identify it). Ownership
proof and gap tooling stay in M8.

## D-051 Webhook endpoint configuration ships in M3b; delivery in M6 (2026-10-21)
Secret `whsec_` + 40 base62, envelope-encrypted with AAD bound to the row id, shown once. Creation needs a fresh TOTP.
Max 16 endpoints per mode. Hard delete for now; revisit when M6 delivery rows reference endpoints. URL rules = redirect URLs
(https only in production); the SSRF guard runs at delivery time (M6), where DNS is resolved.

## D-052 Team management moves to M10 (amends D-032) (2026-10-21)
Invites need email delivery, which ships in M10. The owner can run the account alone in the MVP; RBAC is enforced and tested.

## D-053 Dashboard: Vite + React, no router, served by nginx (2026-10-21)
Hash routes (five pages) instead of a router library. Vite's built-in JSX transform, no React plugin (no Fast Refresh).
Production image: static files + reverse proxy for `/v1/dashboard/*` only, strict CSP (no inline script or style).
Dev: Vite's proxy gives the same single-origin setup. nginx (`nginx-unprivileged`, non-root) over Caddy: the newest
Caddy build old enough to adopt still shipped a Go stdlib with HIGH CVEs (trivy gate); nginx follows Alpine patches.

## D-054 Dashboard invoice creation has no Idempotency-Key (2026-10-21)
A person clicking a button, not a retrying backend. Audited as `invoice.created` with the user as actor.

## D-055 Scanner filters getLogs by recipient; no in-memory address set (amends D-016) (2026-10-21)
Each tick reads the watched addresses (`watch_until > now`) from Postgres and asks the RPC only for Transfers of the
invoice's token TO those addresses (topic OR-lists of 100). Watching all USDT transfers on BSC would mean tens of thousands
of logs per tick. Range and recipient are re-checked locally. Revisit when one chain has more than ~50k watched addresses.

## D-056 Reorg handling = rescan window + re-verification, no block table (2026-10-21)
Every tick rescans the last `reorgDepth` blocks (finds transfers re-mined in replacement blocks) and re-checks each
unconfirmed payment: block hash still canonical, else follow the receipt (moved) or orphan it. Orphans are re-checked for
24 h, so a flaky RPC view cannot lose a payment. Confirmation needs a fresh receipt re-check in a later tick than detection.
A cursor block replaced beyond `reorgDepth` is logged as DEEP REORG (operator action, see RUNBOOK).

## D-057 Expiry waits for the scanner; lateness is by block time (2026-10-21)
The expiry job expires a pending invoice only once its chain's cursor block time has passed `expires_at`: a payment mined
in time is always recorded first, even if the watcher was down. A pending invoice whose payments all sit in blocks
timestamped after the deadline is expired by the watcher and becomes `late_payment` on confirmation.

## D-058 What the watcher credits (2026-10-21)
Only transfers of the invoice's own token, at or above the token's dust threshold, to the invoice's deposit address.
Required confirmations use the tier of max(payment, invoice amount). Payments after `paid`/`overpaid` are recorded, not
acted on (manual resolution, M5b). Other tokens sent to a deposit address are not recorded (recovery is a custodial M7
concern). First leadership starts at head - reorgDepth: no history backfill.
