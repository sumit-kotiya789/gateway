// Admin console: custody overview and the signer kill switch (M7e, D-091). Pausing is always allowed
// (`kill_switch:manage`); resuming lowers a control, so it needs a superadmin and step-up, like re-enabling a chain.
import { AppError, fromSignedMinorUnits } from '@gw/core';
import { asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withSystem } from '../../common/db.js';
import { ledgerAccounts, ledgerEntries, platformWallets, signerControls, sweeps, tokens, withdrawals } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireAdmin, requireAdminTotp } from '../auth/guards.js';

const ReasonBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });
const CUSTODY_KINDS = ['custody_deposits', 'custody_hot', 'custody_cold', 'merchant_pending', 'merchant_available', 'merchant_withdrawing'] as const;

export function custodyAdminRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/', { preHandler: requireAdmin(deps, 'admin:read') }, async () =>
      withSystem(deps.db, async (tx) => {
        const [ctl] = await tx.select().from(signerControls).where(eq(signerControls.id, 1));
        const wallets = await tx.select().from(platformWallets).where(isNull(platformWallets.retiredAt)).orderBy(asc(platformWallets.livemode), asc(platformWallets.kind));
        // Ledger totals per mode, token and account kind (platform assets and what merchants are owed).
        const totals = await tx
          .select({ livemode: ledgerAccounts.livemode, token: ledgerAccounts.tokenId, kind: ledgerAccounts.kind, total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
          .from(ledgerAccounts)
          .innerJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
          .where(inArray(ledgerAccounts.kind, [...CUSTODY_KINDS]))
          .groupBy(ledgerAccounts.livemode, ledgerAccounts.tokenId, ledgerAccounts.kind);
        const meta = new Map((await tx.select({ id: tokens.id, decimals: tokens.decimals, symbol: tokens.symbol }).from(tokens)).map((t) => [t.id, t]));
        const rows = new Map<string, Record<string, string | boolean | null>>();
        for (const t of totals) {
          const key = `${String(t.livemode)}:${t.token}`;
          const d = meta.get(t.token)?.decimals ?? 0;
          const row = rows.get(key) ?? { livemode: t.livemode, token: t.token, symbol: meta.get(t.token)?.symbol ?? null };
          // Assets are debit balances, merchant liabilities credit balances: both shown positive.
          const signed = t.kind.startsWith('custody_') ? BigInt(t.total) : -BigInt(t.total);
          row[t.kind.replace(/^custody_/, 'platform_')] = fromSignedMinorUnits(signed, d);
          rows.set(key, row);
        }
        const [openSweeps] = await tx.select({ n: sql<number>`count(*)::int` }).from(sweeps).where(inArray(sweeps.status, ['pending', 'gas_sent', 'sweep_sent']));
        const queue = await tx
          .select({ status: withdrawals.status, n: sql<number>`count(*)::int` })
          .from(withdrawals)
          .where(inArray(withdrawals.status, ['pending_approval', 'approved', 'sent']))
          .groupBy(withdrawals.status);
        return {
          custodial_enabled: deps.config.FEATURE_CUSTODIAL,
          signer: { paused: ctl?.paused ?? true, reason: ctl?.reason ?? null, updated_at: ctl?.updatedAt.toISOString() ?? null },
          wallets: wallets.map((w) => ({ livemode: w.livemode, family: w.family, kind: w.kind, address: w.address, derivation_path: w.derivationPath })),
          balances: [...rows.values()],
          open_sweeps: openSweeps?.n ?? 0,
          withdrawals: Object.fromEntries(queue.map((q) => [q.status, q.n])),
        };
      }),
    );

    for (const [action, paused, guards] of [
      ['pause', true, [requireAdmin(deps, 'kill_switch:manage')]],
      ['resume', false, [requireAdmin(deps, 'registry:enable'), requireAdminTotp(deps)]],
    ] as const) {
      app.post(`/signer/${action}`, { preHandler: [...guards], schema: { body: ReasonBody } }, async (req, reply) => {
        const admin = req.admin;
        /* v8 ignore next -- requireAdmin runs first */
        if (!admin) throw new AppError('unauthorized', 'authentication required');
        await withSystem(deps.db, async (tx) => {
          const [ctl] = await tx.select().from(signerControls).where(eq(signerControls.id, 1)).for('update');
          if (ctl?.paused === paused) throw new AppError('conflict', `signer is already ${paused ? 'paused' : 'running'}`);
          await tx.update(signerControls).set({ paused, reason: req.body.reason, updatedAt: new Date(deps.clock()) }).where(eq(signerControls.id, 1));
          await audit(tx, { actorType: 'admin', actorId: admin.id, action: `custody.signer_${action}d`, targetType: 'signer', after: { paused, reason: req.body.reason } }, req);
          if (paused) deps.log.warn({ adminId: admin.id, reason: req.body.reason }, 'SIGNER PAUSED by admin');
        });
        return reply.status(204).send();
      });
    }
  };
}
