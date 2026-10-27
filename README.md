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
docker compose up --build   # postgres, redis, anvil, mailpit, migrate (one-shot), api on :3000
pnpm admin:create you@example.com superadmin   # first admin (prints password + TOTP URI once)
```
Emails (verification, password reset, notices) land in Mailpit: http://localhost:8025.

## Scripts
| Script | Does |
|---|---|
| `pnpm dev` | api with reload (reads `.env`) |
| `pnpm migrate` | apply migrations as the schema owner (`DATABASE_MIGRATION_URL`) |
| `pnpm admin:create <email> <role>` | bootstrap an admin |
| `pnpm platform:register <file>` | register custody keys printed by the signer's `init-seed` (custodial, M7) |
| `pnpm test` / `pnpm test:coverage` | unit + integration (integration needs Docker); coverage gate on money-critical files |
| `pnpm test:unit` / `pnpm test:integration` | one project only |
| `pnpm lint` | eslint (type-aware, bans float money helpers) |
| `pnpm typecheck` | tsc strict on every package |
| `pnpm audit` | dependency audit, fails on high/critical |
| `pnpm build` | esbuild bundles (api + CLIs) |

## Docs
`docs/ARCHITECTURE.md`, `SECURITY.md`, `API.md`, `CUSTODY.md`, `DECISIONS.md`, `RUNBOOK.md`, `INTEGRATION.md`,
`ADDING_CHAIN_OR_TOKEN.md`, `LAUNCH_CHECKLIST.md`.
