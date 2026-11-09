# Mainnet launch checklist

Every item needs an owner and a date before launch.

## Blocking
- [ ] Independent security audit completed; findings resolved or accepted in writing
- [ ] Human review of every file in SECURITY.md "Money-critical files"
- [ ] Token contract addresses verified against issuer + explorer; `pnpm chains:verify` passing in production config
- [ ] At least two independent mainnet RPC providers configured (`BSC_RPC_URL` + public fallback), each verified; confirmation needs two to agree (D-092), so a third is advised
- [ ] `bsc` chain enabled deliberately (seeded disabled, D-036)
- [ ] Custodial feature flag OFF unless legal clearance for custodial operation is documented
- [x] Node upgraded to 24 LTS (D-004; images and CI, 2026-11-06)
- [x] GitHub Actions pinned by commit SHA (D-021)
- [x] Container base images pinned by digest (Dockerfiles, compose postgres/redis, CI scanners)
- [ ] Backups + PITR configured and a restore tested
- [ ] Alerts wired and test-fired (`METRICS_TOKEN` set, Prometheus loads `infra/prometheus/alerts.yml`, Alertmanager routes to on-call)
- [ ] Load test on staging at 2× expected peak (`scripts/load-test.mjs`, RUNBOOK "Load test"); results recorded
- [ ] Failover drill: kill a watcher leader, an api and a worker; promote the Postgres replica (ARCHITECTURE "High availability")
- [ ] Runbook procedures rehearsed
- [ ] Secrets in secret manager; none in env files on hosts
- [ ] TLS, HSTS, Origin allowlists, CSP verified in production config
- [ ] `TRUST_PROXY_HOPS` matches the real proxy chain (wrong value = spoofable client IPs)
- [ ] Audit-chain anchoring: latest `(seq, hash)` exported to write-once storage on a schedule
- [ ] `DATA_KEK` held in the secret manager (or KMS provider implemented); KEK rotation rehearsed
- [ ] `SMTP_URL` points at a real relay; sending domain has SPF, DKIM and DMARC; a test verification and reset email arrive (not in spam)
- [ ] `DASHBOARD_URL` is the public https dashboard origin
- [ ] Signup decision: email verification is live (M10, D-077), or sign-ups off (Settings, or `SIGNUP_ENABLED=false`)
- [ ] App DB user is a member of `gw_app` only; owner credentials used by migrations only
- [ ] Admin IP allowlist on (Settings) and/or `ADMIN_IP_ALLOWLIST` set (VPN / office ranges); `TRUST_PROXY_HOPS` right (Settings shows your public IP)
- [ ] Fee model per merchant agreed and set (rate, fixed, grace); prepaid top-up process (how merchants pay, who records) agreed (D-076)

## Custodial only (M7)
- [ ] Legal clearance for holding customer funds (licence where required) documented
- [ ] Seed KEK in the secret manager, delivered as `SIGNER_SEED_KEK_FILE` on tmpfs (no KMS, D-010); key ceremony performed and recorded; mnemonic backup offline
- [ ] Signer on its own host: own DB login in `gw_signer`, mTLS certificates for signer and worker, `SIGNER_HMAC_SECRET` rotated from dev
- [ ] `SIGNER_LIMITS` set per live token (per transaction, per 24 h) and reviewed; `SIGNER_MAX_GAS_PRICE_GWEI` / `SIGNER_MAX_GAS_TOPUP` reviewed
- [ ] Cold wallet multisig set up, signers documented; address registered (`platform:register`) and in `SIGNER_COLD_ADDRESSES`
- [ ] Gas wallet funded and a low-balance alert agreed; hot wallet cap set in `infra/prometheus/alerts.yml`
- [ ] Hot wallet limits set per live token (admin console, D-105): cap and alert level agreed; `SIGNER_AUTO_TO_COLD` decided and documented; low-balance email received in a drill
- [ ] `WITHDRAWAL_TWO_PERSON_MIN` (ceiling) and the Settings threshold agreed; at least two superadmins and two operators for approvals
- [ ] Payout fee per merchant agreed (covers payout gas); merchants told that live user payouts need their limits (D-100)

## Wallet-address (forwarder) mode only (M12)
- [ ] Forwarder contracts audited; findings resolved
- [ ] `ForwarderFactory` deployed on BSC mainnet (`BSC_FORWARDER_FACTORY`), code hash verified (`pnpm chains:verify`)
- [ ] Live fee wallet registered (`platform:register`, `fee_wallets`) and its keys held outside the platform
- [ ] Signer gas wallet funded for flushes; `SIGNER_MAX_FORWARDS_PER_DAY` / `SIGNER_MAX_FORWARD_GAS` reviewed
- [ ] Drill: pause and resume the signer, a sweep, a withdrawal, a hot → cold transfer and a recorded refill on mainnet with small amounts
