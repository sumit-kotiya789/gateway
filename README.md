# Gateway

Crypto payment gateway. Phase 1: USDT (BEP-20) on BSC mainnet and testnet. Non-custodial (merchant xpub) first;
custodial mode behind a feature flag.

> Not ready for mainnet funds. An independent security audit is required first. See `docs/SECURITY.md`.

## Requirements
Node 22+, pnpm 10 (`corepack enable`), Docker.

## Quick start
```sh
corepack enable
pnpm install
cp .env.example .env        # set dev passwords; generate JWT_SECRET, ADMIN_JWT_SECRET, API_KEY_PEPPER, DATA_KEK
docker compose up --build   # postgres, redis, mailpit, migrate (one-shot), api on :3000, watcher on BSC testnet
pnpm admin:create you@example.com superadmin   # first admin (prints password + TOTP URI once)
```
Emails (verification, password reset, notices) land in Mailpit: http://localhost:8025.
Custodial mode (M7) adds the signer: `docker compose --profile custodial up` (setup: `docs/RUNBOOK.md`, "Custody setup").

## Test network: BSC testnet + sastaUSDT
Test mode uses BSC testnet; live mode uses BSC mainnet (D-096). One-time token setup:
1. Make a new throwaway wallet, fund it with tBNB (https://www.bnbchain.org/en/testnet-faucet), put its private key
   in `.env` as `BSC_TESTNET_DEPLOYER_KEY` (testnet only; never a key with real funds).
2. `pnpm testnet:token deploy`, then copy the printed `BSC_TESTNET_USDT_ADDRESS` into `.env`.
3. `pnpm db:seed`, then `docker compose restart watcher worker`.
4. Pay a test invoice: `pnpm testnet:token pay <deposit-address> <amount>`.

### Wallet-address merchants (forwarder mode, D-097)
Merchants without an xpub enter a plain wallet address: each invoice gets its own CREATE2 forwarder address and the
funds are forwarded to the wallet automatically, fee split on-chain (`docs/CUSTODY.md`). Testnet setup:
`pnpm forwarder:deploy` (factory into `.env`, then `pnpm db:seed`), signer seed + `pnpm platform:register` with a
`fee_wallets` entry, fund the signer gas wallet (`pnpm testnet:token send-bnb <gas-wallet> 0.05`),
`FEATURE_FORWARDER=true`, `docker compose --profile forwarder up -d --build`. Details: `docs/RUNBOOK.md`.

### Web3 projects: deposits per user, payouts, website and demo (D-100..D-102)
Each user of a merchant's app gets a permanent deposit address (`POST /v1/deposit-accounts`); with custody on the app
also pays users out (`POST /v1/payouts`, within the merchant's own limits). Local URLs:
| URL | What |
|---|---|
| http://localhost:8080 | merchant dashboard |
| http://localhost:8081/admin/ | admin console |
| http://localhost:8082 | public site: product, pricing, developer docs (`apps/website`) |
| http://localhost:8083 | demo game wallet (`apps/demo`, profile `demo`): set `DEMO_API_KEY` (test key with `read`, `invoices:write`, `payouts:write`), then `docker compose --profile demo up -d --build demo` |

## Scripts
| Script | Does |
|---|---|
| `pnpm dev` | api with reload (reads `.env`) |
| `pnpm migrate` | apply migrations as the schema owner (`DATABASE_MIGRATION_URL`) |
| `pnpm admin:create <email> <role>` | bootstrap an admin |
| `pnpm platform:register <file>` | register custody keys printed by the signer's `init-seed` (custodial, M7) |
| `pnpm testnet:token <cmd>` | BSC testnet sastaUSDT: `address`, `deploy`, `mint`, `pay`, `balance`, `send-bnb` (key from `.env`) |
| `pnpm forwarder:deploy` | deploy the ForwarderFactory on BSC testnet (D-097) |
| `pnpm contracts:test` | Solidity tests (forwarder contracts) via the Foundry image |
| `pnpm test` / `pnpm test:coverage` | unit + integration (integration needs Docker); coverage gate on money-critical files |
| `pnpm test:unit` / `pnpm test:integration` | one project only |
| `pnpm lint` | eslint (type-aware, bans float money helpers) |
| `pnpm typecheck` | tsc strict on every package |
| `pnpm audit` | dependency audit, fails on high/critical |
| `pnpm build` | esbuild bundles (api + CLIs) |

## Docs
`docs/ARCHITECTURE.md`, `SECURITY.md`, `API.md`, `CUSTODY.md`, `DECISIONS.md`, `RUNBOOK.md`, `INTEGRATION.md`,
`ADDING_CHAIN_OR_TOKEN.md`, `LAUNCH_CHECKLIST.md`.
