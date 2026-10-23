# Runbook

Each procedure is written when the component it covers ships. Headings are fixed so alerts can link to them.

## Process health
- `GET /healthz` returns `{"status":"ok"}` when the api process is serving.
- Processes exit non-zero on invalid configuration; the error names the bad keys (never values).
- On SIGTERM/SIGINT the api stops accepting connections, drains, and exits; forced exit after 10 s.

## Database roles and migrations
- Migrations run as the schema owner: `DATABASE_MIGRATION_URL=… pnpm migrate` (compose: the one-shot `migrate` service runs before `api`).
- The app connects as a LOGIN user that is a member of `gw_app` (never the owner). New environment:
  `CREATE ROLE gateway_app LOGIN PASSWORD '…' IN ROLE gw_app;` (after the first migration created `gw_app`, or pre-create it as `infra/postgres/init-roles.sh` does).
- Read-only reporting users: `GRANT gw_readonly TO <user>`.

## Chain / token registry
- `pnpm db:seed`: idempotent upsert of chains and tokens. Never re-enables a chain or token an operator disabled.
- `pnpm chains:verify`: for every enabled chain, each RPC must report the configured chain id, and every enabled token's
  on-chain `decimals()` must equal config. Non-zero exit = do not start watchers; fix config or RPC first.
- Disable a token or chain: `update tokens set enabled = false where id = …` (admin UI in M5b). Never delete.

## Bootstrap the first admin
`pnpm admin:create <email> superadmin` (compose: `docker compose run --rm api node cli/admin-create.cjs <email> superadmin`).
Prints a generated password and a TOTP enrollment URI once. Store the password in a password manager and enroll TOTP immediately.

## Verify audit log integrity
As the owner or app role: `select audit_verify();` returns NULL when the chain is intact, otherwise the first bad `seq`.
A non-NULL result is a security incident: freeze admin access, preserve the DB snapshot, investigate from that `seq`.

## Merchant locked out
Lockout clears itself (15 min, doubling, max 24 h). Lost 2FA device: user signs in with a recovery code. Without recovery
codes, an admin reset flow arrives with M5b; until then it is a manual, audited DB operation by two people.

## Worker
- `main-worker.cjs` (compose service `worker`) runs BullMQ schedulers. M3: `expire-invoices` every 15 s.
- Several workers may run; jobs are idempotent and use `SKIP LOCKED`.
- Pending invoices past `expires_at` that are still `pending` = worker down or Redis unavailable. Check `docker compose logs worker`.

## Dashboard
- Compose service `dashboard` (nginx) serves the SPA on :8080 (host port `DASHBOARD_HOST_PORT`) and proxies `/v1/dashboard/*` to the api. Put the TLS edge
  proxy in front of it; the dashboard origin must be listed in `DASHBOARD_ORIGINS` (exact scheme + host + port).
- The api sees nginx as an extra proxy hop: set `TRUST_PROXY_HOPS` to the real hop count (edge + nginx) or rate limits and
  audit IPs see the proxy address. Never set it higher than the real count (client IPs become spoofable).
- 403 `origin not allowed` on every POST = origin missing from `DASHBOARD_ORIGINS`.
- Dev without Docker for the SPA: `pnpm --filter @gw/dashboard dev` (http://localhost:5173, proxies to the api on :3000).

## Wrong merchant xpub registered
New invoices derive from the active xpub immediately. The owner registers the correct xpub (Payout wallet page, needs
TOTP); the wrong one is retired, never deleted. Invoices already issued on the wrong key keep their addresses: find them
with `select i.id, i.status from invoices i join deposit_addresses d on d.id = i.deposit_address_id where d.merchant_xpub_id = '<retired id>'`
and cancel any still `pending`. Funds already paid there are only spendable by whoever holds that key.

## Scanner stuck
- One watcher per chain leads (Postgres advisory lock `watcher:<chain>`); others wait. Several watcher processes are safe.
- Progress: `select chain_id, block_number, block_time, leader_epoch, updated_at from chain_cursors;`. `updated_at` older than a
  minute = stuck. Log line `scanner behind chain head` = catching up (500 blocks per tick).
- Pending invoices do not expire while a chain's scanner is stuck (cursor block time below their deadline). This is on
  purpose: a stuck watcher must not expire invoices that were paid on time.
- `registry verification failed; not scanning`: RPC reports another chain id or token decimals differ. Fix config/RPC; the
  watcher retries every minute.

## RPC outage
- Providers in `rpc_urls` are tried in order (failover). All down = ticks fail and are retried; nothing is credited from
  partial data. Payments are confirmed only after a receipt re-check, so a lying or lagging RPC cannot credit on its own.

## Deep reorg
Log line `DEEP REORG: cursor block replaced beyond reorgDepth` means a reorg deeper than configured. Confirmed payments are
final in the DB; check each payment confirmed in the affected range against an independent explorer:
`select id, invoice_id, tx_hash, block_number from payments where chain_id = '<chain>' and status = 'confirmed' and block_number >= <block>;`
Raise `chains.reorg_depth` / tiers for that chain. A credited payment that no longer exists on-chain is an incident (freeze
the merchant's payouts, M5b).

## Reconciliation mismatch
Worker job `reconcile-ledger` (hourly) logs `RECONCILIATION MISMATCH` with the failing checks and sample ids; every run is
kept: `select started_at, ok, issues from reconciliation_runs order by started_at desc limit 5;`.
- Treat any hit as an incident: freeze changes for the affected merchant, preserve a DB snapshot, check `audit_verify()`.
- `payment_without_journal` / `invoice_received` / `received_balance`: a payment and its booking disagree. Never edit
  ledger rows (they are append-only by design); corrections are new journals, written by code and reviewed by two people.
- `unsettled`: a paid non-custodial invoice was not settled; re-run settlement for it after finding why.

## Webhook backlog (M6)
## Stuck transaction (M7)
## Hot wallet compromise (M7)
## Emergency kill switch (M7)
## Key rotation (M6 webhook secrets, M7 signer keys)
## Mass refund (M7)
## DB restore (M11)
