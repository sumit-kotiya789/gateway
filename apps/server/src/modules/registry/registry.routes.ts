import { AppError, fromMinorUnits } from '@gw/core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withSystem } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { z } from 'zod';
import { requireApiKey } from '../api-keys/api-keys.js';
import { requireUser } from '../auth/guards.js';
import { merchantNetwork } from '../invoices/invoices.js';
import { loadRegistry } from './registry.js';

/**
 * Enabled chains/tokens a merchant can receive on in this mode: test keys see testnets only, live keys mainnets only,
 * and only the merchant's network when the platform set one (D-113).
 */
async function visible(deps: Deps, merchantId: string, livemode: boolean) {
  const { reg, net } = await withSystem(deps.db, async (tx) => ({ reg: await loadRegistry(tx), net: await merchantNetwork(tx, merchantId, livemode) }));
  const chainIds = new Set(reg.chains.filter((c) => c.enabled && c.testnet !== livemode && (!net || c.id === net.id)).map((c) => c.id));
  return { chains: reg.chains.filter((c) => chainIds.has(c.id)), tokens: reg.tokens.filter((t) => t.enabled && chainIds.has(t.chainId)), network: net?.id ?? null };
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
      const { chains } = await visible(deps, k.merchantId, k.livemode);
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
      const { tokens } = await visible(deps, k.merchantId, k.livemode);
      return { data: tokens.map(tokenView) };
    });
  };
}

/** Dashboard: tokens usable in the selected mode (invoice form). */
export function registryDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/', { preHandler: requireUser(deps), schema: { querystring: z.strictObject({ livemode: z.stringbool().default(false) }) } }, async (req) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      const { tokens, network } = await visible(deps, user.merchantId, req.query.livemode);
      // network: the chain the platform limited this merchant to (D-113), null = every enabled chain.
      return { data: tokens.map(tokenView), network };
    });
  };
}
