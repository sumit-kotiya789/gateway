import { AppError, fromMinorUnits, fromSignedMinorUnits } from '@gw/core';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenant, type Tx } from '../../common/db.js';
import { chains, feeTopups, merchants, outboxEvents, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';
import { feeBalanceOf } from './fee-balance.js';
import { merchantBalances } from './ledger.js';

async function decimalsOf(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, { decimals: number; symbol: string }>();
  const rows = await tx.select({ id: tokens.id, decimals: tokens.decimals, symbol: tokens.symbol }).from(tokens).where(inArray(tokens.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Ids of tokens a live invoice can use now (enabled token on an enabled mainnet chain). */
async function liveTokenIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: tokens.id })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .where(and(eq(tokens.enabled, true), eq(chains.enabled, true), eq(chains.testnet, false)));
  return rows.map((r) => r.id);
}

/**
 * Per token: received, fees charged, fees owed (charged and not covered by top-ups), the prepaid fee balance (top-ups
 * minus fees; negative when used into the grace or before any top-up) and its status (D-076). Live mode also lists every usable live token, so a merchant who has not topped
 * up yet sees `blocked` instead of nothing.
 */
export async function balancesView(tx: Tx, merchantId: string, livemode: boolean) {
  const b = await merchantBalances(tx, merchantId, livemode);
  const ids = [...new Set([...b.keys(), ...(livemode ? await liveTokenIds(tx) : [])])].sort();
  const meta = await decimalsOf(tx, ids);
  const [m] = await tx.select({ grace: merchants.feeGrace, mode: merchants.custodyMode }).from(merchants).where(eq(merchants.id, merchantId));
  // Custodial merchants pay fees out of each settlement, not from a prepaid balance (D-087).
  const custodial = m?.mode === 'custodial';
  return {
    livemode,
    custody_mode: m?.mode ?? null,
    data: ids.map((token) => {
      const v = b.get(token) ?? { received: 0n, feesOwed: 0n, feesCharged: 0n, pending: 0n, available: 0n, withdrawing: 0n };
      const d = meta.get(token)?.decimals ?? 0;
      const fb = feeBalanceOf(livemode && !custodial, v.feesOwed, m?.grace ?? '0', d);
      return {
        token,
        symbol: meta.get(token)?.symbol ?? null,
        received: fromMinorUnits(v.received, d),
        // Fees charged and not covered by top-ups (pre-M8 meaning), never negative; the prepaid side is prepaid_fees.
        fees_owed: fromMinorUnits(v.feesOwed > 0n ? v.feesOwed : 0n, d),
        fees_charged: fromMinorUnits(v.feesCharged, d),
        prepaid_fees: fromSignedMinorUnits(fb.prepaid, d),
        fee_status: fb.status,
        // Custodial only (always 0 otherwise): not swept yet / withdrawable / held for withdrawals in flight.
        pending: fromMinorUnits(v.pending, d),
        available: fromMinorUnits(v.available, d),
        withdrawing: fromMinorUnits(v.withdrawing, d),
      };
    }),
  };
}

/** Prepaid fee top-ups of one merchant and mode, newest first (D-076). */
export async function feeTopupsView(tx: Tx, merchantId: string, livemode: boolean, limit = 100) {
  const rows = await tx
    .select({ t: feeTopups, decimals: tokens.decimals, symbol: tokens.symbol })
    .from(feeTopups)
    .innerJoin(tokens, eq(tokens.id, feeTopups.tokenId))
    .where(and(eq(feeTopups.merchantId, merchantId), eq(feeTopups.livemode, livemode)))
    .orderBy(desc(feeTopups.createdAt))
    .limit(limit);
  return {
    data: rows.map(({ t, decimals, symbol }) => ({
      id: t.id,
      livemode: t.livemode,
      token: t.tokenId,
      symbol,
      amount: fromMinorUnits(t.amount, decimals),
      reference: t.reference,
      created_at: t.createdAt.toISOString(),
    })),
  };
}

type EventRow = typeof outboxEvents.$inferSelect;
const AMOUNT_FIELDS = ['amount_expected', 'amount_received', 'fee_amount'] as const;

export async function eventsView(tx: Tx, rows: EventRow[]) {
  const meta = await decimalsOf(tx, [...new Set(rows.map((r) => (r.data as { token?: string }).token).filter((t): t is string => !!t))]);
  return rows.map((r) => {
    const data = { ...(r.data as Record<string, unknown>) };
    const d = meta.get(String(data.token))?.decimals ?? 0;
    for (const k of AMOUNT_FIELDS) if (typeof data[k] === 'string') data[k] = fromMinorUnits(BigInt(data[k]), d);
    return { id: r.id, object: 'event' as const, type: r.type, livemode: r.livemode, created_at: r.createdAt.toISOString(), data };
  });
}

/** Merchant API: balances and the event log (the same events webhooks deliver in M6). */
export function ledgerRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/balances', { preHandler: requireApiKey(deps, 'read') }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, (tx) => balancesView(tx, k.merchantId, k.livemode));
    });

    app.get(
      '/events',
      {
        preHandler: requireApiKey(deps, 'read'),
        schema: {
          querystring: z.strictObject({
            limit: z.coerce.number().int().min(1).max(100).default(20),
            starting_after: z.uuid().optional(),
            type: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional(),
          }),
        },
      },
      async (req) => {
        const k = req.apiKey;
        if (!k) throw new AppError('unauthorized', 'API key required');
        const q = req.query;
        return withTenant(deps.db, k.merchantId, async (tx) => {
          const rows = await tx
            .select()
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.merchantId, k.merchantId),
                eq(outboxEvents.livemode, k.livemode),
                q.starting_after ? lt(outboxEvents.seq, sql`(select seq from ${outboxEvents} where id = ${q.starting_after})`) : undefined,
                q.type ? eq(outboxEvents.type, q.type) : undefined,
              ),
            )
            .orderBy(desc(outboxEvents.seq))
            .limit(q.limit + 1);
          const page = rows.slice(0, q.limit);
          return { data: await eventsView(tx, page), has_more: rows.length > q.limit, next_cursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
        });
      },
    );

    app.get('/events/:id', { preHandler: requireApiKey(deps, 'read'), schema: { params: z.strictObject({ id: z.uuid() }) } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, async (tx) => {
        const rows = await tx
          .select()
          .from(outboxEvents)
          .where(and(eq(outboxEvents.id, req.params.id), eq(outboxEvents.merchantId, k.merchantId), eq(outboxEvents.livemode, k.livemode)));
        const [view] = await eventsView(tx, rows);
        if (!view) throw new AppError('not_found', 'event not found');
        return view;
      });
    });
  };
}

const ModeQuery = z.strictObject({ livemode: z.stringbool().default(false) });

export function ledgerDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/', { preHandler: [requireUser(deps), requirePermission('account:read')], schema: { querystring: ModeQuery } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, (tx) => balancesView(tx, u.merchantId, req.query.livemode));
    });
  };
}

export function feeTopupDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/', { preHandler: [requireUser(deps), requirePermission('account:read')], schema: { querystring: ModeQuery } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, (tx) => feeTopupsView(tx, u.merchantId, req.query.livemode));
    });
  };
}
