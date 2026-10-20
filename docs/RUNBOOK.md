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

## Bootstrap the first admin
`pnpm admin:create <email> superadmin` (compose: `docker compose run --rm api node cli/admin-create.cjs <email> superadmin`).
Prints a generated password and a TOTP enrollment URI once. Store the password in a password manager and enroll TOTP immediately.

## Verify audit log integrity
As the owner or app role: `select audit_verify();` returns NULL when the chain is intact, otherwise the first bad `seq`.
A non-NULL result is a security incident: freeze admin access, preserve the DB snapshot, investigate from that `seq`.

## Merchant locked out
Lockout clears itself (15 min, doubling, max 24 h). Lost 2FA device: user signs in with a recovery code. Without recovery
codes, an admin reset flow arrives with M5b; until then it is a manual, audited DB operation by two people.

## Scanner stuck (M4)
## RPC outage (M4)
## Reconciliation mismatch (M5)
## Webhook backlog (M6)
## Stuck transaction (M7)
## Hot wallet compromise (M7)
## Emergency kill switch (M7)
## Key rotation (M6 webhook secrets, M7 signer keys)
## Mass refund (M7)
## DB restore (M11)
