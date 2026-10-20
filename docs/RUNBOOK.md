# Runbook

Each procedure is written when the component it covers ships. Headings are fixed so alerts can link to them.

## Process health
- `GET /healthz` returns `{"status":"ok"}` when the api process is serving.
- Processes exit non-zero on invalid configuration; the error names the bad keys (never values).
- On SIGTERM/SIGINT the api stops accepting connections, drains, and exits; forced exit after 10 s.

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
