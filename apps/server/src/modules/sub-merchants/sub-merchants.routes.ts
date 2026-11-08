// Marketplace sellers (M9, D-095). A platform merchant keeps its sellers as sub-merchants: each invoice can name one,
// events and seller-scoped webhook endpoints carry it, and per-seller totals tell the platform what to pay out. The
// money itself goes to the platform's wallet; paying sellers is the platform's business, outside the gateway.
// Same logic behind the API (secret key: read / invoices:write) and the dashboard (session: invoices:read / write).
import { AppError, fromMinorUnits } from '@gw/core';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant, type Tx } from '../../common/db.js';
import { requestHash, withIdempotency } from '../../common/idempotency.js';
import { invoices, subMerchants, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';
import { Metadata, idempotencyKeyOf, sendStored } from '../invoices/invoices.routes.js';

type Row = typeof subMerchants.$inferSelect;

const Name = z.string().trim().min(1).max(200);
const Reference = z.string().trim().min(1).max(200);
const Create = z.strictObject({ name: Name, reference: Reference.optional(), metadata: Metadata.optional() });
const Patch = z.strictObject({ name: Name.optional(), active: z.boolean().optional(), metadata: Metadata.optional() });
const IdParams = z.strictObject({ id: z.uuid() });
const ListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.uuid().optional(),
  reference: Reference.optional(),
});
/** Invoices whose money the merchant has accepted (counted in a seller's totals). */
const ACCEPTED = ['paid', 'overpaid', 'settled'] as const;

const view = (r: Row) => ({
  id: r.id,
  object: 'sub_merchant' as const,
  livemode: r.livemode,
  name: r.name,
  reference: r.reference,
  active: r.active,
  metadata: r.metadata,
  created_at: r.createdAt.toISOString(),
});

/** The seller, if it belongs to this merchant and mode. */
export async function loadSubMerchant(tx: Tx, merchantId: string, livemode: boolean, id: string): Promise<Row> {
  const [r] = await tx
    .select()
    .from(subMerchants)
    .where(and(eq(subMerchants.id, id), eq(subMerchants.merchantId, merchantId), eq(subMerchants.livemode, livemode)));
  if (!r) throw new AppError('not_found', 'sub-merchant not found');
  return r;
}

/** Accepted invoices per token: what the platform received on this seller's behalf. */
async function totals(tx: Tx, r: Row) {
  const rows = await tx
    .select({ token: tokens.id, symbol: tokens.symbol, decimals: tokens.decimals, invoices: count(), received: sql<string>`sum(${invoices.amountReceived})::text` })
    .from(invoices)
    .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
    .where(and(eq(invoices.subMerchantId, r.id), eq(invoices.merchantId, r.merchantId), inArray(invoices.status, [...ACCEPTED])))
    .groupBy(tokens.id, tokens.symbol, tokens.decimals)
    .orderBy(tokens.id);
  return rows.map((t) => ({ token: t.token, symbol: t.symbol, invoices: t.invoices, received: fromMinorUnits(BigInt(t.received), t.decimals) }));
}

async function create(tx: Tx, merchantId: string, livemode: boolean, b: z.infer<typeof Create>) {
  const [r] = await tx
    .insert(subMerchants)
    .values({ merchantId, livemode, name: b.name, reference: b.reference ?? null, metadata: b.metadata ?? {} })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws (a duplicate reference is a 409) */
  if (!r) throw new Error('sub-merchant insert failed');
  return r;
}

async function list(tx: Tx, merchantId: string, livemode: boolean, q: z.infer<typeof ListQuery>) {
  const rows = await tx
    .select()
    .from(subMerchants)
    .where(
      and(
        eq(subMerchants.merchantId, merchantId),
        eq(subMerchants.livemode, livemode),
        q.starting_after ? lt(subMerchants.id, q.starting_after) : undefined,
        q.reference ? eq(subMerchants.reference, q.reference) : undefined,
      ),
    )
    .orderBy(desc(subMerchants.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { data: page.map(view), has_more: rows.length > q.limit, next_cursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
}

async function update(tx: Tx, merchantId: string, livemode: boolean, id: string, b: z.infer<typeof Patch>) {
  const cur = await loadSubMerchant(tx, merchantId, livemode, id);
  const [r] = await tx
    .update(subMerchants)
    .set({ name: b.name ?? cur.name, active: b.active ?? cur.active, metadata: b.metadata ?? cur.metadata })
    .where(eq(subMerchants.id, cur.id))
    .returning();
  /* v8 ignore next -- the row was read above in the same transaction */
  if (!r) throw new Error('sub-merchant update failed');
  return { before: cur, after: r };
}

export function subMerchantRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post('/sub-merchants', { preHandler: requireApiKey(deps, 'invoices:write'), schema: { body: Create } }, async (req, reply) => {
      const k = req.apiKey;
      /* v8 ignore next -- requireApiKey runs first */
      if (!k) throw new AppError('unauthorized', 'API key required');
      const res = await withIdempotency(deps, k, idempotencyKeyOf(req), requestHash('POST', '/v1/sub-merchants', req.body), async (tx) => ({
        status: 201,
        body: view(await create(tx, k.merchantId, k.livemode, req.body)),
      }));
      return sendStored(reply, res);
    });

    app.get('/sub-merchants', { preHandler: requireApiKey(deps, 'read'), schema: { querystring: ListQuery } }, async (req) => {
      const k = req.apiKey;
      /* v8 ignore next -- requireApiKey runs first */
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, (tx) => list(tx, k.merchantId, k.livemode, req.query));
    });

    app.get('/sub-merchants/:id', { preHandler: requireApiKey(deps, 'read'), schema: { params: IdParams } }, async (req) => {
      const k = req.apiKey;
      /* v8 ignore next -- requireApiKey runs first */
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, async (tx) => {
        const r = await loadSubMerchant(tx, k.merchantId, k.livemode, req.params.id);
        return { ...view(r), totals: await totals(tx, r) };
      });
    });

    app.patch('/sub-merchants/:id', { preHandler: requireApiKey(deps, 'invoices:write'), schema: { params: IdParams, body: Patch } }, async (req) => {
      const k = req.apiKey;
      /* v8 ignore next -- requireApiKey runs first */
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, async (tx) => view((await update(tx, k.merchantId, k.livemode, req.params.id, req.body)).after));
    });
  };
}

export function subMerchantDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  const Mode = { livemode: z.stringbool().default(false) };
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));
    app.get('/', { preHandler: requirePermission('invoices:read'), schema: { querystring: ListQuery.extend(Mode) } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, (tx) => list(tx, u.merchantId, req.query.livemode, req.query));
    });

    app.get('/:id', { preHandler: requirePermission('invoices:read'), schema: { params: IdParams, querystring: z.strictObject(Mode) } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, async (tx) => {
        const r = await loadSubMerchant(tx, u.merchantId, req.query.livemode, req.params.id);
        return { ...view(r), totals: await totals(tx, r) };
      });
    });

    app.post('/', { preHandler: requirePermission('invoices:write'), schema: { body: Create.extend({ livemode: z.boolean() }) } }, async (req, reply) => {
      const u = authedUser(req);
      const { livemode, ...b } = req.body;
      const r = await withTenant(deps.db, u.merchantId, async (tx) => {
        const row = await create(tx, u.merchantId, livemode, b);
        await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'sub_merchant.created', targetType: 'sub_merchant', targetId: row.id, after: view(row) }, req);
        return row;
      });
      return reply.status(201).send(view(r));
    });

    app.patch(
      '/:id',
      { preHandler: requirePermission('invoices:write'), schema: { params: IdParams, body: Patch.extend({ livemode: z.boolean() }) } },
      async (req) => {
        const u = authedUser(req);
        const { livemode, ...b } = req.body;
        return withTenant(deps.db, u.merchantId, async (tx) => {
          const { before, after } = await update(tx, u.merchantId, livemode, req.params.id, b);
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'sub_merchant.updated', targetType: 'sub_merchant', targetId: after.id, before: view(before), after: view(after) }, req);
          return view(after);
        });
      },
    );
  };
}
