// Reusable payment links. Each paying visitor gets a fresh invoice (= a fresh derivation index), so creation is
// guarded: POST only (link previews/prefetchers cannot burn addresses), per-IP rate limit, and a per-link cap on
// simultaneously pending invoices (bounds the address gap a non-custodial wallet must scan).
import { AppError, fromMinorUnits } from '@gw/core';
import { and, count, desc, eq, lt } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../common/db.js';
import { requestHash, withIdempotency } from '../../common/idempotency.js';
import { invoices, paymentLinks, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { STRINGS, html, sendPage } from '../checkout/html.js';
import { EXPIRY_S, createInvoice, parseInvoiceAmount, resolveToken } from '../invoices/invoices.js';
import { Metadata, TokenId, idempotencyKeyOf, redirectUrl, sendStored } from '../invoices/invoices.routes.js';

export const PAY_RATE_LIMIT = { max: 5, timeWindow: '10 minutes' } as const;

type LinkRow = typeof paymentLinks.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;

function linkView(l: LinkRow, t: TokenRow, baseUrl: string) {
  return {
    id: l.id,
    object: 'payment_link' as const,
    livemode: l.livemode,
    active: l.active,
    url: `${baseUrl}/pay/${l.id}`,
    amount: fromMinorUnits(l.amount, t.decimals),
    token: t.id,
    symbol: t.symbol,
    description: l.description,
    metadata: l.metadata,
    expires_in: l.expiresInSeconds,
    success_url: l.successUrl,
    cancel_url: l.cancelUrl,
    max_pending_invoices: l.maxPendingInvoices,
    created_at: l.createdAt.toISOString(),
  };
}

async function loadOwnLink(tx: Tx, id: string, merchantId: string, livemode: boolean) {
  const [r] = await tx
    .select({ link: paymentLinks, token: tokens })
    .from(paymentLinks)
    .innerJoin(tokens, eq(tokens.id, paymentLinks.tokenId))
    .where(and(eq(paymentLinks.id, id), eq(paymentLinks.merchantId, merchantId), eq(paymentLinks.livemode, livemode)));
  if (!r) throw new AppError('not_found', 'payment link not found');
  return r;
}

export function paymentLinkRoutes(deps: Deps): FastifyPluginAsyncZod {
  const base = deps.config.PUBLIC_BASE_URL;
  const production = deps.config.NODE_ENV === 'production';
  const Fields = {
    description: z.string().max(500).optional(),
    metadata: Metadata.optional(),
    expires_in: z.number().int().min(EXPIRY_S.min).max(EXPIRY_S.max).optional(),
    success_url: redirectUrl(production).optional(),
    cancel_url: redirectUrl(production).optional(),
    max_pending_invoices: z.number().int().min(1).max(1000).optional(),
  };
  const Create = z.strictObject({ amount: z.string().max(100), token: TokenId, ...Fields });
  const Patch = z.strictObject({ amount: z.string().max(100).optional(), active: z.boolean().optional(), ...Fields });
  const IdParams = z.strictObject({ id: z.uuid() });

  return async (app) => {
    app.post('/payment-links', { preHandler: requireApiKey(deps, 'invoices:write'), schema: { body: Create } }, async (req, reply) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const b = req.body;
      const res = await withIdempotency(deps, k, idempotencyKeyOf(req), requestHash('POST', '/v1/payment-links', b), async (tx) => {
        const { token } = await resolveToken(tx, b.token, k.livemode);
        const [l] = await tx
          .insert(paymentLinks)
          .values({
            merchantId: k.merchantId,
            livemode: k.livemode,
            tokenId: token.id,
            amount: parseInvoiceAmount(b.amount, token),
            description: b.description ?? null,
            metadata: b.metadata ?? {},
            expiresInSeconds: b.expires_in ?? EXPIRY_S.default,
            successUrl: b.success_url ?? null,
            cancelUrl: b.cancel_url ?? null,
            maxPendingInvoices: b.max_pending_invoices ?? 20,
          })
          .returning();
        if (!l) throw new Error('payment link insert failed');
        return { status: 201, body: linkView(l, token, base) };
      });
      return sendStored(reply, res);
    });

    app.get(
      '/payment-links',
      {
        preHandler: requireApiKey(deps, 'read'),
        schema: { querystring: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20), starting_after: z.uuid().optional() }) },
      },
      async (req) => {
        const k = req.apiKey;
        if (!k) throw new AppError('unauthorized', 'API key required');
        const rows = await withTenant(deps.db, k.merchantId, (tx) =>
          tx
            .select({ link: paymentLinks, token: tokens })
            .from(paymentLinks)
            .innerJoin(tokens, eq(tokens.id, paymentLinks.tokenId))
            .where(
              and(
                eq(paymentLinks.merchantId, k.merchantId),
                eq(paymentLinks.livemode, k.livemode),
                req.query.starting_after ? lt(paymentLinks.id, req.query.starting_after) : undefined,
              ),
            )
            .orderBy(desc(paymentLinks.id))
            .limit(req.query.limit + 1),
        );
        const page = rows.slice(0, req.query.limit);
        return {
          data: page.map((r) => linkView(r.link, r.token, base)),
          has_more: rows.length > req.query.limit,
          next_cursor: rows.length > req.query.limit ? (page.at(-1)?.link.id ?? null) : null,
        };
      },
    );

    app.get('/payment-links/:id', { preHandler: requireApiKey(deps, 'read'), schema: { params: IdParams } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const r = await withTenant(deps.db, k.merchantId, (tx) => loadOwnLink(tx, req.params.id, k.merchantId, k.livemode));
      return linkView(r.link, r.token, base);
    });

    // Changes affect future invoices only; existing invoices keep their own amount (immutable).
    app.patch('/payment-links/:id', { preHandler: requireApiKey(deps, 'invoices:write'), schema: { params: IdParams, body: Patch } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const b = req.body;
      return withTenant(deps.db, k.merchantId, async (tx) => {
        const { token } = await loadOwnLink(tx, req.params.id, k.merchantId, k.livemode);
        const [l] = await tx
          .update(paymentLinks)
          .set({
            ...(b.amount === undefined ? {} : { amount: parseInvoiceAmount(b.amount, token) }),
            ...(b.active === undefined ? {} : { active: b.active }),
            ...(b.description === undefined ? {} : { description: b.description }),
            ...(b.metadata === undefined ? {} : { metadata: b.metadata }),
            ...(b.expires_in === undefined ? {} : { expiresInSeconds: b.expires_in }),
            ...(b.success_url === undefined ? {} : { successUrl: b.success_url }),
            ...(b.cancel_url === undefined ? {} : { cancelUrl: b.cancel_url }),
            ...(b.max_pending_invoices === undefined ? {} : { maxPendingInvoices: b.max_pending_invoices }),
          })
          .where(eq(paymentLinks.id, req.params.id))
          .returning();
        if (!l) throw new AppError('not_found', 'payment link not found');
        return linkView(l, token, base);
      });
    });

    // Links are never deleted (invoices reference them); DELETE deactivates.
    app.delete('/payment-links/:id', { preHandler: requireApiKey(deps, 'invoices:write'), schema: { params: IdParams } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, async (tx) => {
        const { token } = await loadOwnLink(tx, req.params.id, k.merchantId, k.livemode);
        const [l] = await tx.update(paymentLinks).set({ active: false }).where(eq(paymentLinks.id, req.params.id)).returning();
        if (!l) throw new AppError('not_found', 'payment link not found');
        return linkView(l, token, base);
      });
    });
  };
}

/** Public pages: GET shows the offer, POST creates the invoice and redirects to hosted checkout. */
export function publicPayRoutes(deps: Deps): FastifyPluginAsyncZod {
  const S = STRINGS.en;
  const Params = z.strictObject({ id: z.string().max(64) });

  const loadPublic = async (id: string) => {
    if (!z.uuid().safeParse(id).success) return undefined;
    const [r] = await withSystem(deps.db, (tx) =>
      tx.select({ link: paymentLinks, token: tokens }).from(paymentLinks).innerJoin(tokens, eq(tokens.id, paymentLinks.tokenId)).where(eq(paymentLinks.id, id)),
    );
    return r;
  };

  const notAvailable = (reply: Parameters<typeof sendPage>[0], msg: string, status: number) =>
    sendPage(reply, { title: msg, status, body: () => html`<div class="card"><h1>${msg}</h1></div>` });

  return async (app) => {
    // The HTML form posts an empty urlencoded body; nothing in it is used.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, _body, done) => {
      done(null, {});
    });

    app.get('/pay/:id', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { params: Params, hide: true } }, async (req, reply) => {
      const r = await loadPublic(req.params.id);
      if (!r?.link.active) return notAvailable(reply, S.linkInactive, 404);
      return sendPage(reply, {
        title: S.pay,
        body: () => html`<div class="card">
  ${r.link.livemode ? '' : html`<div class="test">${S.testMode}</div>`}
  <div class="label">${S.pay}</div>
  <div class="amount">${fromMinorUnits(r.link.amount, r.token.decimals)} ${r.token.symbol}</div>
  ${r.link.description ? html`<p class="desc">${r.link.description}</p>` : ''}
  <form method="post" action="/pay/${r.link.id}"><button class="primary" type="submit">${S.continue}</button></form>
</div>`,
      });
    });

    app.post('/pay/:id', { config: { rateLimit: PAY_RATE_LIMIT }, schema: { params: Params, hide: true } }, async (req, reply) => {
      const r = await loadPublic(req.params.id);
      if (!r?.link.active) return notAvailable(reply, S.linkInactive, 404);
      const link = r.link;
      const invoiceId = await withTenant(deps.db, link.merchantId, async (tx) => {
        // Lock the link row: the pending-count check and the insert are atomic per link.
        const [locked] = await tx.select().from(paymentLinks).where(eq(paymentLinks.id, link.id)).for('update');
        if (!locked?.active) return 'inactive' as const;
        const [p] = await tx
          .select({ n: count() })
          .from(invoices)
          .where(and(eq(invoices.paymentLinkId, link.id), eq(invoices.status, 'pending')));
        if ((p?.n ?? 0) >= locked.maxPendingInvoices) return 'full' as const;
        const inv = await createInvoice(deps, tx, locked.merchantId, locked.livemode, {
          amount: fromMinorUnits(locked.amount, r.token.decimals),
          token: locked.tokenId,
          description: locked.description ?? undefined,
          metadata: locked.metadata as Record<string, string>,
          expiresInSeconds: locked.expiresInSeconds,
          successUrl: locked.successUrl ?? undefined,
          cancelUrl: locked.cancelUrl ?? undefined,
          paymentLinkId: locked.id,
        });
        return inv.id;
      });
      if (invoiceId === 'inactive') return notAvailable(reply, S.linkInactive, 404);
      if (invoiceId === 'full') return notAvailable(reply, S.tooMany, 429);
      return reply.redirect(`/checkout/${invoiceId}`, 303);
    });
  };
}
