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

## D-023 Log redaction by key name, plus value patterns for API keys and extended private keys (2026-10-20)
Hex strings are never value-redacted: tx hashes and raw private keys share a format, so private keys are protected
by never holding them outside the signer and by key-name rules. API never accepts secrets in query strings
(request logs include the URL).
