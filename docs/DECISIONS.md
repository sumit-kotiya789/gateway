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

## D-023 Log redaction by key name, plus value patterns for API keys and extended private keys (2026-10-20)
Hex strings are never value-redacted: tx hashes and raw private keys share a format, so private keys are protected
by never holding them outside the signer and by key-name rules. API never accepts secrets in query strings
(request logs include the URL).
