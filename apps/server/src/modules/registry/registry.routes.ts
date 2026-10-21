import { AppError, fromMinorUnits } from '@gw/core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withSystem } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { z } from 'zod';
import { requireApiKey } from '../api-keys/api-keys.js';
import { requireUser } from '../auth/guards.js';
import { loadRegistry } from './registry.js';

/** Enabled chains/tokens for the key's mode: test keys see testnets only, live keys mainnets only. */
async function visible(deps: Deps, livemode: boolean) {
  const reg = await withSystem(deps.db, (tx) => loadRegistry(tx));
  const chainIds = new Set(reg.chains.filter((c) => c.enabled && c.testnet !== livemode).map((c) => c.id));
  return { chains: reg.chains.filter((c) => chainIds.has(c.id)), tokens: reg.tokens.filter((t) => t.enabled && chainIds.has(t.chainId)) };
}

type TokenView = Awaited<ReturnType<typeof visible>>['tokens'][number];
const tokenView = (t: TokenView) => ({
  id: t.id,
  chain_id: t.chainId,
  symbol: t.symbol,
  name: t.name,
  contract_address: t.contractAddress,
  decimals: t.decimals,
  min_amount: fromMinorUnits(t.minAmount, t.decimals),
  min_confirmations: t.minConfirmations,
});

export function registryRoutes(deps: Deps): FastifyPluginAsyncZod {

  return async (app) => {
    app.get('/chains', { preHandler: requireApiKey(deps, 'read') }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const { chains } = await visible(deps, k.livemode);
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
      const { tokens } = await visible(deps, k.livemode);
      return { data: tokens.map(tokenView) };
    });
  };
}

/** Dashboard: tokens usable in the selected mode (invoice form). */
export function registryDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/', { preHandler: requireUser(deps), schema: { querystring: z.strictObject({ livemode: z.stringbool().default(false) }) } }, async (req) => {
      const { tokens } = await visible(deps, req.query.livemode);
      return { data: tokens.map(tokenView) };
    });
  };
}
