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
cp .env.example .env        # set dev passwords
pnpm dev                    # api on http://localhost:3000/healthz
docker compose up --build   # api + postgres + redis + anvil + mailpit
```

## Scripts
| Script | Does |
|---|---|
| `pnpm dev` | api with reload |
| `pnpm test` / `pnpm test:coverage` | unit + integration tests (coverage gate on money-critical files) |
| `pnpm lint` | eslint (type-aware, bans float money helpers) |
| `pnpm typecheck` | tsc strict on every package |
| `pnpm audit` | dependency audit, fails on high/critical |
| `pnpm build` | esbuild bundles per app |

## Docs
`docs/ARCHITECTURE.md`, `SECURITY.md`, `API.md`, `CUSTODY.md`, `DECISIONS.md`, `RUNBOOK.md`, `INTEGRATION.md`,
`ADDING_CHAIN_OR_TOKEN.md`, `LAUNCH_CHECKLIST.md`.
