// MONEY-CRITICAL
// Merchant xpub registration (non-custodial). Every future deposit address of the mode derives from the active xpub:
// a wrong key sends customer funds to addresses the merchant cannot spend. Safeguards: private keys refused by the
// deriver, preview of the first addresses before registering, owner-only + fresh TOTP, audited. Ownership proof: M8.
import { AppError } from '@gw/core';
import { evmDeriver } from '@gw/chains';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant } from '../../common/db.js';
import { merchantXpubs, merchants } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requirePermission, requireTotp, requireUser } from '../auth/guards.js';

const PREVIEW_COUNT = 5;
// Bounded before the deriver sees it; the deriver does the real validation and never echoes the input.
const Xpub = z.string().trim().min(1).max(200);
const Livemode = z.stringbool().default(false);

type XpubRow = typeof merchantXpubs.$inferSelect;

/** The full xpub is never returned: it reveals every address (privacy). Fingerprint + first address identify it. */
export function xpubView(x: XpubRow) {
  return {
    id: x.id,
    family: x.family,
    livemode: x.livemode,
    status: x.status,
    xpub_hint: `${x.xpub.slice(0, 8)}…${x.xpub.slice(-6)}`,
    fingerprint: x.keyFingerprint.slice(0, 16),
    first_address: evmDeriver.deriveFromXpub(x.xpub, 0).address,
    next_index: x.nextIndex,
    retired_at: x.retiredAt?.toISOString() ?? null,
    created_at: x.createdAt.toISOString(),
  };
}

function preview(xpub: string) {
  const fingerprint = evmDeriver.keyFingerprint(xpub); // validates; refuses private keys
  return {
    fingerprint: fingerprint.slice(0, 16),
    addresses: Array.from({ length: PREVIEW_COUNT }, (_, i) => ({ index: i, ...evmDeriver.deriveFromXpub(xpub, i) })),
  };
}

// ponytail: EVM only (the one deriver that exists); add a `family` field when a second family ships.
export function xpubDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('account:read'), schema: { querystring: z.strictObject({ livemode: Livemode }) } }, async (req) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      const rows = await withTenant(deps.db, user.merchantId, (tx) =>
        tx
          .select()
          .from(merchantXpubs)
          .where(and(eq(merchantXpubs.merchantId, user.merchantId), eq(merchantXpubs.livemode, req.query.livemode)))
          .orderBy(desc(merchantXpubs.createdAt)),
      );
      return { data: rows.map(xpubView) };
    });

    app.post(
      '/preview',
      { preHandler: requirePermission('custody:manage'), schema: { body: z.strictObject({ xpub: Xpub }) } },
      async (req) => preview(req.body.xpub),
    );

    /** Registers a new active xpub; the previous active one (if any) is retired in the same transaction. */
    app.post(
      '/',
      {
        preHandler: [requirePermission('custody:manage'), requireTotp(deps)],
        schema: { body: z.strictObject({ livemode: z.boolean(), xpub: Xpub }) },
      },
      async (req, reply) => {
        const user = req.user;
        if (!user) throw new AppError('unauthorized', 'authentication required');
        const { livemode, xpub } = req.body;
        const fingerprint = evmDeriver.keyFingerprint(xpub);
        const row = await withTenant(deps.db, user.merchantId, async (tx) => {
          const [m] = await tx.select({ mode: merchants.custodyMode }).from(merchants).where(eq(merchants.id, user.merchantId));
          if (m?.mode !== 'non_custodial_xpub') throw new AppError('conflict', 'xpubs are only used in non-custodial xpub mode');
          const active = and(
            eq(merchantXpubs.merchantId, user.merchantId),
            eq(merchantXpubs.family, 'evm'),
            eq(merchantXpubs.livemode, livemode),
            eq(merchantXpubs.status, 'active'),
          );
          const [prev] = await tx.select().from(merchantXpubs).where(active).for('update');
          if (prev?.keyFingerprint === fingerprint) throw new AppError('conflict', 'this xpub is already active');
          if (prev) await tx.update(merchantXpubs).set({ status: 'retired', retiredAt: new Date(deps.clock()) }).where(eq(merchantXpubs.id, prev.id));
          // Unique fingerprint across all merchants and platform wallets (D-038): a reused key fails here as 409.
          const [x] = await tx
            .insert(merchantXpubs)
            .values({ merchantId: user.merchantId, family: 'evm', livemode, xpub, keyFingerprint: fingerprint })
            .returning();
          if (!x) throw new Error('xpub insert failed');
          const after = xpubView(x);
          await audit(
            tx,
            {
              actorType: 'merchant_user',
              actorId: user.id,
              merchantId: user.merchantId,
              action: 'xpub.registered',
              targetType: 'merchant_xpub',
              targetId: x.id,
              before: prev ? { id: prev.id, fingerprint: prev.keyFingerprint.slice(0, 16), next_index: prev.nextIndex } : null,
              after: { livemode, fingerprint: after.fingerprint, first_address: after.first_address },
            },
            req,
          );
          return x;
        });
        return reply.status(201).send(xpubView(row));
      },
    );
  };
}
