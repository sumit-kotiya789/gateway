# Adding a chain or token

Goal: a new token is config + seed only; a new chain family is config + seed + one adapter. Zero core changes.

## New token on an existing chain (planned procedure, proven in the extension step)
1. Verify the official contract address from the issuer and a block explorer. Record both sources in the seed file comment.
2. Confirm it is not fee-on-transfer or rebasing. If it is, do not allowlist it.
3. Add a row to the token seed: `chain_id, symbol, contract_address, decimals, min_confirmations, min_amount, enabled=false`.
4. Run seed. Startup check compares on-chain `decimals()` with config; mismatch refuses to start.
5. Enable on testnet, run the chain test suite, then enable on mainnet.

## New chain
1. Add a `chains` row (family, RPC URLs, block time, confirmations, reorg depth).
2. If the family already has an adapter (e.g. EVM), done.
3. Otherwise implement `ChainAdapter` and `AddressDeriver` for the family in `packages/chains/src/<family>/` and register it.

Written in full with the USDC-on-BSC proof and the second-chain adapter stub.
