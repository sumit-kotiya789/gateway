import type { AddressDeriver, ChainAdapter, ChainConfig, ChainFamily } from '@gw/core';
import { createEvmAdapter } from './evm/adapter.js';
import { evmDeriver } from './evm/deriver.js';

export { createEvmAdapter } from './evm/adapter.js';
export { MAX_NON_HARDENED_INDEX, deriveEvmAddress, evmDeriver, parseAccountXpub } from './evm/deriver.js';
export { TRANSFER_TOPIC, decodeTokenTransfers, decodeTransferLog, type RawLog } from './evm/transfers.js';
export { detectSecretMaterial, type SecretKind } from './evm/secrets.js';
export { resolveRpcUrls } from './rpc.js';

// Family registry. Adding a chain family = one entry here + its adapter/deriver. Nothing else changes.
const ADAPTERS: Partial<Record<ChainFamily, (chain: ChainConfig, urls: readonly string[]) => ChainAdapter>> = {
  evm: createEvmAdapter,
};
const DERIVERS: Partial<Record<ChainFamily, AddressDeriver>> = {
  evm: evmDeriver,
};

export function adapterFor(chain: ChainConfig, urls: readonly string[]): ChainAdapter {
  const make = ADAPTERS[chain.family];
  if (!make) throw new Error(`no adapter for chain family ${chain.family}`);
  return make(chain, urls);
}

export function deriverFor(family: ChainFamily): AddressDeriver {
  const d = DERIVERS[family];
  if (!d) throw new Error(`no address deriver for chain family ${family}`);
  return d;
}
