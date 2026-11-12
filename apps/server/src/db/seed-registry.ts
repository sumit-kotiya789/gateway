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

/** Larger payments wait longer: from 10k and from 100k USDT. Confirmation counts are per chain (block times differ). */
const usdtTiers = (decimals: number, from10k = 30, from100k = 60) => [
  { min_amount: toMinorUnits('10000', decimals).toString(), confirmations: from10k },
  { min_amount: toMinorUnits('100000', decimals).toString(), confirmations: from100k },
];

/** A ForwarderFactory address from env (D-097), or null when unset. chains:verify checks its on-chain code. */
function factoryFrom(env: Record<string, string | undefined>, name: string): string | null {
  const v = env[name]?.trim();
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not an address`);
  return v;
}

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
      // Mainnet stays off until the launch checklist is complete (and a forwarder factory only after its audit).
      enabled: false,
      forwarderFactory: factoryFrom(env, 'BSC_FORWARDER_FACTORY'),
    },
    {
      // Ethereum mainnet (D-112). Seeded off: an operator sets ETH_RPC_URL, runs `pnpm chains:verify`, then turns it on
      // in the admin console. ~12 s blocks; payments also wait for the `finalized` tag (about two epochs, ~13 min).
      id: 'eth',
      family: 'evm',
      name: 'Ethereum',
      evmChainId: 1,
      // Public witnesses for the confirmation quorum (D-092), checked 2026-11-10 (llamarpc was down, HTTP 525). A witness
      // equal to ETH_RPC_URL counts once (resolveRpcUrls).
      rpcUrls: ['${ETH_RPC_URL}', 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
      explorerUrl: 'https://etherscan.io',
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
      blockTimeMs: 12_000,
      defaultConfirmations: 12,
      reorgDepth: 64,
      finality: 'tag',
      testnet: false,
      enabled: false,
      forwarderFactory: factoryFrom(env, 'ETH_FORWARDER_FACTORY'),
    },
    {
      // Polygon PoS mainnet (D-112). Seeded off like Ethereum. ~2 s blocks; Bor's `finalized` tag follows Heimdall
      // milestones. Polygon reorganised deeper than other chains before milestones, hence the wider rescan window and
      // the higher confirmation counts. Gas is paid in POL (the MATIC migration, 2024).
      id: 'polygon',
      family: 'evm',
      name: 'Polygon PoS',
      evmChainId: 137,
      // Public witnesses, checked 2026-11-10: polygon-rpc.com now refuses keyless calls (HTTP 401), Ankr needs a key.
      rpcUrls: ['${POLYGON_RPC_URL}', 'https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],
      explorerUrl: 'https://polygonscan.com',
      nativeSymbol: 'POL',
      nativeDecimals: 18,
      blockTimeMs: 2000,
      defaultConfirmations: 64,
      reorgDepth: 128,
      finality: 'tag',
      testnet: false,
      enabled: false,
      forwarderFactory: factoryFrom(env, 'POLYGON_FORWARDER_FACTORY'),
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
      // The test network (D-096, replaces Nexis from D-074). Re-seeding never flips `enabled`, so existing DBs enable
      // it via the admin console. The first RPC (BSC_TESTNET_RPC_URL) must serve address-filtered eth_getLogs: the
      // public bnbchain.org dataseed nodes refuse it and only act as confirmation witnesses.
      enabled: true,
      forwarderFactory: factoryFrom(env, 'BSC_TESTNET_FORWARDER_FACTORY'),
    },
    {
      // Nexis Chain (test chain under D-074, retired by D-096: seeded disabled, row kept for existing data). A public
      // chain, but registered as `testnet` so only test keys see it: its USDT is a mock, never real money. Finality tag
      // and block time unverified -> count confirmations only.
      id: 'nexis',
      family: 'evm',
      name: 'Nexis Chain',
      evmChainId: 5567,
      // Public keyless RPC only: chains:verify (and the watcher) require every ${ENV} placeholder to be set.
      rpcUrls: ['https://rpc.nexischain.com'],
      explorerUrl: 'https://nexischain.com/explorer',
      nativeSymbol: 'NXC',
      nativeDecimals: 18,
      blockTimeMs: 3000,
      defaultConfirmations: 12,
      reorgDepth: 64,
      finality: 'confirmations',
      testnet: true,
      enabled: false,
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
    {
      // Tether USD (ERC-20). Verify against https://etherscan.io/token/0xdac17f958d2ee523a2206206994597c13d831ec7
      // 6 decimals. Its transfer() returns nothing (pre-ERC-20-final): the signer does not read return data and the
      // forwarder accepts both forms (Forwarder._transfer). Usable once the `eth` chain is turned on.
      id: 'eth:usdt',
      chainId: 'eth',
      symbol: 'USDT',
      name: 'Tether USD (ERC-20)',
      contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      decimals: 6,
      minConfirmations: 12,
      confirmationTiers: usdtTiers(6),
      minAmount: toMinorUnits('0.01', 6),
      enabled: true,
    },
    {
      // Tether USD on Polygon PoS. Same address since 2020; Tether upgraded it in place to USDT0 in 2025, so its on-chain
      // symbol() is "USDT0". Verify against https://polygonscan.com/token/0xc2132d05d31c914a87c6611c10748aeb04b58e8f
      // 6 decimals. Usable once the `polygon` chain is turned on.
      id: 'polygon:usdt',
      chainId: 'polygon',
      symbol: 'USDT',
      name: 'Tether USD (Polygon PoS, USDT0)',
      contractAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      decimals: 6,
      minConfirmations: 64,
      confirmationTiers: usdtTiers(6, 128, 256),
      minAmount: toMinorUnits('0.01', 6),
      enabled: true,
    },
    {
      // "Nexis Usdt" (NXCUSDT): plain BEP-20 mock, no transfer fee or hooks; owner supplied the address and verified source
      // (D-074). Explorer: https://nexischain.com/explorer/address/0x3ff21b3856cf144747c9e12262aab690820515f1
      // Not Tether: test money only. `pnpm chains:verify` checks decimals() on-chain.
      id: 'nexis:usdt',
      chainId: 'nexis',
      symbol: 'USDT',
      name: 'Nexis test USDT (mock)',
      contractAddress: '0x3FF21b3856Cf144747C9e12262aab690820515f1',
      decimals: 18,
      minConfirmations: 12,
      confirmationTiers: usdtTiers(18),
      minAmount: toMinorUnits('0.01', 18),
      enabled: true,
    },
  ];

  // No official USDT exists on BSC testnet: we deploy our own mock, sastaUSDT (`pnpm testnet:token deploy`, D-096),
  // and register its address. Test money only; anyone can mint it.
  if (env.BSC_TESTNET_USDT_ADDRESS) {
    t.push({
      id: 'bsc-testnet:usdt',
      chainId: 'bsc-testnet',
      symbol: 'sastaUSDT',
      name: 'sastaUSDT (BSC testnet mock)',
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
      forwarderFactory: factoryFrom(env, 'EVM_LOCAL_FORWARDER_FACTORY'),
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
          // Set once (DB trigger): an unset env var keeps the registered factory; a different one is refused loudly.
          forwarderFactory: sql`coalesce(excluded.forwarder_factory, chains.forwarder_factory)`,
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
