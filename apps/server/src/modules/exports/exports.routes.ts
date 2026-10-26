// CSV exports for accounting (M10): invoices and on-chain payments of one mode and date range. Dashboard only
// (`reports:read`), audited, bounded in range and size.
import { AppError, fromMinorUnits } from '@gw/core';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant } from '../../common/db.js';
import { invoices, payments, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';
import { csvRow } from './csv.js';

export const EXPORT_MAX_ROWS = 50_000;
const MAX_RANGE_DAYS = 366;
const DAY = 86_400_000;

const Range = z.strictObject({
  livemode: z.stringbool().default(false),
  // Inclusive dates (UTC). Default: the last 31 days.
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

function range(deps: Deps, q: z.infer<typeof Range>): { from: Date; to: Date; label: string } {
  const toDay = q.to ? Date.parse(q.to) : Math.floor(deps.clock() / DAY) * DAY;
  const fromDay = q.from ? Date.parse(q.from) : toDay - 30 * DAY;
  if (fromDay > toDay) throw new AppError('validation_error', '`from` must not be after `to`');
  if (toDay - fromDay >= MAX_RANGE_DAYS * DAY) throw new AppError('validation_error', `at most ${String(MAX_RANGE_DAYS)} days per export`);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: new Date(fromDay), to: new Date(toDay + DAY), label: `${iso(fromDay)}_${iso(toDay)}` };
}

function sendCsv(reply: FastifyReply, filename: string, body: string) {
  return reply
    .type('text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .header('cache-control', 'no-store')
    .send(body);
}

function tooMany(n: number): void {
  if (n > EXPORT_MAX_ROWS) throw new AppError('validation_error', `more than ${String(EXPORT_MAX_ROWS)} rows: narrow the date range`);
}

export function exportDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/invoices.csv', { preHandler: requirePermission('reports:read'), schema: { querystring: Range } }, async (req, reply) => {
      const user = authedUser(req);
      const r = range(deps, req.query);
      const body = await withTenant(deps.db, user.merchantId, async (tx) => {
        const rows = await tx
          .select({ inv: invoices, decimals: tokens.decimals, symbol: tokens.symbol })
          .from(invoices)
          .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
          .where(and(eq(invoices.merchantId, user.merchantId), eq(invoices.livemode, req.query.livemode), gte(invoices.createdAt, r.from), lt(invoices.createdAt, r.to)))
          .orderBy(asc(invoices.createdAt), asc(invoices.id))
          .limit(EXPORT_MAX_ROWS + 1);
        tooMany(rows.length);
        let out = csvRow([
          'id', 'created_at', 'status', 'status_changed_at', 'token', 'symbol', 'chain', 'amount', 'amount_received', 'fee_amount',
          'external_order_id', 'description', 'deposit_address', 'payment_link_id', 'expires_at', 'metadata',
        ]);
        for (const { inv, decimals, symbol } of rows) {
          out += csvRow([
            inv.id, inv.createdAt.toISOString(), inv.status, inv.statusChangedAt.toISOString(), inv.tokenId, symbol, inv.chainId,
            fromMinorUnits(inv.amountExpected, decimals), fromMinorUnits(inv.amountReceived, decimals),
            inv.feeAmount === null ? null : fromMinorUnits(inv.feeAmount, decimals),
            inv.externalOrderId, inv.description, inv.depositAddress, inv.paymentLinkId, inv.expiresAt.toISOString(), JSON.stringify(inv.metadata),
          ]);
        }
        await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'export.downloaded', after: { kind: 'invoices', livemode: req.query.livemode, range: r.label, rows: rows.length } }, req);
        return out;
      });
      return sendCsv(reply, `invoices-${req.query.livemode ? 'live' : 'test'}-${r.label}.csv`, body);
    });

    app.get('/payments.csv', { preHandler: requirePermission('reports:read'), schema: { querystring: Range } }, async (req, reply) => {
      const user = authedUser(req);
      const r = range(deps, req.query);
      const body = await withTenant(deps.db, user.merchantId, async (tx) => {
        const rows = await tx
          .select({ p: payments, decimals: tokens.decimals, symbol: tokens.symbol })
          .from(payments)
          .innerJoin(tokens, eq(tokens.id, payments.tokenId))
          .where(and(eq(payments.merchantId, user.merchantId), eq(payments.livemode, req.query.livemode), gte(payments.createdAt, r.from), lt(payments.createdAt, r.to)))
          .orderBy(asc(payments.createdAt), asc(payments.id))
          .limit(EXPORT_MAX_ROWS + 1);
        tooMany(rows.length);
        let out = csvRow([
          'id', 'invoice_id', 'detected_at', 'status', 'confirmed_at', 'token', 'symbol', 'chain', 'amount',
          'tx_hash', 'log_index', 'block_number', 'block_time', 'from_address', 'to_address',
        ]);
        for (const { p, decimals, symbol } of rows) {
          out += csvRow([
            p.id, p.invoiceId, p.createdAt.toISOString(), p.status, p.confirmedAt?.toISOString() ?? null, p.tokenId, symbol, p.chainId,
            fromMinorUnits(p.amount, decimals), p.txHash, p.logIndex, p.blockNumber, p.blockTime.toISOString(), p.fromAddress, p.toAddress,
          ]);
        }
        await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'export.downloaded', after: { kind: 'payments', livemode: req.query.livemode, range: r.label, rows: rows.length } }, req);
        return out;
      });
      return sendCsv(reply, `payments-${req.query.livemode ? 'live' : 'test'}-${r.label}.csv`, body);
    });
  };
}
