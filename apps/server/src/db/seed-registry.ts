// MONEY-CRITICAL
// Chain + token registry seed. Contract addresses here decide which tokens get credited.
// Upsert updates operational fields only: identity (contract, decimals, network id) is immutable by DB trigger,
// and `enabled` is never changed by re-seeding (operators toggle it).
import { toMinorUnits } from '@gw/core';
import { sql } from 'drizzle-orm';
import type { Tx } from '../common/db.js';
import { chains, tokens } from './schema.js';

type ChainRow = typeof chains.$inferInsert;
type TokenRow = typeof tokens.$inferInsert;

const usdtTiers = (decimals: number) => [
  { min_amount: toMinorUnits('10000', decimals).toString(), confirmations: 30 },
  { min_amount: toMinorUnits('100000', decimals).toString(), confirmations: 60 },
];

export function registrySeed(env: Record<string, string | undefined>): { chains: ChainRow[]; tokens: TokenRow[] } {
  const c: ChainRow[] = [
    {
      id: 'bsc',
      family: 'evm',
      name: 'BNB Smart Chain',
      evmChainId: 56,
      rpcUrls: ['${BSC_RPC_URL}', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'],
      explorerUrl: 'https://bscscan.com',
      nativeSymbol: 'BNB',
      nativeDecimals: 18,
      blockTimeMs: 750,
      defaultConfirmations: 15,
      reorgDepth: 64,
      finality: 'tag',
      testnet: false,
      // Mainnet stays off until the launch checklist is complete.
      enabled: false,
    },
    {
      id: 'bsc-testnet',
      family: 'evm',
      name: 'BNB Smart Chain Testnet',
      evmChainId: 97,
      rpcUrls: ['${BSC_TESTNET_RPC_URL}', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
      explorerUrl: 'https://testnet.bscscan.com',
      nativeSymbol: 'tBNB',
      nativeDecimals: 18,
      blockTimeMs: 750,
      defaultConfirmations: 15,
      reorgDepth: 64,
      finality: 'tag',
      testnet: true,
      enabled: true,
    },
  ];
  const t: TokenRow[] = [
    {
      // Binance-Peg BSC-USD (USDT BEP-20). Verify against https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955
      // NOTE: 18 decimals on BSC (not 6 as on Ethereum/Tron). `pnpm chains:verify` checks decimals() on-chain.
      id: 'bsc:usdt',
      chainId: 'bsc',
      symbol: 'USDT',
      name: 'Tether USD (BEP-20)',
      contractAddress: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
      minConfirmations: 15,
      confirmationTiers: usdtTiers(18),
      minAmount: toMinorUnits('0.01', 18),
      enabled: true,
    },
  ];

  // No official USDT exists on BSC testnet: we deploy our own mock and register its address.
  if (env.BSC_TESTNET_USDT_ADDRESS) {
    t.push({
      id: 'bsc-testnet:usdt',
      chainId: 'bsc-testnet',
      symbol: 'USDT',
      name: 'Test USDT (gateway mock)',
      contractAddress: env.BSC_TESTNET_USDT_ADDRESS,
      decimals: 18,
      minConfirmations: 15,
      confirmationTiers: usdtTiers(18),
      minAmount: toMinorUnits('0.01', 18),
      enabled: true,
    });
  }

  // Local Anvil chain for development (docker compose `anvil` service).
  if (env.EVM_LOCAL_RPC_URL) {
    c.push({
      id: 'evm-local',
      family: 'evm',
      name: 'Local Anvil',
      evmChainId: 31337,
      rpcUrls: ['${EVM_LOCAL_RPC_URL}'],
      explorerUrl: null,
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
      blockTimeMs: 1000,
      defaultConfirmations: 2,
      reorgDepth: 16,
      finality: 'tag',
      testnet: true,
      enabled: true,
    });
    if (env.EVM_LOCAL_USDT_ADDRESS) {
      t.push({
        id: 'evm-local:usdt',
        chainId: 'evm-local',
        symbol: 'USDT',
        name: 'Local mock USDT',
        contractAddress: env.EVM_LOCAL_USDT_ADDRESS,
        decimals: 18,
        minConfirmations: 2,
        confirmationTiers: usdtTiers(18),
        minAmount: toMinorUnits('0.01', 18),
        enabled: true,
      });
    }
  }
  return { chains: c, tokens: t };
}

export async function seedRegistry(tx: Tx, env: Record<string, string | undefined>): Promise<{ chains: number; tokens: number }> {
  const seed = registrySeed(env);
  for (const row of seed.chains) {
    await tx
      .insert(chains)
      .values(row)
      .onConflictDoUpdate({
        target: chains.id,
        set: {
          name: sql`excluded.name`,
          rpcUrls: sql`excluded.rpc_urls`,
          explorerUrl: sql`excluded.explorer_url`,
          blockTimeMs: sql`excluded.block_time_ms`,
          defaultConfirmations: sql`excluded.default_confirmations`,
          reorgDepth: sql`excluded.reorg_depth`,
          finality: sql`excluded.finality`,
          // identity columns included so the immutability trigger rejects a changed seed instead of ignoring it
          family: sql`excluded.family`,
          evmChainId: sql`excluded.evm_chain_id`,
          testnet: sql`excluded.testnet`,
        },
      });
  }
  for (const row of seed.tokens) {
    await tx
      .insert(tokens)
      .values(row)
      .onConflictDoUpdate({
        target: tokens.id,
        set: {
          name: sql`excluded.name`,
          minConfirmations: sql`excluded.min_confirmations`,
          confirmationTiers: sql`excluded.confirmation_tiers`,
          minAmount: sql`excluded.min_amount`,
          chainId: sql`excluded.chain_id`,
          contractAddress: sql`excluded.contract_address`,
          decimals: sql`excluded.decimals`,
        },
      });
  }
  return { chains: seed.chains.length, tokens: seed.tokens.length };
}
