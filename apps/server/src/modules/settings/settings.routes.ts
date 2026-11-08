// Merchant settings managed from the dashboard (M10): which sites may embed the hosted checkout (widget), and how the
// merchant receives payments: own xpub, a wallet address with per-invoice forwarders (D-097), or custody on: the
// platform holds the funds and the merchant withdraws them (D-098). The merchant chooses, not an admin.
import { AppError } from '@gw/core';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant } from '../../common/db.js';
import { merchants } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { authedUser, requirePermission, requireTotp, requireUser } from '../auth/guards.js';
import { assertNothingInCustody } from '../custody/custody-mode.js';

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
      const [m] = await withTenant(deps.db, user.merchantId, (tx) =>
        tx.select({ origins: merchants.widgetOrigins, mode: merchants.custodyMode }).from(merchants).where(eq(merchants.id, user.merchantId)),
      );
      if (!m) throw new AppError('not_found', 'merchant not found');
      return { widget_origins: m.origins, receiving_mode: m.mode, forwarder_available: deps.config.FEATURE_FORWARDER, custodial_available: deps.config.FEATURE_CUSTODIAL };
    });

    /**
     * Receiving mode, chosen by the merchant (owner + 2FA): `non_custodial_xpub` (own xpub, a derived address per
     * invoice), `non_custodial_forwarder` (a wallet address; each invoice gets a forwarder that pays it, fee split
     * on-chain, D-097) or `custodial` (custody on: the platform holds the funds, the merchant withdraws, D-098). Each
     * needs its feature on. Turning custody off is refused while the platform holds or expects funds for the merchant.
     * Existing invoices keep the mode they were created with; the database locks the mode after the first live invoice.
     */
    app.put(
      '/receiving-mode',
      {
        preHandler: [requirePermission('custody:manage'), requireTotp(deps)],
        schema: { body: z.strictObject({ mode: z.enum(['non_custodial_xpub', 'non_custodial_forwarder', 'custodial']) }) },
      },
      async (req) => {
        const user = authedUser(req);
        const mode = req.body.mode;
        if (mode === 'non_custodial_forwarder' && !deps.config.FEATURE_FORWARDER) {
          throw new AppError('forbidden', 'wallet-address (forwarder) mode is not enabled on this deployment');
        }
        if (mode === 'custodial' && !deps.config.FEATURE_CUSTODIAL) {
          throw new AppError('forbidden', 'custody is off on this platform', { reason: 'custody_off' });
        }
        return withTenant(deps.db, user.merchantId, async (tx) => {
          const [before] = await tx.select({ mode: merchants.custodyMode }).from(merchants).where(eq(merchants.id, user.merchantId)).for('update');
          if (!before) throw new AppError('not_found', 'merchant not found');
          if (before.mode === mode) return { receiving_mode: mode };
          if (before.mode === 'custodial') await assertNothingInCustody(tx, user.merchantId);
          try {
            await tx.update(merchants).set({ custodyMode: mode }).where(eq(merchants.id, user.merchantId));
          } catch (err) {
            const msg = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
            if (/locked after the first live invoice/.test(msg)) throw new AppError('conflict', 'the receiving mode is locked after the first live invoice', { reason: 'mode_locked' });
            throw err;
          }
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'settings.receiving_mode', before: { mode: before.mode }, after: { mode } }, req);
          return { receiving_mode: mode };
        });
      },
    );

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
