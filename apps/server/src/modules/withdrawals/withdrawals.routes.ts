// Withdrawal routes (M7d, D-090): dashboard (payout addresses, requests), merchant API (requests with a
// `withdrawals:write` key), admin console (approve / reject). Every change is audited.
import { AppError } from '@gw/core';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { requestHash, withIdempotency } from '../../common/idempotency.js';
import { withSystem, withTenant, type Tx } from '../../common/db.js';
import { merchants, tokens, withdrawals } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { authedUser, requireAdmin, requireAdminTotp, requirePermission, requireTotp, requireUser, requireVerifiedEmailForLive } from '../auth/guards.js';
import { idempotencyKeyOf, sendStored } from '../invoices/invoices.routes.js';
import {
  addPayoutAddress,
  approveWithdrawal,
  cancelPayoutAddress,
  cancelWithdrawal,
  listPayoutAddresses,
  payoutAddressView,
  rejectWithdrawal,
  requestWithdrawal,
  withdrawalView,
} from './withdrawals.js';

const Livemode = z.stringbool().default(false);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'an EVM address (0x + 40 hex characters)');
const TokenId = z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/);
const Amount = z.string().max(100);
const IdParams = z.strictObject({ id: z.uuid() });
const Reason = z.string().trim().min(3).max(500);

type Row = typeof withdrawals.$inferSelect;

async function viewMany(tx: Tx, rows: Row[]) {
  const ids = [...new Set(rows.map((r) => r.tokenId))];
  const meta = ids.length ? await tx.select({ id: tokens.id, decimals: tokens.decimals, symbol: tokens.symbol }).from(tokens).where(inArray(tokens.id, ids)) : [];
  const by = new Map(meta.map((m) => [m.id, m]));
  return rows.map((r) => withdrawalView(r, by.get(r.tokenId) ?? { decimals: 0, symbol: '' }));
}

async function listFor(tx: Tx, merchantId: string, livemode: boolean, startingAfter?: string, limit = 50) {
  const rows = await tx
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.merchantId, merchantId), eq(withdrawals.livemode, livemode), startingAfter ? lt(withdrawals.id, startingAfter) : undefined))
    .orderBy(desc(withdrawals.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { data: await viewMany(tx, page), has_more: rows.length > limit, next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

export function withdrawalDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('account:read'), schema: { querystring: z.strictObject({ livemode: Livemode, starting_after: z.uuid().optional() }) } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, (tx) => listFor(tx, u.merchantId, req.query.livemode, req.query.starting_after));
    });

    app.post(
      '/',
      {
        preHandler: [requirePermission('withdrawals:request'), requireVerifiedEmailForLive(deps), requireTotp(deps)],
        schema: { body: z.strictObject({ livemode: z.boolean().default(false), token: TokenId, amount: Amount }) },
      },
      async (req, reply) => {
        const u = authedUser(req);
        const out = await withTenant(deps.db, u.merchantId, async (tx) => {
          const w = await requestWithdrawal(deps, tx, { merchantId: u.merchantId, livemode: req.body.livemode, tokenId: req.body.token, amount: req.body.amount, requestedBy: `user:${u.id}` });
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'withdrawal.requested', targetType: 'withdrawal', targetId: w.id, after: { amount: req.body.amount, token: w.tokenId, to: w.toAddress, livemode: w.livemode } }, req);
          return (await viewMany(tx, [w]))[0];
        });
        return reply.status(201).send(out);
      },
    );

    app.post('/:id/cancel', { preHandler: requirePermission('withdrawals:request'), schema: { params: IdParams } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, async (tx) => {
        const w = await cancelWithdrawal(tx, u.merchantId, req.params.id);
        await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'withdrawal.cancelled', targetType: 'withdrawal', targetId: w.id }, req);
        return (await viewMany(tx, [w]))[0];
      });
    });

    app.get('/payout-addresses', { preHandler: requirePermission('account:read'), schema: { querystring: z.strictObject({ livemode: Livemode }) } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, async (tx) => ({ data: await listPayoutAddresses(tx, u.merchantId, req.query.livemode) }));
    });

    app.post(
      '/payout-addresses',
      {
        preHandler: [requirePermission('payouts:manage'), requireVerifiedEmailForLive(deps), requireTotp(deps)],
        schema: { body: z.strictObject({ livemode: z.boolean().default(false), address: Address, label: z.string().trim().max(100).optional() }) },
      },
      async (req, reply) => {
        const u = authedUser(req);
        const out = await withTenant(deps.db, u.merchantId, async (tx) => {
          const a = await addPayoutAddress(deps, tx, { merchantId: u.merchantId, livemode: req.body.livemode, address: req.body.address, label: req.body.label ?? null, userId: u.id });
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'payout_address.added', targetType: 'payout_address', targetId: a.id, after: { address: a.address, livemode: a.livemode, activates_at: a.activatesAt.toISOString() } }, req);
          return payoutAddressView(a, a.livemode ? 'pending' : 'current');
        });
        return reply.status(201).send(out);
      },
    );

    // Cancelling only keeps the current address: no step-up needed.
    app.post('/payout-addresses/:id/cancel', { preHandler: requirePermission('payouts:manage'), schema: { params: IdParams } }, async (req) => {
      const u = authedUser(req);
      return withTenant(deps.db, u.merchantId, async (tx) => {
        const a = await cancelPayoutAddress(tx, u.merchantId, req.params.id);
        await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'payout_address.cancelled', targetType: 'payout_address', targetId: a.id }, req);
        return payoutAddressView(a, 'cancelled');
      });
    });
  };
}

/** Merchant API: request and read withdrawals with a secret key (the key's mode). Address changes stay in the dashboard. */
export function withdrawalRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/withdrawals',
      { preHandler: requireApiKey(deps, 'withdrawals:write'), schema: { body: z.strictObject({ token: TokenId, amount: Amount }) } },
      async (req, reply) => {
        const k = req.apiKey;
        if (!k) throw new AppError('unauthorized', 'API key required');
        const res = await withIdempotency(deps, k, idempotencyKeyOf(req), requestHash('POST', '/v1/withdrawals', req.body), async (tx) => {
          const w = await requestWithdrawal(deps, tx, { merchantId: k.merchantId, livemode: k.livemode, tokenId: req.body.token, amount: req.body.amount, requestedBy: `api_key:${k.id}` });
          await audit(tx, { actorType: 'api_key', actorId: k.id, merchantId: k.merchantId, action: 'withdrawal.requested', targetType: 'withdrawal', targetId: w.id, after: { amount: req.body.amount, token: w.tokenId, to: w.toAddress, livemode: w.livemode } }, req);
          return { status: 201, body: (await viewMany(tx, [w]))[0] };
        });
        return sendStored(reply, res);
      },
    );

    app.get('/withdrawals', { preHandler: requireApiKey(deps, 'read'), schema: { querystring: z.strictObject({ starting_after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }) } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, (tx) => listFor(tx, k.merchantId, k.livemode, req.query.starting_after, req.query.limit));
    });

    app.get('/withdrawals/:id', { preHandler: requireApiKey(deps, 'read'), schema: { params: IdParams } }, async (req) => {
      const k = req.apiKey;
      if (!k) throw new AppError('unauthorized', 'API key required');
      return withTenant(deps.db, k.merchantId, async (tx) => {
        const rows = await tx.select().from(withdrawals).where(and(eq(withdrawals.id, req.params.id), eq(withdrawals.merchantId, k.merchantId), eq(withdrawals.livemode, k.livemode)));
        const [v] = await viewMany(tx, rows);
        if (!v) throw new AppError('not_found', 'withdrawal not found');
        return v;
      });
    });
  };
}

function adminId(req: FastifyRequest): string {
  /* v8 ignore next -- requireAdmin runs first */
  if (!req.admin) throw new AppError('unauthorized', 'authentication required');
  return req.admin.id;
}

/** Admin console: the approval queue. Approving moves money, so it needs step-up; rejecting does not. */
export function withdrawalAdminRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      {
        preHandler: requireAdmin(deps, 'admin:read'),
        schema: { querystring: z.strictObject({ status: z.enum(withdrawals.status.enumValues).default('pending_approval'), merchant_id: z.uuid().optional() }) },
      },
      async (req) =>
        withSystem(deps.db, async (tx) => {
          const rows = await tx
            .select({ w: withdrawals, merchantName: merchants.name })
            .from(withdrawals)
            .innerJoin(merchants, eq(merchants.id, withdrawals.merchantId))
            .where(and(eq(withdrawals.status, req.query.status), req.query.merchant_id ? eq(withdrawals.merchantId, req.query.merchant_id) : undefined))
            .orderBy(desc(withdrawals.createdAt))
            .limit(100);
          const views = await viewMany(tx, rows.map((r) => r.w));
          return {
            data: views.map((v, i) => ({
              ...v,
              merchant_id: rows[i]?.w.merchantId,
              merchant_name: rows[i]?.merchantName,
              approved_by: rows[i]?.w.approvedBy ?? [],
              last_error: rows[i]?.w.lastError ?? null,
              requested_by: rows[i]?.w.requestedBy,
            })),
          };
        }),
    );

    app.post(
      '/:id/approve',
      { preHandler: [requireAdmin(deps, 'withdrawals:approve'), requireAdminTotp(deps)], schema: { params: IdParams, body: z.strictObject({ reason: Reason }) } },
      async (req) =>
        withSystem(deps.db, async (tx) => {
          const w = await approveWithdrawal(deps, tx, req.params.id, adminId(req));
          await audit(tx, { actorType: 'admin', actorId: adminId(req), merchantId: w.merchantId, action: 'withdrawal.approved', targetType: 'withdrawal', targetId: w.id, after: { approvals: w.approvedBy.length, required: w.approvalsRequired, reason: req.body.reason } }, req);
          return (await viewMany(tx, [w]))[0];
        }),
    );

    app.post('/:id/reject', { preHandler: requireAdmin(deps, 'withdrawals:approve'), schema: { params: IdParams, body: z.strictObject({ reason: Reason }) } }, async (req) =>
      withSystem(deps.db, async (tx) => {
        const w = await rejectWithdrawal(deps, tx, req.params.id, req.body.reason);
        await audit(tx, { actorType: 'admin', actorId: adminId(req), merchantId: w.merchantId, action: 'withdrawal.rejected', targetType: 'withdrawal', targetId: w.id, after: { reason: req.body.reason } }, req);
        return (await viewMany(tx, [w]))[0];
      }),
    );
  };
}
