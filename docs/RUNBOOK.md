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
- Disable a token or chain: admin console, Kill switches (reason required). Immediate for new invoices; restart the
  watchers to stop scanning a disabled chain. Re-enabling needs a superadmin + TOTP. Never delete registry rows.

## Bootstrap the first admin
`pnpm admin:create <email> superadmin` (compose: `docker compose run --rm api node cli/admin-create.cjs <email> superadmin`).
Prints a generated password and a TOTP enrollment URI once. Store the password in a password manager and enroll TOTP immediately.

## Verify audit log integrity
As the owner or app role: `select audit_verify();` returns NULL when the chain is intact, otherwise the first bad `seq`.
A non-NULL result is a security incident: freeze admin access, preserve the DB snapshot, investigate from that `seq`.

## Merchant locked out
Lockout clears itself (15 min, doubling, max 24 h). Lost 2FA device: user signs in with a recovery code. Without recovery
codes: verify the user's identity out of band, then admin console, merchant, Users, Reset 2FA (operator + TOTP). It revokes
the user's sessions and recovery codes; the user signs in with the password and must re-enroll 2FA.

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

## Admin console
- Compose service `admin` (nginx) serves the console at `/admin/` on :8080 (host port `ADMIN_HOST_PORT`, default 8081) and
  proxies `/admin/v1/*`. Its own origin, never the dashboard's (config refuses a shared origin); list it in `ADMIN_ORIGINS`.
  Restrict it at the edge (VPN / IP allowlist) and set `ADMIN_IP_ALLOWLIST` (non-listed IPs get 404).
- Underpaid / late-payment invoices: the Invoices page lists them; "Mark as paid" (operator + TOTP) books the fee and
  settles. Use it only when the merchant confirms they accept the funds; it cannot be undone.
- Suspend a merchant: immediate (API keys stop working, no new invoices). Reactivation needs TOTP.
- Dev: `pnpm --filter @gw/admin dev` (http://localhost:5174/admin/, proxies to the api on :3000).

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
Raise `chains.reorg_depth` / tiers for that chain. A credited payment that no longer exists on-chain is an incident (set the
merchant's `payouts_frozen` risk flag in the admin console; enforced on custodial payouts from M7).

## Reconciliation mismatch
Worker job `reconcile-ledger` (hourly) logs `RECONCILIATION MISMATCH` with the failing checks and sample ids; every run is
kept: `select started_at, ok, issues from reconciliation_runs order by started_at desc limit 5;`.
- Treat any hit as an incident: freeze changes for the affected merchant, preserve a DB snapshot, check `audit_verify()`.
- `payment_without_journal` / `invoice_received` / `received_balance`: a payment and its booking disagree. Never edit
  ledger rows (they are append-only by design); corrections are new journals, written by code and reviewed by two people.
- `unsettled`: a paid non-custodial invoice was not settled; re-run settlement for it after finding why.

## Webhook backlog
- Worker queue `webhooks` delivers every 5 s (up to 10 batches of 50 per run). Backlog:
  `select count(*), min(next_attempt_at) from webhook_deliveries where status = 'pending' and next_attempt_at <= now();`
  Growing = worker down, Redis down, or many slow endpoints (10 s timeout each, 10 in parallel). Add worker processes:
  claims are `SKIP LOCKED`.
- One merchant failing: `select endpoint_id, count(*), max(last_error) from webhook_deliveries where status <> 'succeeded'
  group by 1 order by 2 desc limit 20;`. Their endpoint is down or rejects the signature; deliveries fail after ~2.4 days.
  After they fix it, resend from the dashboard, or in bulk:
  `update webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now() where endpoint_id = '…' and status = 'failed';`
- `... resolves to a non-public address` = the URL points at a private network (SSRF guard). Expected; the merchant
  must use a public URL.
## Stuck transaction (M7)
## Hot wallet compromise (M7)
## Emergency kill switch (M7)
## Key rotation
- Webhook secrets: the merchant rotates in the dashboard (TOTP). The old secret keeps signing for 0-72 h. A leaked secret:
  rotate with "expire it now". Secrets are envelope-encrypted with `DATA_KEK`; KEK rotation re-wraps data keys (M11).
- Signer keys: M7.
## Mass refund (M7)
## DB restore (M11)
