# Adding a chain or token

Goal: a new token is config + seed only; a new chain family is config + seed + one adapter. Zero core changes.

## How the pieces fit

| Piece | Where | Changes when |
|---|---|---|
| `ChainAdapter`, `AddressDeriver`, `CustodyStrategy` interfaces | `packages/core/src/chain.ts` | never (for a new chain/token) |
| Family registry (`adapterFor`, `deriverFor`) | `packages/chains/src/index.ts` | new chain **family** only (one line each) |
| EVM adapter + deriver | `packages/chains/src/evm/` | never for another EVM chain |
| Registry rows (`chains`, `tokens`) | `apps/server/src/db/seed-registry.ts` → DB | every new chain or token |
| RPC credentials | env vars referenced as `${NAME}` in `rpc_urls` | when adding a provider |

## New token on an existing chain
1. **Verify the contract address** from the issuer's official site AND a block explorer. Record both sources in a comment
   next to the seed entry.
2. **Check behavior**: not fee-on-transfer, not rebasing, no transfer hooks that change received amounts. If it is any of
   these, do not allowlist it.
3. Add a token entry in `registrySeed()`:
   `id: '<chain>:<symbol>'`, `contractAddress`, `decimals`, `minConfirmations`, `confirmationTiers` (minor-unit strings),
   `minAmount` (dust threshold), `enabled`.
4. `pnpm db:seed` (idempotent; never re-enables something an operator disabled).
5. `pnpm chains:verify` must pass: every RPC reports the right chain id and on-chain `decimals()` equals config.
6. Enable on testnet first, run the chain test suite, then enable on mainnet.

Contract address and decimals can never be edited under an existing token id (DB trigger). A correction is a new token id.

## New EVM chain
1. Add a chain entry: `id`, `family: 'evm'`, `evmChainId`, `rpcUrls` (use `${ENV}` placeholders for keyed providers plus
   at least one public fallback), `blockTimeMs`, `defaultConfirmations`, `reorgDepth`, `finality` (`'tag'` if the chain
   exposes a `finalized` block), `testnet`, `enabled`.
2. Add its tokens as above. Seed, verify, enable.

EVM chains share one derivation key space (D-018): an address is unique across all EVM chains, so a payment sent on the
wrong EVM chain is still attributable and (custodial) recoverable.

## New chain family (e.g. Tron)
1. Implement `ChainAdapter` and `AddressDeriver` in `packages/chains/src/<family>/`.
2. Register them in `ADAPTERS` / `DERIVERS` in `packages/chains/src/index.ts`.
3. Add a `expectedNetworkId` rule for the family in `apps/server/src/modules/registry/registry.ts`.
4. Add chain + token seed rows. Seed, verify, enable.

The USDC-on-BSC proof and a second-family adapter stub are delivered in the extension step.
