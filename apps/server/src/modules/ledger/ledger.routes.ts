import { AppError, fromMinorUnits } from '@gw/core';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenant, type Tx } from '../../common/db.js';
import { outboxEvents, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';
import { merchantBalances } from './ledger.js';

async function decimalsOf(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, { decimals: number; symbol: string }>();
  const rows = await tx.select({ id: tokens.id, decimals: tokens.decimals, symbol: tokens.symbol }).from(tokens).where(inArray(tokens.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function balancesView(tx: Tx, merchantId: string, livemode: boolean) {
  const b = await merchantBalances(tx, merchantId, livemode);
  const meta = await decimalsOf(tx, [...b.keys()]);
  return {
    livemode,
    data: [...b].map(([token, v]) => {
      const d = meta.get(token)?.decimals ?? 0;
      // fees_owed > 0: fees charged and not yet covered by prepaid top-ups (M8).
      return { token, symbol: meta.get(token)?.symbol ?? null, received: fromMinorUnits(v.received, d), fees_owed: fromMinorUnits(v.feesOwed, d) };
    }),
  };
}

type EventRow = typeof outboxEvents.$inferSelect;
const AMOUNT_FIELDS = ['amount_expected', 'amount_received', 'fee_amount'] as const;

async function eventsView(tx: Tx, rows: EventRow[]) {
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

export function ledgerDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      { preHandler: [requireUser(deps), requirePermission('account:read')], schema: { querystring: z.strictObject({ livemode: z.stringbool().default(false) }) } },
      async (req) => {
        const u = authedUser(req);
        return withTenant(deps.db, u.merchantId, (tx) => balancesView(tx, u.merchantId, req.query.livemode));
      },
    );
  };
}
