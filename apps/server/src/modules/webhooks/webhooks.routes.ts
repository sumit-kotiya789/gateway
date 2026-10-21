// Webhook endpoint configuration. Delivery, signing, retries, SSRF guard and secret rotation arrive in M6.
import { AppError, uuidv7 } from '@gw/core';
import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { randomBase62 } from '../../common/crypto/random.js';
import { withTenant } from '../../common/db.js';
import { webhookEndpoints } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requirePermission, requireTotp, requireUser } from '../auth/guards.js';
import { redirectUrl } from '../invoices/invoices.routes.js';

export const MAX_ENDPOINTS_PER_MODE = 16;
export const secretAad = (id: string) => `webhook_endpoints.secret:${id}`;

type EndpointRow = typeof webhookEndpoints.$inferSelect;
const view = (w: EndpointRow) => ({
  id: w.id,
  livemode: w.livemode,
  url: w.url,
  description: w.description,
  created_at: w.createdAt.toISOString(),
});

export function webhookDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  const Url = redirectUrl(deps.config.NODE_ENV === 'production');

  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get(
      '/',
      { preHandler: requirePermission('webhooks:manage'), schema: { querystring: z.strictObject({ livemode: z.stringbool().default(false) }) } },
      async (req) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        const rows = await withTenant(deps.db, user.merchantId, (tx) =>
          tx
            .select()
            .from(webhookEndpoints)
            .where(and(eq(webhookEndpoints.merchantId, user.merchantId), eq(webhookEndpoints.livemode, req.query.livemode)))
            .orderBy(desc(webhookEndpoints.createdAt)),
        );
        return { data: rows.map(view) };
      },
    );

    app.post(
      '/',
      {
        preHandler: [requirePermission('webhooks:manage'), requireTotp(deps)],
        schema: { body: z.strictObject({ livemode: z.boolean(), url: Url, description: z.string().trim().max(200).optional() }) },
      },
      async (req, reply) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        const b = req.body;
        const secret = `whsec_${randomBase62(40)}`;
        const row = await withTenant(deps.db, user.merchantId, async (tx) => {
          // ponytail: count-then-insert can overshoot by one under concurrent creates; fine for a soft limit.
          const [n] = await tx
            .select({ n: count() })
            .from(webhookEndpoints)
            .where(and(eq(webhookEndpoints.merchantId, user.merchantId), eq(webhookEndpoints.livemode, b.livemode)));
          if ((n?.n ?? 0) >= MAX_ENDPOINTS_PER_MODE) throw new AppError('conflict', `at most ${MAX_ENDPOINTS_PER_MODE} webhook endpoints per mode`);
          const id = uuidv7();
          const [w] = await tx
            .insert(webhookEndpoints)
            .values({
              id,
              merchantId: user.merchantId,
              livemode: b.livemode,
              url: b.url,
              description: b.description || null,
              // AAD binds the ciphertext to this row.
              secretEnc: await deps.envelope.seal(secret, secretAad(id)),
              createdBy: user.id,
            })
            .returning();
          if (!w) throw new Error('webhook endpoint insert failed');
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'webhook_endpoint.created', targetType: 'webhook_endpoint', targetId: w.id, after: view(w) }, req);
          return w;
        });
        // The only time the signing secret is returned.
        return reply.status(201).send({ ...view(row), secret });
      },
    );

    app.delete(
      '/:id',
      { preHandler: requirePermission('webhooks:manage'), schema: { params: z.strictObject({ id: z.uuid() }) } },
      async (req, reply) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        await withTenant(deps.db, user.merchantId, async (tx) => {
          const [w] = await tx
            .delete(webhookEndpoints)
            .where(and(eq(webhookEndpoints.id, req.params.id), eq(webhookEndpoints.merchantId, user.merchantId)))
            .returning();
          if (!w) throw new AppError('not_found', 'webhook endpoint not found');
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'webhook_endpoint.deleted', targetType: 'webhook_endpoint', targetId: w.id, before: view(w) }, req);
        });
        return reply.status(204).send();
      },
    );
  };
}
