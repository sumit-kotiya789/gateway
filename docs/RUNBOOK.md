# Runbook

Each procedure is written when the component it covers ships. Headings are fixed so alerts can link to them.

## Process health
- `GET /healthz` returns `{"status":"ok"}` when the api process is serving.
- Processes exit non-zero on invalid configuration; the error names the bad keys (never values).
- On SIGTERM/SIGINT the api stops accepting connections, drains, and exits; forced exit after 10 s.

## Metrics and alerts
- Set `METRICS_TOKEN` (32+ random characters) and scrape `GET /metrics` on the api's internal listener with
  `Authorization: Bearer <token>` (`infra/prometheus/prometheus.example.yml`). Never route `/metrics` through the public edge.
- Alert rules: `infra/prometheus/alerts.yml`; each links to a heading in this runbook. Health gauges (scanner, worker,
  reconciliation, webhooks, email) are read from the database, so scraping one api process covers every process.
- `NaN` for `gw_scanner_cursor_age_seconds` = an enabled chain no watcher has scanned yet.
- Not covered yet: RPC provider disagreement (needs the quorum check, D-085), audit-chain verification (run
  `select audit_verify();` on a schedule).

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
Every further admin is managed by a superadmin in the admin console (Admins page, TOTP): create, change role, disable,
re-enable, reset credentials (lost phone or leaked password: also signs the admin out everywhere). Credentials are shown
once; hand them over in person or through the password manager. Keep at least two superadmins so one can recover the
other; the last active superadmin cannot be disabled or demoted (API check + DB trigger).

## Verify audit log integrity
As the owner or app role: `select audit_verify();` returns NULL when the chain is intact, otherwise the first bad `seq`.
A non-NULL result is a security incident: freeze admin access, preserve the DB snapshot, investigate from that `seq`.

## Team
- Members, roles and invitations: dashboard → Team (owner/admin, TOTP). A removed member is signed out at once; their
  open access token lapses within 10 minutes. Their API keys stay: revoke them under API keys if they had the secret.
- "The merchant must keep at least one owner": promote someone to owner first, then change or remove the old owner.

## Merchant locked out
Lockout clears itself (15 min, doubling, max 24 h). Lost 2FA device: user signs in with a recovery code. Without recovery
codes: verify the user's identity out of band, then admin console, merchant, Users, Reset 2FA (operator + TOTP). It revokes
the user's sessions and recovery codes; the user signs in with the password and must re-enroll 2FA.

## Worker
- `main-worker.cjs` (compose service `worker`) runs BullMQ schedulers. M3: `expire-invoices` every 15 s.
- M8: `apply-xpub-changes` every minute (live xpub changes whose 24 h cooldown elapsed).
- M10: `send-emails` every 5 s on its own `emails` queue.
- Several workers may run; jobs are idempotent and use `SKIP LOCKED`.
- Pending invoices past `expires_at` that are still `pending` = worker down or Redis unavailable. Check `docker compose logs worker`.

## Email
- The worker's `emails` queue sends the `email_outbox` every 5 s. Dev: open Mailpit at http://localhost:8025.
- Stuck emails: `select kind, status, attempts, last_error, next_attempt_at from email_outbox where status <> 'sent' order by created_at desc limit 50;`
  `last_error` holds an error code (e.g. `ECONNREFUSED`, `EAUTH`): check `SMTP_URL` and the relay. Failed rows are
  final (payload erased); the user can request a new link (Resend / Forgot password).
- Links point at `DASHBOARD_URL`; a wrong value sends users to the wrong host.

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

## Fees and prepaid top-ups
- Live invoices need a prepaid fee balance per token (D-076). A merchant hitting `402 insufficient_fee_balance` has used
  it up: they pay the platform, then an operator records the top-up (Admin console → merchant → Prepaid fee top-ups:
  token id, amount, reference, TOTP). Only record money that has arrived; top-ups cannot be edited or removed. A wrong
  entry is corrected by a decision with finance, not by editing rows (append-only, DB-enforced).
- Fee rate, fixed fee and grace: merchant page → Fees (TOTP). Changes apply to invoices created afterwards.
- Reconciliation check `topup_journal` flags a top-up whose ledger booking is missing or wrong.

## Wrong merchant xpub registered
New invoices derive from the active xpub. The owner registers the correct xpub (Payout wallet page, needs TOTP and,
for live, a signature from the wallet; a live replacement takes effect after 24 h, D-075); the wrong one is retired,
never deleted. Invoices already issued on the wrong key keep their addresses: find them
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
## Custody setup (M7)
Custodial mode is off unless `FEATURE_CUSTODIAL=true`, which also needs `SIGNER_URL` + `SIGNER_HMAC_SECRET`.
1. Signer (its own host, its own DB login in `gw_signer`: `CREATE ROLE gateway_signer LOGIN PASSWORD '…' IN ROLE gw_signer;`).
   Dev/test: `pnpm --filter @gw/signer init-seed > custody.json` (add `--show-mnemonic` once, for the offline backup).
   Production: refused until a KMS seed source exists (D-010).
2. `pnpm platform:register custody.json`: deposit xpubs and hot/gas wallets. It refuses to replace different keys.
3. Fund each gas wallet with a little native coin (BNB): it pays the network fee of every sweep.
4. Set `SIGNER_LIMITS` per token before any payout (tokens without limits cannot be paid out).

## Stuck transaction (M7)
- Sweeps: `select id, status, attempts, last_error, gas_tx_hash, tx_hash, next_attempt_at from sweeps where status in ('pending','gas_sent','sweep_sent') order by created_at;`
  - `last_error = paused`: the signer is paused (env `SIGNER_PAUSED` or admin kill switch). Expected during a drill.
  - `gas_price_too_high`: network fees are above `SIGNER_MAX_GAS_PRICE_GWEI`; it resumes when they drop.
  - `needs_gas` after a top-up was mined: fees rose since; wait, or raise `SIGNER_MAX_GAS_TOPUP` carefully.
  - Gas wallet empty: top-ups fail at broadcast (`insufficient funds` in the worker log). Fund the gas wallet.
  - `gas_sent`/`sweep_sent` for long: the worker rebroadcasts the same signed bytes every 15 s. If the RPC dropped
    it for a too-low fee, it stays stuck: a replacement at the same nonce is a manual, two-person operation.
- `status = failed`, `last_error = sweep_reverted`: the next round plans a new sweep automatically. Any other failed
  sweep (`over_booked`, `not_our_address`, `wrong_destination`, `wallet_mismatch`) is an incident: data and keys
  disagree. Pause the signer and investigate before anything else moves.
## Withdrawals (M7)
- Approval queue: admin console → Withdrawals (or `GET /admin/v1/withdrawals`). Check the merchant, the amount
  against its history, and that the payout address was not changed recently (dashboard audit log) before approving.
- Approved but not sent: `select id, status, attempts, last_error, next_attempt_at from withdrawals where status = 'approved';`
  `over_limit` / `no_limits`: `SIGNER_LIMITS` (24 h window; raise it in the signer's config only after review).
  `insufficient_funds` / `needs_gas`: refill the hot wallet from cold (two signers) or fund it with BNB.
  `paused`: the signer is paused.
- Failed with `payout_address_changed`, `merchant_inactive`, `payouts_frozen`: released automatically; the merchant
  requests again if appropriate.

## Hot wallet compromise (M7)
## Emergency kill switch (M7)
## Key rotation
- Webhook secrets: the merchant rotates in the dashboard (TOTP). The old secret keeps signing for 0-72 h. A leaked secret:
  rotate with "expire it now". Secrets are envelope-encrypted with `DATA_KEK`; KEK rotation re-wraps data keys (M11).
- Signer keys: M7.
## Mass refund (M7)
## DB restore (M11)
