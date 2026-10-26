// Merchant settings managed from the dashboard (M10). Today: which sites may embed the hosted checkout (widget).
import { AppError } from '@gw/core';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant } from '../../common/db.js';
import { merchants } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';

/** An exact origin (scheme://host[:port], no path), https only in production. */
export function originSchema(production: boolean) {
  return z
    .string()
    .trim()
    .max(200)
    .refine((o) => URL.canParse(o) && new URL(o).origin === o, 'must be an exact origin like https://shop.example (no path or trailing slash)')
    .refine((o) => !URL.canParse(o) || new URL(o).protocol === 'https:' || (!production && new URL(o).protocol === 'http:'), production ? 'must be https' : 'must be http(s)');
}

export function settingsDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  const Origins = z.strictObject({ widget_origins: z.array(originSchema(deps.config.NODE_ENV === 'production')).max(10) });
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('account:read') }, async (req) => {
      const user = authedUser(req);
      const [m] = await withTenant(deps.db, user.merchantId, (tx) => tx.select({ origins: merchants.widgetOrigins }).from(merchants).where(eq(merchants.id, user.merchantId)));
      if (!m) throw new AppError('not_found', 'merchant not found');
      return { widget_origins: m.origins };
    });

    app.put('/widget-origins', { preHandler: requirePermission('settings:manage'), schema: { body: Origins } }, async (req) => {
      const user = authedUser(req);
      const origins = [...new Set(req.body.widget_origins)];
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const [before] = await tx.select({ origins: merchants.widgetOrigins }).from(merchants).where(eq(merchants.id, user.merchantId)).for('update');
        await tx.update(merchants).set({ widgetOrigins: origins }).where(eq(merchants.id, user.merchantId));
        await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'settings.widget_origins', before: { widget_origins: before?.origins ?? [] }, after: { widget_origins: origins } }, req);
        return { widget_origins: origins };
      });
    });
  };
}
