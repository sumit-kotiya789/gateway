import { AppError, INVOICE_STATUSES, fromMinorUnits } from '@gw/core';
import { and, asc, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant, type Tx } from '../../common/db.js';
import { requestHash, withIdempotency, type StoredResponse } from '../../common/idempotency.js';
import { chains, invoiceStatusHistory, invoices, payments, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey, type AuthedApiKey } from '../api-keys/api-keys.js';
import { requirePermission, requireUser } from '../auth/guards.js';
import { EXPIRY_S, createInvoice, invoiceView, loadInvoiceWithToken, transitionInvoice } from './invoices.js';

/** success/cancel URLs: https only in production (http allowed in dev/test), no other schemes, no credentials. */
export function redirectUrl(production: boolean) {
  return z
    .url()
    .max(2000)
    .refine((u) => {
      // zod runs refinements even when z.url() already failed: never let a parse error escape as a 500.
      if (!URL.canParse(u)) return false;
      const p = new URL(u);
      if (p.username || p.password) return false;
      return p.protocol === 'https:' || (!production && p.protocol === 'http:');
    }, production ? 'must be an https URL without credentials' : 'must be an http(s) URL without credentials');
}

export const Metadata = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 50, 'at most 50 keys')
  .refine((m) => Buffer.byteLength(JSON.stringify(m)) <= 4096, 'at most 4 KB');

export const TokenId = z.string().regex(/^[a-z0-9-]{2,32}:[a-z0-9]{2,16}$/);

const requireKey = (req: FastifyRequest): AuthedApiKey => {
  if (!req.apiKey) throw new AppError('unauthorized', 'API key required');
  return req.apiKey;
};

export function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const h = req.headers['idempotency-key'];
  return typeof h === 'string' ? h : undefined;
}

export function sendStored(reply: FastifyReply, res: StoredResponse & { replayed: boolean }) {
  if (res.replayed) reply.header('idempotent-replayed', 'true');
  return reply.status(res.status).send(res.body);
}

/** On-chain payments of one invoice (detail views only; lists stay one query). */
async function paymentsView(tx: Tx, invoiceId: string, decimals: number) {
  const rows = await tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(asc(payments.createdAt));
  return rows.map((p) => ({
    tx_hash: p.txHash,
    log_index: p.logIndex,
    from: p.fromAddress,
    amount: fromMinorUnits(p.amount, decimals),
    status: p.status,
    block_number: p.blockNumber.toString(),
    block_time: p.blockTime.toISOString(),
    confirmations_required: p.requiredConfirmations,
    confirmed_at: p.confirmedAt?.toISOString() ?? null,
  }));
}

const ListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.uuid().optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  external_order_id: z.string().min(1).max(200).optional(),
});

/** One page of a merchant's invoices for a mode, newest first. Shared by the merchant API and the dashboard. */
export async function listInvoices(tx: Tx, merchantId: string, livemode: boolean, q: z.infer<typeof ListQuery>, base: string) {
  const rows = await tx
    .select({ inv: invoices, token: tokens, chain: chains })
    .from(invoices)
    .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
    .innerJoin(chains, eq(chains.id, invoices.chainId))
    .where(
      and(
        eq(invoices.merchantId, merchantId),
        eq(invoices.livemode, livemode),
        q.starting_after ? lt(invoices.id, q.starting_after) : undefined,
        q.status ? eq(invoices.status, q.status) : undefined,
        q.external_order_id ? eq(invoices.externalOrderId, q.external_order_id) : undefined,
      ),
    )
    // UUIDv7 ids are time-ordered: newest first, stable cursor.
    .orderBy(desc(invoices.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    data: page.map((r) => invoiceView(r.inv, r.token, r.chain, base)),
    has_more: rows.length > q.limit,
    next_cursor: rows.length > q.limit ? (page.at(-1)?.inv.id ?? null) : null,
  };
}

export function invoiceRoutes(deps: Deps): FastifyPluginAsyncZod {
  const base = deps.config.PUBLIC_BASE_URL;
  const production = deps.config.NODE_ENV === 'production';

  const CreateBody = z.strictObject({
    amount: z.string().max(100),
    token: TokenId,
    external_order_id: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    metadata: Metadata.optional(),
    expires_in: z.number().int().min(EXPIRY_S.min).max(EXPIRY_S.max).optional(),
    success_url: redirectUrl(production).optional(),
    cancel_url: redirectUrl(production).optional(),
  });

  return async (app) => {
    app.post('/invoices', { preHandler: requireApiKey(deps, 'invoices:write'), schema: { body: CreateBody } }, async (req, reply) => {
      const k = requireKey(req);
      const b = req.body;
      const res = await withIdempotency(deps, k, idempotencyKeyOf(req), requestHash('POST', '/v1/invoices', b), async (tx) => {
        const inv = await createInvoice(deps, tx, k.merchantId, k.livemode, {
          amount: b.amount,
          token: b.token,
          externalOrderId: b.external_order_id,
          description: b.description,
          metadata: b.metadata,
          expiresInSeconds: b.expires_in,
          successUrl: b.success_url,
          cancelUrl: b.cancel_url,
        });
        const r = await loadInvoiceWithToken(tx, eq(invoices.id, inv.id));
        if (!r) throw new Error('created invoice not found');
        return { status: 201, body: invoiceView(r.inv, r.token, r.chain, base) };
      });
      return sendStored(reply, res);
    });

    app.get(
      '/invoices/:id',
      { preHandler: requireApiKey(deps, 'read'), schema: { params: z.strictObject({ id: z.uuid() }) } },
      async (req) => {
        const k = requireKey(req);
        return withTenant(deps.db, k.merchantId, async (tx) => {
          const r = await loadInvoiceWithToken(tx, and(eq(invoices.id, req.params.id), eq(invoices.merchantId, k.merchantId), eq(invoices.livemode, k.livemode)) as SQL);
          if (!r) throw new AppError('not_found', 'invoice not found');
          return { ...invoiceView(r.inv, r.token, r.chain, base), payments: await paymentsView(tx, r.inv.id, r.token.decimals) };
        });
      },
    );

    app.get(
      '/invoices',
      {
        preHandler: requireApiKey(deps, 'read'),
        schema: {
          querystring: ListQuery,
        },
      },
      async (req) => {
        const k = requireKey(req);
        return withTenant(deps.db, k.merchantId, (tx) => listInvoices(tx, k.merchantId, k.livemode, req.query, base));
      },
    );

    app.post(
      '/invoices/:id/cancel',
      { preHandler: requireApiKey(deps, 'invoices:write'), schema: { params: z.strictObject({ id: z.uuid() }) } },
      async (req, reply) => {
        const k = requireKey(req);
        const id = req.params.id;
        const res = await withIdempotency(deps, k, idempotencyKeyOf(req), requestHash('POST', `/v1/invoices/${id}/cancel`, null), async (tx) => {
          const own = await loadInvoiceWithToken(tx, and(eq(invoices.id, id), eq(invoices.merchantId, k.merchantId), eq(invoices.livemode, k.livemode)) as SQL);
          if (!own) throw new AppError('not_found', 'invoice not found');
          const inv = await transitionInvoice(deps, tx, id, 'cancelled', 'cancelled by merchant via API');
          return { status: 200, body: invoiceView(inv, own.token, own.chain, base) };
        });
        return sendStored(reply, res);
      },
    );
  };
}

/**
 * Dashboard (session auth). Mode comes from the request (`livemode`), not from a key. Creation here has no
 * idempotency key: a person clicking a button, not a retrying backend.
 */
export function invoiceDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  const base = deps.config.PUBLIC_BASE_URL;
  const user = (req: FastifyRequest) => {
    if (!req.user) throw new AppError('unauthorized', 'authentication required');
    return req.user;
  };
  const own = (merchantId: string, id: string) => and(eq(invoices.id, id), eq(invoices.merchantId, merchantId)) as SQL;

  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get(
      '/',
      { preHandler: requirePermission('invoices:read'), schema: { querystring: ListQuery.extend({ livemode: z.stringbool().default(false) }) } },
      async (req) => {
        const u = user(req);
        const { livemode, ...q } = req.query;
        return withTenant(deps.db, u.merchantId, (tx) => listInvoices(tx, u.merchantId, livemode, q, base));
      },
    );

    app.get('/:id', { preHandler: requirePermission('invoices:read'), schema: { params: z.strictObject({ id: z.uuid() }) } }, async (req) => {
      const u = user(req);
      return withTenant(deps.db, u.merchantId, async (tx) => {
        const r = await loadInvoiceWithToken(tx, own(u.merchantId, req.params.id));
        if (!r) throw new AppError('not_found', 'invoice not found');
        const history = await tx
          .select()
          .from(invoiceStatusHistory)
          .where(eq(invoiceStatusHistory.invoiceId, r.inv.id))
          .orderBy(asc(invoiceStatusHistory.id));
        return {
          ...invoiceView(r.inv, r.token, r.chain, base),
          history: history.map((h) => ({ from: h.fromStatus, to: h.toStatus, reason: h.reason, at: h.at.toISOString() })),
          payments: await paymentsView(tx, r.inv.id, r.token.decimals),
        };
      });
    });

    app.post(
      '/',
      {
        preHandler: requirePermission('invoices:write'),
        schema: {
          body: z.strictObject({
            livemode: z.boolean(),
            amount: z.string().max(100),
            token: TokenId,
            external_order_id: z.string().min(1).max(200).optional(),
            description: z.string().max(500).optional(),
            expires_in: z.number().int().min(EXPIRY_S.min).max(EXPIRY_S.max).optional(),
          }),
        },
      },
      async (req, reply) => {
        const u = user(req);
        const b = req.body;
        const view = await withTenant(deps.db, u.merchantId, async (tx) => {
          const inv = await createInvoice(deps, tx, u.merchantId, b.livemode, {
            amount: b.amount,
            token: b.token,
            externalOrderId: b.external_order_id,
            description: b.description,
            expiresInSeconds: b.expires_in,
          });
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'invoice.created', targetType: 'invoice', targetId: inv.id }, req);
          const r = await loadInvoiceWithToken(tx, eq(invoices.id, inv.id));
          if (!r) throw new Error('created invoice not found');
          return invoiceView(r.inv, r.token, r.chain, base);
        });
        return reply.status(201).send(view);
      },
    );

    app.post(
      '/:id/cancel',
      { preHandler: requirePermission('invoices:write'), schema: { params: z.strictObject({ id: z.uuid() }) } },
      async (req) => {
        const u = user(req);
        return withTenant(deps.db, u.merchantId, async (tx) => {
          const r = await loadInvoiceWithToken(tx, own(u.merchantId, req.params.id));
          if (!r) throw new AppError('not_found', 'invoice not found');
          const inv = await transitionInvoice(deps, tx, r.inv.id, 'cancelled', 'cancelled by merchant in dashboard');
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'invoice.cancelled', targetType: 'invoice', targetId: inv.id }, req);
          return invoiceView(inv, r.token, r.chain, base);
        });
      },
    );
  };
}
