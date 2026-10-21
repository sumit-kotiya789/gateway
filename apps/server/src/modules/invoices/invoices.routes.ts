import { AppError, INVOICE_STATUSES } from '@gw/core';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenant } from '../../common/db.js';
import { requestHash, withIdempotency, type StoredResponse } from '../../common/idempotency.js';
import { chains, invoices, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey, type AuthedApiKey } from '../api-keys/api-keys.js';
import { EXPIRY_S, createInvoice, invoiceView, loadInvoiceWithToken, transitionInvoice } from './invoices.js';

/** success/cancel URLs: https only in production (http allowed in dev/test), no other schemes, no credentials. */
export function redirectUrl(production: boolean) {
  return z
    .url()
    .max(2000)
    .refine((u) => {
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
        const r = await withTenant(deps.db, k.merchantId, (tx) =>
          loadInvoiceWithToken(tx, and(eq(invoices.id, req.params.id), eq(invoices.merchantId, k.merchantId), eq(invoices.livemode, k.livemode)) as SQL),
        );
        if (!r) throw new AppError('not_found', 'invoice not found');
        return invoiceView(r.inv, r.token, r.chain, base);
      },
    );

    app.get(
      '/invoices',
      {
        preHandler: requireApiKey(deps, 'read'),
        schema: {
          querystring: z.strictObject({
            limit: z.coerce.number().int().min(1).max(100).default(20),
            starting_after: z.uuid().optional(),
            status: z.enum(INVOICE_STATUSES).optional(),
            external_order_id: z.string().min(1).max(200).optional(),
          }),
        },
      },
      async (req) => {
        const k = requireKey(req);
        const q = req.query;
        const rows = await withTenant(deps.db, k.merchantId, (tx) =>
          tx
            .select({ inv: invoices, token: tokens, chain: chains })
            .from(invoices)
            .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
            .innerJoin(chains, eq(chains.id, invoices.chainId))
            .where(
              and(
                eq(invoices.merchantId, k.merchantId),
                eq(invoices.livemode, k.livemode),
                q.starting_after ? lt(invoices.id, q.starting_after) : undefined,
                q.status ? eq(invoices.status, q.status) : undefined,
                q.external_order_id ? eq(invoices.externalOrderId, q.external_order_id) : undefined,
              ),
            )
            // UUIDv7 ids are time-ordered: newest first, stable cursor.
            .orderBy(desc(invoices.id))
            .limit(q.limit + 1),
        );
        const page = rows.slice(0, q.limit);
        return {
          data: page.map((r) => invoiceView(r.inv, r.token, r.chain, base)),
          has_more: rows.length > q.limit,
          next_cursor: rows.length > q.limit ? (page.at(-1)?.inv.id ?? null) : null,
        };
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
