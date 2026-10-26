import { isIP } from 'node:net';
import { AppError, PUBLISHABLE_KEY_SCOPES, SECRET_KEY_SCOPES } from '@gw/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant } from '../../common/db.js';
import { apiKeys } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requirePermission, requireTotp, requireUser, requireVerifiedEmailForLive } from '../auth/guards.js';
import { generateApiKey, hashApiKey, requireApiKey } from './api-keys.js';

const Cidr = z.string().refine((s) => {
  const [ip = '', bits] = s.split('/');
  const v = isIP(ip);
  if (v === 0) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d{1,3}$/.test(bits) && n <= (v === 4 ? 32 : 128);
}, 'must be an IP address or CIDR');

const CreateKey = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['secret', 'publishable']),
    livemode: z.boolean(),
    scopes: z.array(z.enum([...SECRET_KEY_SCOPES, ...PUBLISHABLE_KEY_SCOPES])).min(1).max(10).optional(),
    ip_allowlist: z.array(Cidr).min(1).max(50).optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.kind === 'secret' && (!b.scopes || b.scopes.includes('checkout'))) {
      ctx.addIssue({ code: 'custom', path: ['scopes'], message: 'secret keys need explicit scopes and cannot use checkout' });
    }
    if (b.kind === 'publishable' && b.scopes !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['scopes'], message: 'publishable keys have fixed scope checkout' });
    }
  });

type KeyRow = typeof apiKeys.$inferSelect;
const view = (k: KeyRow) => ({
  id: k.id,
  name: k.name,
  kind: k.kind,
  livemode: k.livemode,
  prefix: k.prefix,
  scopes: k.scopes,
  ip_allowlist: k.ipAllowlist,
  expires_at: k.expiresAt,
  revoked_at: k.revokedAt,
  last_used_at: k.lastUsedAt,
  created_at: k.createdAt,
});

export function apiKeyDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('api_keys:read') }, async (req) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      const rows = await withTenant(deps.db, user.merchantId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.merchantId, user.merchantId)).orderBy(desc(apiKeys.createdAt)),
      );
      return { data: rows.map(view) };
    });

    app.post(
      '/',
      { preHandler: [requirePermission('api_keys:write'), requireVerifiedEmailForLive(deps), requireTotp(deps)], schema: { body: CreateKey } },
      async (req, reply) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        const b = req.body;
        if (b.expires_at && Date.parse(b.expires_at) <= deps.clock()) {
          throw new AppError('validation_error', 'expires_at must be in the future');
        }
        const { key, prefix } = generateApiKey(b.kind, b.livemode);
        const row = await withTenant(deps.db, user.merchantId, async (tx) => {
          const [k] = await tx
            .insert(apiKeys)
            .values({
              merchantId: user.merchantId,
              kind: b.kind,
              livemode: b.livemode,
              name: b.name,
              prefix,
              secretHash: hashApiKey(deps.config.API_KEY_PEPPER, key),
              scopes: b.kind === 'publishable' ? [...PUBLISHABLE_KEY_SCOPES] : (b.scopes ?? []),
              ipAllowlist: b.ip_allowlist ?? null,
              expiresAt: b.expires_at ? new Date(b.expires_at) : null,
              createdBy: user.id,
            })
            .returning();
          if (!k) throw new Error('api key insert failed');
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'api_key.created', targetType: 'api_key', targetId: k.id, after: view(k) }, req);
          return k;
        });
        // The only time the full key is ever returned.
        return reply.status(201).send({ ...view(row), key });
      },
    );

    app.delete(
      '/:id',
      { preHandler: requirePermission('api_keys:write'), schema: { params: z.strictObject({ id: z.uuid() }) } },
      async (req, reply) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        await withTenant(deps.db, user.merchantId, async (tx) => {
          const [k] = await tx
            .update(apiKeys)
            .set({ revokedAt: new Date(deps.clock()) })
            .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.merchantId, user.merchantId), isNull(apiKeys.revokedAt)))
            .returning();
          if (!k) throw new AppError('not_found', 'API key not found');
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'api_key.revoked', targetType: 'api_key', targetId: k.id }, req);
        });
        return reply.status(204).send();
      },
    );
  };
}

/** Merchant API (API-key auth). */
export function accountRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/account', { preHandler: requireApiKey(deps, 'read') }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      const m = await withTenant(deps.db, k.merchantId, (tx) =>
        tx.query.merchants.findFirst({ where: (t, { eq: e }) => e(t.id, k.merchantId) }),
      );
      if (!m) throw new AppError('unauthorized', 'invalid API key');
      return { merchant_id: m.id, name: m.name, custody_mode: m.custodyMode, livemode: k.livemode, scopes: k.scopes };
    });
  };
}
