import { AppError, fromMinorUnits } from '@gw/core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withSystem } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { loadRegistry } from './registry.js';

/** Enabled chains/tokens for the key's mode: test keys see testnets only, live keys mainnets only. */
export function registryRoutes(deps: Deps): FastifyPluginAsyncZod {
  const visible = async (livemode: boolean) => {
    const reg = await withSystem(deps.db, (tx) => loadRegistry(tx));
    const chainIds = new Set(reg.chains.filter((c) => c.enabled && c.testnet !== livemode).map((c) => c.id));
    return { chains: reg.chains.filter((c) => chainIds.has(c.id)), tokens: reg.tokens.filter((t) => t.enabled && chainIds.has(t.chainId)) };
  };

  return async (app) => {
    app.get('/chains', { preHandler: requireApiKey(deps, 'read') }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const { chains } = await visible(k.livemode);
      return {
        data: chains.map((c) => ({
          id: c.id,
          family: c.family,
          name: c.name,
          network_id: c.evmChainId === null ? null : String(c.evmChainId),
          testnet: c.testnet,
          native_symbol: c.nativeSymbol,
          explorer_url: c.explorerUrl,
          block_time_ms: c.blockTimeMs,
        })),
      };
    });

    app.get('/tokens', { preHandler: requireApiKey(deps, 'read') }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const { tokens } = await visible(k.livemode);
      return {
        data: tokens.map((t) => ({
          id: t.id,
          chain_id: t.chainId,
          symbol: t.symbol,
          name: t.name,
          contract_address: t.contractAddress,
          decimals: t.decimals,
          min_amount: fromMinorUnits(t.minAmount, t.decimals),
          min_confirmations: t.minConfirmations,
        })),
      };
    });
  };
}
