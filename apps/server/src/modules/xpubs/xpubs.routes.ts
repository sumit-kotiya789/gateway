// MONEY-CRITICAL
// Dashboard routes for the merchant's payout xpub. The rules live in xpubs.ts; these handlers bound the input, check
// permissions and step-up TOTP, and run each action in one tenant transaction.
import { AppError } from '@gw/core';
import { evmDeriver } from '@gw/chains';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenant } from '../../common/db.js';
import { merchantXpubs } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { authedUser, requirePermission, requireTotp, requireUser, requireVerifiedEmailForLive } from '../auth/guards.js';
import { ownershipMessage } from './ownership.js';
import { cancelXpubChange, changeView, derivationReport, pendingChange, registerXpub, rejectSecretMaterial, xpubView } from './xpubs.js';

const PREVIEW_COUNT = 5;
// Bounded before the deriver sees it; the deriver does the real validation and never echoes the input.
const Xpub = z.string().trim().min(1).max(200);
const Livemode = z.stringbool().default(false);
const Ownership = z.strictObject({ issued_at: z.iso.datetime(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });

// ponytail: EVM only (the one deriver that exists); add a `family` field when a second family ships.
export function xpubDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('account:read'), schema: { querystring: z.strictObject({ livemode: Livemode }) } }, async (req) => {
      const user = authedUser(req);
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const rows = await tx
          .select()
          .from(merchantXpubs)
          .where(and(eq(merchantXpubs.merchantId, user.merchantId), eq(merchantXpubs.livemode, req.query.livemode)))
          .orderBy(desc(merchantXpubs.createdAt));
        const pending = await pendingChange(tx, user.merchantId, req.query.livemode);
        return { data: rows.map(xpubView), pending_change: pending ? changeView(pending) : null };
      });
    });

    /** First addresses to compare with the wallet, plus the ownership challenge to sign with address 0/0. */
    app.post(
      '/preview',
      { preHandler: requirePermission('custody:manage'), schema: { body: z.strictObject({ xpub: Xpub, livemode: z.boolean().default(false) }) } },
      async (req) => {
        const user = authedUser(req);
        await rejectSecretMaterial(deps, user, req.body.xpub, req);
        const fingerprint = evmDeriver.keyFingerprint(req.body.xpub).slice(0, 16); // validates; refuses private keys
        const addresses = Array.from({ length: PREVIEW_COUNT }, (_, i) => ({ index: i, ...evmDeriver.deriveFromXpub(req.body.xpub, i) }));
        const issuedAt = new Date(deps.clock()).toISOString();
        const challenge = { merchantId: user.merchantId, livemode: req.body.livemode, fingerprint, address: addresses[0]?.address ?? '', issuedAt };
        return { fingerprint, addresses, ownership_challenge: { message: ownershipMessage(challenge), address: challenge.address, issued_at: issuedAt } };
      },
    );

    /**
     * Registers an xpub (201, active now) or, for a live key replacing an active one, queues it behind the cooldown
     * (202, pending change). Live keys need the signed ownership challenge from /preview.
     */
    app.post(
      '/',
      {
        preHandler: [requirePermission('custody:manage'), requireVerifiedEmailForLive(deps), requireTotp(deps)],
        schema: { body: z.strictObject({ livemode: z.boolean(), xpub: Xpub, ownership: Ownership.optional() }) },
      },
      async (req, reply) => {
        const user = authedUser(req);
        const { livemode, xpub, ownership } = req.body;
        await rejectSecretMaterial(deps, user, xpub, req);
        const input = { livemode, xpub, ownership: ownership && { issuedAt: ownership.issued_at, signature: ownership.signature } };
        const r = await withTenant(deps.db, user.merchantId, (tx) => registerXpub(deps, tx, user, input, req));
        return r.kind === 'active' ? reply.status(201).send(xpubView(r.xpub)) : reply.status(202).send({ pending_change: changeView(r.change) });
      },
    );

    app.post(
      '/changes/:id/cancel',
      { preHandler: requirePermission('custody:manage'), schema: { params: z.strictObject({ id: z.uuid() }) } },
      async (req) => {
        const user = authedUser(req);
        return changeView(await withTenant(deps.db, user.merchantId, (tx) => cancelXpubChange(deps, tx, user, req.params.id, req)));
      },
    );

    /** Derived addresses of one xpub with the invoice each serves, and the wallet gap limit needed to see them all. */
    app.get(
      '/:id/addresses',
      {
        preHandler: requirePermission('account:read'),
        schema: {
          params: z.strictObject({ id: z.uuid() }),
          querystring: z.strictObject({ offset: z.coerce.number().int().min(0).max(2_147_483_647).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }),
        },
      },
      async (req) => {
        const user = authedUser(req);
        return withTenant(deps.db, user.merchantId, async (tx) => {
          const [x] = await tx.select().from(merchantXpubs).where(and(eq(merchantXpubs.id, req.params.id), eq(merchantXpubs.merchantId, user.merchantId)));
          if (!x) throw new AppError('not_found', 'xpub not found');
          return derivationReport(tx, x, req.query.offset, req.query.limit);
        });
      },
    );
  };
}
