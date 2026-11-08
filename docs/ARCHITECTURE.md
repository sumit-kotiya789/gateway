# Architecture

Modular monolith, four processes, one Postgres, one Redis.

| Process | Image | Exposure | Holds keys |
|---|---|---|---|
| api | `apps/server` | public (behind TLS proxy) | no (xpubs only) |
| worker | `apps/server` | none | no |
| watcher | `apps/server` | none | no |
| signer | `apps/signer` | mTLS from worker only | yes (custodial only, M7) |

```mermaid
flowchart LR
  subgraph Clients
    M[Merchant backend]
    C[Customer browser]
    D[Dashboard SPA]
    A[Admin console]
  end
  API[api]
  WK[worker]
  WT[watcher]
  SG[signer]
  KS[(Sealed seed + KEK file)]
  PG[(PostgreSQL)]
  RD[(Redis)]
  RPC[[RPC providers]]
  MH[[Merchant webhooks]]
  M --> API
  C --> API
  D --> API
  A --> API
  API --> PG
  API --> RD
  WT --> RPC
  WT --> PG
  WK --> PG
  WK --> RD
  WK --> MH
  WK --> SG
  WK --> RPC
  SG --> KS
  SG --> PG
```

## Layout

```
packages/core     pure domain: money, errors, state machine, fee math, interfaces, zod schemas. No IO.
apps/server       api / worker / watcher entrypoints, modules, migrations, tests
apps/signer       isolated signing service (M7b, D-088): own process, own DB role, intents only
apps/dashboard    merchant dashboard, Vite + React SPA (M3b)
apps/admin        admin console, Vite + React SPA, separate origin + auth domain (M5b)
integrations/     WooCommerce plugin (PHP, M10, D-093)
docs/             this folder
```

## High availability (M11)

Postgres is the only durable state. Redis holds rate-limit counters and BullMQ queues; schedulers are re-registered
when a worker starts. Payments live on chain: a watcher outage delays crediting, never loses a payment (it rescans
from its cursor, D-057).

| Component | Run | When it fails |
|---|---|---|
| api | 2+ behind the TLS proxy, stateless | proxy routes around it. Redis down: rate limits fail open (D-031), the rest works |
| worker | 2+ | the others carry on: webhook and email batches are claimed with `SKIP LOCKED`, BullMQ runs each scheduled job once |
| watcher | 2 per chain, different hosts | advisory-lock leader + standby; the standby takes over within ~5 s, the fencing epoch blocks a stale leader's writes (D-017) |
| signer | 1 active; cold standby host with the sealed seed, KEK in the secret manager | sweeps and withdrawals wait (never fail) and resume; incoming payments are unaffected. Do not run two: same safety (per-sender lock), twice the key exposure |
| Postgres | primary + one synchronous streaming replica + WAL archive (PITR) | promote the replica, repoint `DATABASE_URL`, restart processes (RUNBOOK "DB restore" if data was lost) |
| Redis | one, AOF on | queues and limits rebuilt; nothing lost that Postgres does not hold |
| RPC | 3 providers per mainnet chain | failover for scanning; 2 of them must agree to confirm (D-092) |

Targets: RPO 0 for committed money writes (synchronous replica), minutes from WAL archive alone; RTO 30 min with a
manual failover. Automate failover (e.g. Patroni) only if on-call cannot meet that.

## Milestones

MVP (in order): M0 → M1 → M2 → M3 → M3b → M4 → M5 → M5b → M6 → M8. Pause after M8 for owner review.

| # | Scope |
|---|---|
| M0 | Scaffold, CI, config validation, logger, error model, docs |
| M1 | DB schema + migrations, merchants, auth, API keys, RBAC, 2FA, audit log, rate limiting |
| M2 | Chain/token registry, EVM adapter, HD + xpub derivation, custody strategy layer, address allocation |
| M3 | Invoices, state machine, idempotency, expiry, hosted checkout, payment links |
| M3b | Minimal merchant dashboard: login, 2FA, API keys, invoices, webhooks, xpub, test/live toggle |
| M4 | Watcher: scanner, cursors, reorg handling, confirmations, matching, leader election |
| M5 | Ledger, fees, balances, outbox, reconciliation |
| M5b | Minimal admin console: merchants, kill switches, audit log, risk flags, manual resolve underpaid/late |
| M6 | Webhooks: signing, retries, SSRF guard, replay, secret rotation |
| M8 | Non-custodial xpub mode: xpub management, fee models, derivation visibility |
| M7 | Custodial settlement: ledger, signer, sweeps, withdrawals, treasury, kill switch (built; feature flag off; seed KEK from a secret-manager file, no KMS) |
| M9 | Platform/sub-merchant mode, admin API completion, risk hooks, metrics, alerts |
| M10 | Full dashboard, reports/exports, emails, widget, SDKs, WooCommerce plugin |
| M11 | Hardening: security, chaos, load tests, HA doc, runbook, launch checklist |
| M12 | Forwarder custody mode (stretch, experimental) |

## Rules

- Core depends on interfaces only (`ChainAdapter`, `AddressDeriver`, `Signer`, `CustodyStrategy`). Chains and tokens are registry rows, not code.
- Money is `bigint` minor units in code and `NUMERIC(78,0)` in the DB. Decimal strings exist only at the API edge (`toMinorUnits` / `fromMinorUnits`).
- Payment confirmation is one DB transaction: invoice + payment + ledger + outbox event.
- Errors: every non-2xx response is `{ error: { code, message, details?, request_id } }`. Codes live in `packages/core/src/errors.ts`.
- Every response carries `x-request-id`. A caller-supplied id is honored only if it matches `[A-Za-z0-9._-]{8,128}`.

## Invoice state machine

```mermaid
stateDiagram-v2
  [*] --> created
  created --> pending
  created --> failed
  pending --> detected
  pending --> expired
  pending --> cancelled
  detected --> confirming
  detected --> pending: reorg
  confirming --> pending: reorg
  confirming --> held: risk rule (D-094)
  held --> paid: admin release
  held --> failed: admin reject
  confirming --> paid
  confirming --> underpaid
  confirming --> overpaid
  underpaid --> detected: top-up
  underpaid --> paid: merchant accepts
  underpaid --> partially_paid: deadline (custodial)
  paid --> settled
  overpaid --> settled
  expired --> late_payment
  cancelled --> late_payment
```

`settled` means: custodial, sweep confirmed and merchant balance moved from pending to available; non-custodial, platform fee charged.
`partially_paid` (custodial only, final): the deadline passed while underpaid; what arrived was swept and credited, minus its fee.
