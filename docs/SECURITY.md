# Security

> **An independent security audit is required before any mainnet funds flow through this system.**

## Money-critical files (mandatory human review)

Every file with a `// MONEY-CRITICAL` header is listed here and in the coverage gate in `vitest.config.ts` (≥90%).

| File | Purpose | Since |
|---|---|---|
| `packages/core/src/money.ts` | decimal string ↔ bigint minor units | M0 |

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
| Fake token / spoofed Transfer log | Credit only logs emitted by allowlisted contract address; receipt status checked; log re-verified at confirmation | planned | M4 |
| Reorg double-credit | Block-hash ring per chain; unique `(chain_id, tx_hash, log_index)`; credit only after finality + confirmations | planned | M4 |
| Lying RPC | Multi-provider failover; quorum of two providers above value threshold; fresh re-verify at confirmation | planned | M4 |
| Webhook spoof (merchant side) | HMAC-SHA256 over `timestamp.rawBody`; constant-time compare; verification snippets | planned | M6 |
| Webhook replay | Timestamp skew > 5 min rejected; stable event id for dedup | planned | M6 |
| SSRF via webhook URL | Block private/loopback/link-local/metadata ranges; IP pinned at connect (DNS rebinding); no redirects; size + time caps | planned | M6 |
| Insider misuse | RBAC; two-person approval above threshold; hash-chained audit log; DB roles without UPDATE/DELETE on ledger/audit | planned | M1/M5/M7 |
| Key theft | Seed only in signer; signer caps + allowlist; hot wallet cap; cold multisig | planned | M7 |
| Dust / address poisoning | Ignore below `min_amount`; never display unsolicited transfers | planned | M4 |
| Invoice / index race | Atomic index allocation; unique `(chain, address)`; idempotency keys | planned | M2/M3 |
| Scanner DoS (log volume) | Adaptive chunking; in-memory address set; lag alerts | planned | M4 |
| Xpub substitution | 2FA + email + cooldown on change; ownership signature at `0/0`; audit + alert | planned | M8 |
| Private key submitted as xpub | Detect xprv/tprv/WIF/hex/mnemonic; refuse, never store, security event | planned | M8 |
| Widget postMessage spoofing | Origin verification both directions | planned | M10 |
| API key leak | Hash-only storage; prefix lookup; scopes; IP allowlist; revocation; last-used tracking; value-pattern log redaction | partial: log redaction (`apps/server/test/logger.test.ts`) | M0/M1 |
| Cross-tenant access (IDOR) | Repository scoping + Postgres RLS; cross-tenant test on every endpoint | planned | M1/M9 |
| Secret leakage via logs | Key-name + value-pattern redaction in logger; config errors print key names only | `logger.test.ts`, `config.test.ts` | M0 |
| Error detail leakage | Unknown errors → generic 500 `internal_error`; full error only in server logs | `app.test.ts` | M0 |
| Log injection via request id | Caller request id accepted only if `[A-Za-z0-9._-]{8,128}` | `app.test.ts` | M0 |
| Float money bugs | bigint only; lint bans `parseFloat`, `Number.parseFloat`, `.toFixed` | `money.test.ts` + eslint | M0 |

## Rules

- Never log secrets, private keys, mnemonics, full API keys, or webhook secrets. The logger redacts by key name and by value pattern (`sk_*`, `pk_*`, extended private keys).
- The API never accepts secrets in query strings: request logs include the URL.
- Env is validated at boot; the process exits on invalid config. Only `.env.example` is committed.
- Containers run as non-root with read-only filesystems, `no-new-privileges`, and all capabilities dropped.
- CI: lint, typecheck, tests with coverage gate, `pnpm audit`, gitleaks, semgrep, trivy (fs + image).

## Key management

Key ceremony, backup, rotation, recovery and the multisig/cold-wallet treasury policy are written in M7, after the KMS
decision (D-010). Non-custodial mode (M8) involves no private keys.
