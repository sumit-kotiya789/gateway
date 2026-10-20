# Mainnet launch checklist

Every item needs an owner and a date before launch.

## Blocking
- [ ] Independent security audit completed; findings resolved or accepted in writing
- [ ] Human review of every file in SECURITY.md "Money-critical files"
- [ ] Token contract addresses verified against issuer + explorer; startup `decimals()` check passing
- [ ] Custodial feature flag OFF unless legal clearance for custodial operation is documented
- [ ] Node upgraded to 24 LTS (D-004)
- [ ] GitHub Actions pinned by commit SHA (D-021)
- [ ] Container base images pinned by digest
- [ ] Backups + PITR configured and a restore tested
- [ ] Alerts wired and test-fired (scanner lag, reconciliation, webhook failures, RPC disagreement)
- [ ] Runbook procedures rehearsed
- [ ] Secrets in secret manager; none in env files on hosts
- [ ] TLS, HSTS, CORS allowlist, CSP verified in production config

## Custodial only (M7)
- [ ] KMS decision implemented (D-010); key ceremony performed and recorded
- [ ] Hot wallet cap, signer caps, kill switch tested in production config
- [ ] Cold wallet multisig set up, signers documented
