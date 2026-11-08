import type { ChainAdapter, ChainConfig, TokenConfig } from '@gw/core';
import { FORWARDER_FACTORY_CODEHASH, adapterFor, resolveRpcUrls } from '@gw/chains';
import { asc } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../../common/db.js';
import { chains, tokens } from '../../db/schema.js';

const Tiers = z.array(z.strictObject({ min_amount: z.string().regex(/^\d{1,78}$/), confirmations: z.number().int().min(1).max(10_000) })).max(10);

export function rowToChain(r: typeof chains.$inferSelect): ChainConfig {
  return {
    id: r.id,
    family: r.family,
    name: r.name,
    evmChainId: r.evmChainId,
    rpcUrls: r.rpcUrls,
    explorerUrl: r.explorerUrl,
    nativeSymbol: r.nativeSymbol,
    nativeDecimals: r.nativeDecimals,
    blockTimeMs: r.blockTimeMs,
    defaultConfirmations: r.defaultConfirmations,
    reorgDepth: r.reorgDepth,
    finality: r.finality,
    testnet: r.testnet,
    enabled: r.enabled,
    forwarderFactory: r.forwarderFactory,
  };
}

/** Malformed tier JSON is a hard error: silently dropping a tier would credit large payments too early. */
export function rowToToken(r: typeof tokens.$inferSelect): TokenConfig {
  const tiers = Tiers.parse(r.confirmationTiers);
  return {
    id: r.id,
    chainId: r.chainId,
    symbol: r.symbol,
    name: r.name,
    contractAddress: r.contractAddress,
    decimals: r.decimals,
    minConfirmations: r.minConfirmations,
    confirmationTiers: tiers.map((t) => ({ minAmount: BigInt(t.min_amount), confirmations: t.confirmations })),
    minAmount: r.minAmount,
    enabled: r.enabled,
  };
}

export async function loadRegistry(tx: Tx): Promise<{ chains: ChainConfig[]; tokens: TokenConfig[] }> {
  const [c, t] = await Promise.all([tx.select().from(chains).orderBy(asc(chains.id)), tx.select().from(tokens).orderBy(asc(tokens.id))]);
  return { chains: c.map(rowToChain), tokens: t.map(rowToToken) };
}

export function expectedNetworkId(chain: ChainConfig): string {
  if (chain.family === 'evm') return String(chain.evmChainId);
  throw new Error(`no network id rule for family ${chain.family}`);
}

/** Independent providers that must each see a payment, deep enough, before it is confirmed (SECURITY.md "Lying RPC"). */
export const RPC_QUORUM = 2;

type MakeAdapter = (chain: ChainConfig, urls: readonly string[]) => ChainAdapter;

/**
 * Pre-flight check before any process trusts the registry: every RPC (individually) must report the configured
 * network, every enabled token's on-chain decimals must equal config, and a configured forwarder factory must run
 * exactly the committed code (D-097). Returns problems; empty = OK.
 * Messages never include RPC URLs (they may embed provider keys).
 */
export async function verifyRegistry(
  reg: { chains: readonly ChainConfig[]; tokens: readonly TokenConfig[] },
  env: Record<string, string | undefined>,
  makeAdapter: MakeAdapter = adapterFor,
): Promise<string[]> {
  const problems: string[] = [];
  for (const chain of reg.chains.filter((c) => c.enabled)) {
    const { urls, missing } = resolveRpcUrls(chain.rpcUrls, env);
    if (missing.length > 0) problems.push(`${chain.id}: env not set for RPC placeholders: ${[...new Set(missing)].join(', ')}`);
    if (urls.length === 0) {
      problems.push(`${chain.id}: no usable RPC URL`);
      continue;
    }
    // Confirmation needs two providers to agree (scanner RPC_QUORUM): one lying provider cannot credit a payment.
    if (!chain.testnet && urls.length < RPC_QUORUM) problems.push(`${chain.id}: mainnet needs at least ${String(RPC_QUORUM)} RPC providers (confirmation quorum)`);
    const expected = expectedNetworkId(chain);
    for (const [i, url] of urls.entries()) {
      const label = `${chain.id} rpc #${String(i + 1)}`;
      const adapter = makeAdapter(chain, [url]);
      try {
        const got = await adapter.getNetworkId();
        if (got !== expected) {
          problems.push(`${label}: network id ${got}, expected ${expected}`);
          continue;
        }
        for (const token of reg.tokens.filter((t) => t.enabled && t.chainId === chain.id)) {
          const decimals = await adapter.readTokenDecimals(token);
          if (decimals !== token.decimals) problems.push(`${label}: ${token.id} decimals on-chain ${String(decimals)}, config ${String(token.decimals)}`);
        }
        // Forwarder deposit addresses are only as safe as the factory they are derived from (D-097): its on-chain code
        // must be exactly the committed artifact, or a different factory could be deployed to pay someone else.
        if (chain.forwarderFactory) {
          const hash = adapter.getCodeHash ? await adapter.getCodeHash(chain.forwarderFactory) : undefined;
          if (hash === null) problems.push(`${label}: forwarder factory has no code on-chain`);
          else if (hash !== FORWARDER_FACTORY_CODEHASH) problems.push(`${label}: forwarder factory code does not match the committed artifact`);
        }
      } catch (err) {
        problems.push(`${label}: unreachable or failed (${err instanceof Error ? err.name : 'error'})`);
      }
    }
  }
  return problems;
}
