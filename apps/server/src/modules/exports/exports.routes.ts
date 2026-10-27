// CSV exports for accounting (M10): invoices and on-chain payments of one mode and date range. Dashboard
// (`reports:read`) and merchant API (`read` scope, the key's mode); audited, bounded in range and size.
import { AppError, fromMinorUnits } from '@gw/core';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant, type Tx } from '../../common/db.js';
import { invoices, payments, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { requireApiKey } from '../api-keys/api-keys.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';
import { csvRow } from './csv.js';

export const EXPORT_MAX_ROWS = 50_000;
const MAX_RANGE_DAYS = 366;
const DAY = 86_400_000;
/** Each export can scan a year of rows: 10 a minute per API key (or client IP) is plenty for any sync. */
const EXPORT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

// Inclusive dates (UTC). Default: the last 31 days.
const Dates = z.strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const Range = Dates.extend({ livemode: z.stringbool().default(false) });

type Kind = 'invoices' | 'payments';
interface Scope {
  merchantId: string;
  livemode: boolean;
  /** Who downloads, for the audit entry. */
  actor: { actorType: 'merchant_user' | 'api_key'; actorId: string };
}

function range(deps: Deps, q: z.infer<typeof Dates>): { from: Date; to: Date; label: string } {
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

async function invoicesCsv(tx: Tx, sc: Scope, r: { from: Date; to: Date }): Promise<{ csv: string; rows: number }> {
  const rows = await tx
    .select({ inv: invoices, decimals: tokens.decimals, symbol: tokens.symbol })
    .from(invoices)
    .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
    .where(and(eq(invoices.merchantId, sc.merchantId), eq(invoices.livemode, sc.livemode), gte(invoices.createdAt, r.from), lt(invoices.createdAt, r.to)))
    .orderBy(asc(invoices.createdAt), asc(invoices.id))
    .limit(EXPORT_MAX_ROWS + 1);
  tooMany(rows.length);
  let csv = csvRow([
    'id', 'created_at', 'status', 'status_changed_at', 'token', 'symbol', 'chain', 'amount', 'amount_received', 'fee_amount',
    'external_order_id', 'description', 'deposit_address', 'payment_link_id', 'expires_at', 'metadata',
  ]);
  for (const { inv, decimals, symbol } of rows) {
    csv += csvRow([
      inv.id, inv.createdAt.toISOString(), inv.status, inv.statusChangedAt.toISOString(), inv.tokenId, symbol, inv.chainId,
      fromMinorUnits(inv.amountExpected, decimals), fromMinorUnits(inv.amountReceived, decimals),
      inv.feeAmount === null ? null : fromMinorUnits(inv.feeAmount, decimals),
      inv.externalOrderId, inv.description, inv.depositAddress, inv.paymentLinkId, inv.expiresAt.toISOString(), JSON.stringify(inv.metadata),
    ]);
  }
  return { csv, rows: rows.length };
}

async function paymentsCsv(tx: Tx, sc: Scope, r: { from: Date; to: Date }): Promise<{ csv: string; rows: number }> {
  const rows = await tx
    .select({ p: payments, decimals: tokens.decimals, symbol: tokens.symbol })
    .from(payments)
    .innerJoin(tokens, eq(tokens.id, payments.tokenId))
    .where(and(eq(payments.merchantId, sc.merchantId), eq(payments.livemode, sc.livemode), gte(payments.createdAt, r.from), lt(payments.createdAt, r.to)))
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(EXPORT_MAX_ROWS + 1);
  tooMany(rows.length);
  let csv = csvRow([
    'id', 'invoice_id', 'detected_at', 'status', 'confirmed_at', 'token', 'symbol', 'chain', 'amount',
    'tx_hash', 'log_index', 'block_number', 'block_time', 'from_address', 'to_address',
  ]);
  for (const { p, decimals, symbol } of rows) {
    csv += csvRow([
      p.id, p.invoiceId, p.createdAt.toISOString(), p.status, p.confirmedAt?.toISOString() ?? null, p.tokenId, symbol, p.chainId,
      fromMinorUnits(p.amount, decimals), p.txHash, p.logIndex, p.blockNumber, p.blockTime.toISOString(), p.fromAddress, p.toAddress,
    ]);
  }
  return { csv, rows: rows.length };
}

const BUILD = { invoices: invoicesCsv, payments: paymentsCsv } as const;

/** Builds one export in the merchant's tenant, audits it in the same transaction and sends it. */
async function exportCsv(deps: Deps, req: FastifyRequest, reply: FastifyReply, kind: Kind, sc: Scope, q: z.infer<typeof Dates>) {
  const r = range(deps, q);
  const csv = await withTenant(deps.db, sc.merchantId, async (tx) => {
    const out = await BUILD[kind](tx, sc, r);
    await audit(tx, { ...sc.actor, merchantId: sc.merchantId, action: 'export.downloaded', after: { kind, livemode: sc.livemode, range: r.label, rows: out.rows } }, req);
    return out.csv;
  });
  return sendCsv(reply, `${kind}-${sc.livemode ? 'live' : 'test'}-${r.label}.csv`, csv);
}

export function exportDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));
    for (const kind of ['invoices', 'payments'] as const) {
      app.get(`/${kind}.csv`, { preHandler: requirePermission('reports:read'), config: { rateLimit: EXPORT_RATE_LIMIT }, schema: { querystring: Range } }, async (req, reply) => {
        const user = authedUser(req);
        const { livemode, ...dates } = req.query;
        return exportCsv(deps, req, reply, kind, { merchantId: user.merchantId, livemode, actor: { actorType: 'merchant_user', actorId: user.id } }, dates);
      });
    }
  };
}

/** Merchant API: the same exports for the key's mode, e.g. a nightly accounting sync. */
export function exportRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    for (const kind of ['invoices', 'payments'] as const) {
      app.get(`/exports/${kind}.csv`, { preHandler: requireApiKey(deps, 'read'), config: { rateLimit: EXPORT_RATE_LIMIT }, schema: { querystring: Dates } }, async (req, reply) => {
        const k = req.apiKey;
        if (!k) throw new AppError('unauthorized', 'API key required');
        return exportCsv(deps, req, reply, kind, { merchantId: k.merchantId, livemode: k.livemode, actor: { actorType: 'api_key', actorId: k.id } }, req.query);
      });
    }
  };
}
