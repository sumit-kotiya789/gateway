// Admin console API (M5b), mounted under /admin/v1 behind the admin network guard. Every route needs an admin session
// (separate auth domain, D-025) and a permission; actions that lower a safety control also need step-up TOTP (D-064).
// Every change is audited with the admin's reason, in the same transaction as the change.
import { AppError, INVOICE_STATUSES, UUID_RE, toMinorUnits } from '@gw/core';
import { and, arrayContains, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, type AuditEntry } from '../../common/audit.js';
import { withSystem, type Tx } from '../../common/db.js';
import {
  auditLogs,
  chains,
  invoices,
  merchantRiskFlag,
  merchantStatus,
  merchantUsers,
  merchants,
  recoveryCodes,
  sessions,
  tokens,
} from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireAdmin, requireAdminTotp, type AuthedAdmin } from '../auth/guards.js';
import { invoiceDetail } from '../invoices/invoices.routes.js';
import { invoiceView } from '../invoices/invoices.js';
import { balancesView, feeTopupsView } from '../ledger/ledger.routes.js';
import { recordFeeTopup, resolveInvoice } from '../ledger/ledger.js';
import { enqueueEmail } from '../email/outbox.js';
import { templates } from '../email/templates.js';

const Reason = z.string().trim().min(3).max(500);
const ReasonBody = z.strictObject({ reason: Reason });
const IdParams = z.strictObject({ id: z.uuid() });
const Page = { limit: z.coerce.number().int().min(1).max(100).default(50), starting_after: z.uuid().optional() };
/** Invoices an admin may need to act on (manual resolve). */
const ATTENTION = ['underpaid', 'late_payment'] as const;

const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
/** Token-unit setting (stablecoin units, up to 6 decimals), bounded like the DB check. */
const feeUnits = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/, 'a plain decimal with at most 6 decimals')
    .refine((v) => Number(v) <= max, `at most ${String(max)}`);
/** NUMERIC(20,6) as stored ("0.500000") in its canonical form ("0.5"). */
const units = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

function adminOf(req: FastifyRequest): AuthedAdmin {
  /* v8 ignore next -- requireAdmin runs first on every route */
  if (!req.admin) throw new AppError('unauthorized', 'authentication required');
  return req.admin;
}

type MerchantRow = typeof merchants.$inferSelect;
const merchantView = (m: MerchantRow) => ({
  id: m.id,
  name: m.name,
  status: m.status,
  custody_mode: m.custodyMode,
  fee_bps: m.feeBps,
  fee_fixed: units(m.feeFixed),
  fee_grace: units(m.feeGrace),
  underpay_tolerance_bps: m.underpayToleranceBps,
  risk_flags: m.riskFlags,
  created_at: m.createdAt.toISOString(),
});

async function lockedMerchant(tx: Tx, id: string): Promise<MerchantRow> {
  const [m] = await tx.select().from(merchants).where(eq(merchants.id, id)).for('update');
  if (!m) throw new AppError('not_found', 'merchant not found');
  return m;
}

export function adminRoutes(deps: Deps): FastifyPluginAsyncZod {
  const base = deps.config.PUBLIC_BASE_URL;
  const record = (tx: Tx, req: FastifyRequest, e: Omit<AuditEntry, 'actorType' | 'actorId'>) =>
    audit(tx, { actorType: 'admin', actorId: adminOf(req).id, ...e }, req);

  return async (app) => {
    // ---------------------------------------------------------------- merchants

    app.get(
      '/merchants',
      {
        preHandler: requireAdmin(deps, 'admin:read'),
        schema: {
          querystring: z.strictObject({
            q: z.string().trim().min(1).max(200).optional(), // name fragment, exact merchant id, or exact user email
            status: z.enum(merchantStatus.enumValues).optional(),
            flag: z.enum(merchantRiskFlag.enumValues).optional(),
            ...Page,
          }),
        },
      },
      async (req) => {
        const q = req.query;
        const rows = await withSystem(deps.db, (tx) =>
          tx
            .select()
            .from(merchants)
            .where(
              and(
                q.q
                  ? or(
                      ilike(merchants.name, like(q.q)),
                      UUID_RE.test(q.q) ? eq(merchants.id, q.q) : undefined,
                      sql`exists (select 1 from ${merchantUsers} u where u.merchant_id = ${merchants.id} and lower(u.email) = lower(${q.q}))`,
                    )
                  : undefined,
                q.status ? eq(merchants.status, q.status) : undefined,
                q.flag ? arrayContains(merchants.riskFlags, [q.flag]) : undefined,
                q.starting_after ? lt(merchants.id, q.starting_after) : undefined,
              ),
            )
            .orderBy(desc(merchants.id))
            .limit(q.limit + 1),
        );
        const page = rows.slice(0, q.limit);
        return { data: page.map(merchantView), has_more: rows.length > q.limit, next_cursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
      },
    );

    app.get('/merchants/:id', { preHandler: requireAdmin(deps, 'admin:read'), schema: { params: IdParams } }, async (req) =>
      withSystem(deps.db, async (tx) => {
        const [m] = await tx.select().from(merchants).where(eq(merchants.id, req.params.id));
        if (!m) throw new AppError('not_found', 'merchant not found');
        const users = await tx.select().from(merchantUsers).where(eq(merchantUsers.merchantId, m.id)).orderBy(asc(merchantUsers.createdAt));
        return {
          ...merchantView(m),
          users: users.map((u) => ({
            id: u.id,
            email: u.email,
            role: u.role,
            totp_enabled: u.totpEnabledAt !== null,
            locked_until: u.lockedUntil?.toISOString() ?? null,
            created_at: u.createdAt.toISOString(),
          })),
          balances: [await balancesView(tx, m.id, false), await balancesView(tx, m.id, true)],
        };
      }),
    );

    // Suspending is always allowed; reactivating lowers a control, so it needs step-up.
    for (const [action, status, event, guards] of [
      ['suspend', 'suspended', 'admin.merchant_suspended', [requireAdmin(deps, 'merchants:manage')]],
      ['reactivate', 'active', 'admin.merchant_reactivated', [requireAdmin(deps, 'merchants:manage'), requireAdminTotp(deps)]],
    ] as const) {
      app.post(`/merchants/:id/${action}`, { preHandler: [...guards], schema: { params: IdParams, body: ReasonBody } }, async (req) =>
        withSystem(deps.db, async (tx) => {
          const m = await lockedMerchant(tx, req.params.id);
          if (m.status === status) throw new AppError('conflict', `merchant is already ${status}`);
          const [next] = await tx.update(merchants).set({ status }).where(eq(merchants.id, m.id)).returning();
          /* v8 ignore next -- row locked above */
          if (!next) throw new Error('merchant update failed');
          await record(tx, req, {
            merchantId: m.id,
            action: event,
            targetType: 'merchant',
            targetId: m.id,
            before: { status: m.status },
            after: { status, reason: req.body.reason },
          });
          return merchantView(next);
        }),
      );
    }

    app.put(
      '/merchants/:id/risk-flags',
      {
        preHandler: requireAdmin(deps, 'risk:manage'),
        schema: { params: IdParams, body: z.strictObject({ flags: z.array(z.enum(merchantRiskFlag.enumValues)).max(10), reason: Reason }) },
      },
      async (req) =>
        withSystem(deps.db, async (tx) => {
          const m = await lockedMerchant(tx, req.params.id);
          const flags = [...new Set(req.body.flags)].sort();
          const [next] = await tx.update(merchants).set({ riskFlags: flags }).where(eq(merchants.id, m.id)).returning();
          /* v8 ignore next -- row locked above */
          if (!next) throw new Error('merchant update failed');
          await record(tx, req, {
            merchantId: m.id,
            action: 'admin.merchant_risk_flags',
            targetType: 'merchant',
            targetId: m.id,
            before: { risk_flags: m.riskFlags },
            after: { risk_flags: flags, reason: req.body.reason },
          });
          return merchantView(next);
        }),
    );

    // ---------------------------------------------------------------- fees (M8, D-076)

    /** Fee model and fee-balance grace. Changes apply to invoices created afterwards (snapshotted at creation). */
    app.put(
      '/merchants/:id/fees',
      {
        preHandler: [requireAdmin(deps, 'fees:manage'), requireAdminTotp(deps)],
        schema: {
          params: IdParams,
          body: z.strictObject({ fee_bps: z.number().int().min(0).max(10_000), fee_fixed: feeUnits(1000), fee_grace: feeUnits(100_000), reason: Reason }),
        },
      },
      async (req) =>
        withSystem(deps.db, async (tx) => {
          const m = await lockedMerchant(tx, req.params.id);
          const b = req.body;
          const [next] = await tx.update(merchants).set({ feeBps: b.fee_bps, feeFixed: b.fee_fixed, feeGrace: b.fee_grace }).where(eq(merchants.id, m.id)).returning();
          /* v8 ignore next -- row locked above */
          if (!next) throw new Error('merchant update failed');
          await record(tx, req, {
            merchantId: m.id,
            action: 'admin.merchant_fees_changed',
            targetType: 'merchant',
            targetId: m.id,
            before: { fee_bps: m.feeBps, fee_fixed: units(m.feeFixed), fee_grace: units(m.feeGrace) },
            after: { fee_bps: b.fee_bps, fee_fixed: units(next.feeFixed), fee_grace: units(next.feeGrace), reason: b.reason },
          });
          return merchantView(next);
        }),
    );

    app.get(
      '/merchants/:id/fee-topups',
      { preHandler: requireAdmin(deps, 'admin:read'), schema: { params: IdParams, querystring: z.strictObject({ livemode: z.stringbool().default(true) }) } },
      async (req) => withSystem(deps.db, (tx) => feeTopupsView(tx, req.params.id, req.query.livemode)),
    );

    /** Records a prepaid fee top-up the merchant paid (on-chain or off-platform) and posts its ledger journal. */
    app.post(
      '/merchants/:id/fee-topups',
      {
        preHandler: [requireAdmin(deps, 'fees:manage'), requireAdminTotp(deps)],
        schema: {
          params: IdParams,
          body: z.strictObject({
            livemode: z.boolean(),
            token: z.string().min(1).max(100),
            amount: z.string().max(100),
            reference: z.string().trim().min(3).max(200),
            reason: Reason,
          }),
        },
      },
      async (req, reply) => {
        const b = req.body;
        const view = await withSystem(deps.db, async (tx) => {
          const m = await lockedMerchant(tx, req.params.id);
          const [tk] = await tx.select({ token: tokens, chain: chains }).from(tokens).innerJoin(chains, eq(chains.id, tokens.chainId)).where(eq(tokens.id, b.token));
          if (!tk || tk.chain.testnet === b.livemode) {
            throw new AppError('validation_error', `token ${b.token} is not a ${b.livemode ? 'live' : 'test'} mode token`, { field: 'token' });
          }
          const amount = toMinorUnits(b.amount, tk.token.decimals);
          const row = await recordFeeTopup(tx, { merchantId: m.id, livemode: b.livemode, tokenId: b.token, amount, reference: b.reference, adminId: adminOf(req).id });
          await record(tx, req, {
            merchantId: m.id,
            action: 'admin.fee_topup_recorded',
            targetType: 'fee_topup',
            targetId: row.id,
            // `asset`: the audit redaction treats any key containing "token" as a secret.
            after: { livemode: b.livemode, asset: b.token, amount: b.amount, reference: b.reference, reason: b.reason },
          });
          return (await feeTopupsView(tx, m.id, b.livemode, 1)).data[0];
        });
        return reply.status(201).send(view);
      },
    );

    // Lost authenticator without recovery codes (RUNBOOK). The user signs in with the password only and must re-enroll.
    app.post(
      '/merchants/:id/users/:userId/reset-2fa',
      {
        preHandler: [requireAdmin(deps, 'merchants:manage'), requireAdminTotp(deps)],
        schema: { params: z.strictObject({ id: z.uuid(), userId: z.uuid() }), body: ReasonBody },
      },
      async (req, reply) => {
        await withSystem(deps.db, async (tx) => {
          const [u] = await tx
            .select()
            .from(merchantUsers)
            .where(and(eq(merchantUsers.id, req.params.userId), eq(merchantUsers.merchantId, req.params.id)))
            .for('update');
          if (!u) throw new AppError('not_found', 'user not found');
          if (u.totpEnabledAt === null && u.totpPendingEnc === null) throw new AppError('conflict', 'two-factor authentication is not enabled');
          await tx
            .update(merchantUsers)
            .set({ totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null })
            .where(eq(merchantUsers.id, u.id));
          await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
          await tx.update(sessions).set({ revokedAt: new Date(deps.clock()) }).where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
          await record(tx, req, { merchantId: u.merchantId, action: 'admin.user_2fa_reset', targetType: 'merchant_user', targetId: u.id, after: { reason: req.body.reason } });
          await enqueueEmail(deps, tx, { merchantId: u.merchantId, kind: 'two_factor_reset', to: u.email, ...templates.twoFactorReset() });
        });
        return reply.status(204).send();
      },
    );

    // ---------------------------------------------------------------- invoices (manual resolution)

    app.get(
      '/invoices',
      {
        preHandler: requireAdmin(deps, 'admin:read'),
        schema: {
          querystring: z.strictObject({
            status: z.enum(INVOICE_STATUSES).optional(), // default: the statuses that need an admin decision
            merchant_id: z.uuid().optional(),
            livemode: z.stringbool().optional(),
            ...Page,
          }),
        },
      },
      async (req) => {
        const q = req.query;
        const rows = await withSystem(deps.db, (tx) =>
          tx
            .select({ inv: invoices, token: tokens, chain: chains, merchantName: merchants.name })
            .from(invoices)
            .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
            .innerJoin(chains, eq(chains.id, invoices.chainId))
            .innerJoin(merchants, eq(merchants.id, invoices.merchantId))
            .where(
              and(
                q.status ? eq(invoices.status, q.status) : inArray(invoices.status, [...ATTENTION]),
                q.merchant_id ? eq(invoices.merchantId, q.merchant_id) : undefined,
                q.livemode === undefined ? undefined : eq(invoices.livemode, q.livemode),
                q.starting_after ? lt(invoices.id, q.starting_after) : undefined,
              ),
            )
            .orderBy(desc(invoices.id))
            .limit(q.limit + 1),
        );
        const page = rows.slice(0, q.limit);
        return {
          data: page.map((r) => ({ ...invoiceView(r.inv, r.token, r.chain, base), merchant_id: r.inv.merchantId, merchant_name: r.merchantName })),
          has_more: rows.length > q.limit,
          next_cursor: rows.length > q.limit ? (page.at(-1)?.inv.id ?? null) : null,
        };
      },
    );

    app.get('/invoices/:id', { preHandler: requireAdmin(deps, 'admin:read'), schema: { params: IdParams } }, async (req) =>
      withSystem(deps.db, (tx) => invoiceDetail(tx, eq(invoices.id, req.params.id), base)),
    );

    app.post(
      '/invoices/:id/resolve',
      { preHandler: [requireAdmin(deps, 'invoices:resolve'), requireAdminTotp(deps)], schema: { params: IdParams, body: ReasonBody } },
      async (req) =>
        withSystem(deps.db, async (tx) => {
          const [inv] = await tx.select({ merchantId: invoices.merchantId, status: invoices.status }).from(invoices).where(eq(invoices.id, req.params.id)).for('update');
          if (!inv) throw new AppError('not_found', 'invoice not found');
          await resolveInvoice(deps, tx, req.params.id, req.body.reason);
          await record(tx, req, {
            merchantId: inv.merchantId,
            action: 'admin.invoice_resolved',
            targetType: 'invoice',
            targetId: req.params.id,
            before: { status: inv.status },
            after: { reason: req.body.reason },
          });
          return invoiceDetail(tx, eq(invoices.id, req.params.id), base);
        }),
    );

    // ---------------------------------------------------------------- kill switches (chain / token enabled flags)

    app.get('/registry', { preHandler: requireAdmin(deps, 'admin:read') }, async () =>
      withSystem(deps.db, async (tx) => ({
        chains: (await tx.select().from(chains).orderBy(asc(chains.id))).map((c) => ({ id: c.id, name: c.name, family: c.family, testnet: c.testnet, enabled: c.enabled })),
        tokens: (await tx.select().from(tokens).orderBy(asc(tokens.id))).map((t) => ({ id: t.id, chain_id: t.chainId, symbol: t.symbol, name: t.name, enabled: t.enabled })),
      })),
    );

    // Off: immediate for new invoices and payment links; running watchers keep recording payments to existing
    // invoices until restarted (D-066). On: superadmin + step-up.
    for (const [action, enabled, guards] of [
      ['disable', false, [requireAdmin(deps, 'kill_switch:manage')]],
      ['enable', true, [requireAdmin(deps, 'registry:enable'), requireAdminTotp(deps)]],
    ] as const) {
      app.post(
        `/registry/:kind/:id/${action}`,
        {
          preHandler: [...guards],
          schema: { params: z.strictObject({ kind: z.enum(['chain', 'token']), id: z.string().regex(/^[a-z0-9:-]{2,49}$/) }), body: ReasonBody },
        },
        async (req, reply) => {
          const { kind, id } = req.params;
          const table = kind === 'chain' ? chains : tokens;
          await withSystem(deps.db, async (tx) => {
            const [row] = (await tx.execute<{ enabled: boolean }>(sql`select enabled from ${table} where id = ${id} for update`)).rows;
            if (!row) throw new AppError('not_found', `${kind} not found`);
            if (row.enabled === enabled) throw new AppError('conflict', `${kind} is already ${action}d`);
            await tx.execute(sql`update ${table} set enabled = ${enabled} where id = ${id}`);
            await record(tx, req, { action: `admin.${kind}_${action}d`, targetType: kind, targetId: id, after: { enabled, reason: req.body.reason } });
          });
          return reply.status(204).send();
        },
      );
    }

    // ---------------------------------------------------------------- audit log

    app.get(
      '/audit-logs',
      {
        preHandler: requireAdmin(deps, 'audit:read'),
        schema: {
          querystring: z.strictObject({
            merchant_id: z.uuid().optional(),
            actor_id: z.uuid().optional(),
            action: z.string().regex(/^[a-z0-9_.]{1,100}$/).optional(), // prefix, e.g. "admin."
            limit: Page.limit,
            starting_after: z.string().regex(/^\d{1,19}$/).optional(),
          }),
        },
      },
      async (req) => {
        const q = req.query;
        const rows = await withSystem(deps.db, (tx) =>
          tx
            .select()
            .from(auditLogs)
            .where(
              and(
                q.merchant_id ? eq(auditLogs.merchantId, q.merchant_id) : undefined,
                q.actor_id ? eq(auditLogs.actorId, q.actor_id) : undefined,
                q.action ? sql`${auditLogs.action} like ${`${q.action.replace(/_/g, '\\_')}%`}` : undefined,
                q.starting_after ? lt(auditLogs.seq, BigInt(q.starting_after)) : undefined,
              ),
            )
            .orderBy(desc(auditLogs.seq))
            .limit(q.limit + 1),
        );
        const page = rows.slice(0, q.limit);
        return {
          data: page.map((r) => ({
            seq: r.seq.toString(),
            at: r.at.toISOString(),
            actor_type: r.actorType,
            actor_id: r.actorId,
            merchant_id: r.merchantId,
            action: r.action,
            target_type: r.targetType,
            target_id: r.targetId,
            ip: r.ip,
            request_id: r.requestId,
            before: r.before,
            after: r.after,
            hash: r.hash.toString('hex'),
          })),
          has_more: rows.length > q.limit,
          next_cursor: rows.length > q.limit ? (page.at(-1)?.seq.toString() ?? null) : null,
        };
      },
    );

    // ponytail: walks the whole hash chain per call; add checkpoints when the log is large enough for this to be slow.
    app.get('/audit-logs/verify', { preHandler: requireAdmin(deps, 'audit:read') }, async () => {
      const r = await withSystem(deps.db, (tx) => tx.execute<{ bad: string | null }>(sql`select audit_verify()::text as bad`));
      const bad = r.rows[0]?.bad ?? null;
      return { intact: bad === null, first_bad_seq: bad };
    });
  };
}
