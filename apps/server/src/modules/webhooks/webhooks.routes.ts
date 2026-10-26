// Webhook endpoints (dashboard): configuration, secret rotation, delivery log and manual retry. Delivery: delivery.ts.
import { AppError, uuidv7 } from '@gw/core';
import { and, count, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { randomBase62 } from '../../common/crypto/random.js';
import { withTenant } from '../../common/db.js';
import { outboxEvents, webhookDeliveries, webhookEndpoints } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requirePermission, requireTotp, requireUser, requireVerifiedEmailForLive } from '../auth/guards.js';
import { redirectUrl } from '../invoices/invoices.routes.js';

export const MAX_ENDPOINTS_PER_MODE = 16;
export const secretAad = (id: string) => `webhook_endpoints.secret:${id}`;

type EndpointRow = typeof webhookEndpoints.$inferSelect;
const view = (w: EndpointRow) => ({
  id: w.id,
  livemode: w.livemode,
  url: w.url,
  description: w.description,
  previous_secret_expires_at: w.previousSecretExpiresAt?.toISOString() ?? null,
  created_at: w.createdAt.toISOString(),
});

type DeliveryRow = typeof webhookDeliveries.$inferSelect;
const deliveryView = (d: DeliveryRow, eventType: string) => ({
  id: d.id,
  event_id: d.eventId,
  event_type: eventType,
  status: d.status,
  attempts: d.attempts,
  next_attempt_at: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
  last_attempt_at: d.lastAttemptAt?.toISOString() ?? null,
  last_status_code: d.lastStatusCode,
  last_error: d.lastError,
  created_at: d.createdAt.toISOString(),
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
        preHandler: [requirePermission('webhooks:manage'), requireVerifiedEmailForLive(deps), requireTotp(deps)],
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

    // New secret now; the old one keeps signing (second v1) for the grace period so receivers can switch over.
    app.post(
      '/:id/rotate-secret',
      {
        preHandler: [requirePermission('webhooks:manage'), requireTotp(deps)],
        schema: { params: z.strictObject({ id: z.uuid() }), body: z.strictObject({ expire_previous_in_hours: z.number().int().min(0).max(72).default(24) }) },
      },
      async (req) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        const hours = req.body.expire_previous_in_hours;
        const secret = `whsec_${randomBase62(40)}`;
        const row = await withTenant(deps.db, user.merchantId, async (tx) => {
          const [w] = await tx
            .select()
            .from(webhookEndpoints)
            .where(and(eq(webhookEndpoints.id, req.params.id), eq(webhookEndpoints.merchantId, user.merchantId)))
            .for('update');
          if (!w) throw new AppError('not_found', 'webhook endpoint not found');
          const [next] = await tx
            .update(webhookEndpoints)
            .set({
              secretEnc: await deps.envelope.seal(secret, secretAad(w.id)),
              previousSecretEnc: hours > 0 ? w.secretEnc : null,
              previousSecretExpiresAt: hours > 0 ? new Date(deps.clock() + hours * 3_600_000) : null,
            })
            .where(eq(webhookEndpoints.id, w.id))
            .returning();
          /* v8 ignore next -- row locked above */
          if (!next) throw new Error('webhook endpoint update failed');
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'webhook_endpoint.secret_rotated', targetType: 'webhook_endpoint', targetId: w.id, after: { expire_previous_in_hours: hours } }, req);
          return next;
        });
        return { ...view(row), secret };
      },
    );

    app.get(
      '/:id/deliveries',
      {
        preHandler: requirePermission('webhooks:manage'),
        schema: {
          params: z.strictObject({ id: z.uuid() }),
          querystring: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20), starting_after: z.uuid().optional() }),
        },
      },
      async (req) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        const { limit, starting_after } = req.query;
        const rows = await withTenant(deps.db, user.merchantId, (tx) =>
          tx
            .select({ d: webhookDeliveries, type: outboxEvents.type })
            .from(webhookDeliveries)
            .innerJoin(outboxEvents, eq(outboxEvents.id, webhookDeliveries.eventId))
            .where(
              and(
                eq(webhookDeliveries.endpointId, req.params.id),
                eq(webhookDeliveries.merchantId, user.merchantId),
                starting_after ? lt(webhookDeliveries.seq, sql`(select seq from ${webhookDeliveries} where id = ${starting_after})`) : undefined,
              ),
            )
            .orderBy(desc(webhookDeliveries.seq))
            .limit(limit + 1),
        );
        const page = rows.slice(0, limit);
        return { data: page.map((r) => deliveryView(r.d, r.type)), has_more: rows.length > limit, next_cursor: rows.length > limit ? (page.at(-1)?.d.id ?? null) : null };
      },
    );

    // Resend a finished delivery now (fresh retry budget). Pending ones are already scheduled (and may be in flight).
    app.post(
      '/:id/deliveries/:deliveryId/retry',
      { preHandler: requirePermission('webhooks:manage'), schema: { params: z.strictObject({ id: z.uuid(), deliveryId: z.uuid() }) } },
      async (req) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        return withTenant(deps.db, user.merchantId, async (tx) => {
          const mine = and(eq(webhookDeliveries.id, req.params.deliveryId), eq(webhookDeliveries.endpointId, req.params.id), eq(webhookDeliveries.merchantId, user.merchantId));
          const [d] = await tx.select().from(webhookDeliveries).where(mine).for('update');
          if (!d) throw new AppError('not_found', 'delivery not found');
          if (d.status === 'pending') throw new AppError('conflict', 'delivery is already scheduled');
          const [next] = await tx
            .update(webhookDeliveries)
            .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(deps.clock()) })
            .where(eq(webhookDeliveries.seq, d.seq))
            .returning();
          /* v8 ignore next -- row locked above */
          if (!next) throw new Error('delivery update failed');
          const [ev] = await tx.select({ type: outboxEvents.type }).from(outboxEvents).where(eq(outboxEvents.id, d.eventId));
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'webhook_delivery.retried', targetType: 'webhook_delivery', targetId: d.id }, req);
          return deliveryView(next, ev?.type ?? '');
        });
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
