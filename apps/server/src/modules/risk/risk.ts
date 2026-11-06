// MONEY-CRITICAL
// Risk hooks (M9, D-094). Asked once an invoice's payments are all confirmed and it would become paid / overpaid /
// underpaid: a reason means it becomes `held` instead, until an admin releases or rejects it.
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { chains, invoices, merchantRiskLimits, riskBlockedAddresses, type payments } from '../../db/schema.js';

type InvoiceRow = typeof invoices.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

/** Invoices whose money the merchant has accepted: they count toward the daily limit. */
const ACCEPTED = ['paid', 'overpaid', 'settled'] as const;

/** Why this invoice must be held, or null. `received` = its confirmed total. */
export async function riskHoldReason(tx: Tx, inv: InvoiceRow, confirmed: readonly PaymentRow[], received: bigint): Promise<string | null> {
  // Never empty: a plan only ends in a classification once some payment is confirmed.
  const payers = [...new Set(confirmed.map((p) => p.fromAddress.toLowerCase()))];
  const [hit] = await tx
    .select({ address: riskBlockedAddresses.address })
    .from(riskBlockedAddresses)
    .innerJoin(chains, eq(chains.family, riskBlockedAddresses.family))
    .where(and(eq(chains.id, inv.chainId), inArray(riskBlockedAddresses.address, payers)))
    .limit(1);
  if (hit) return `risk: payer ${hit.address} is blocked`;

  if (!inv.livemode) return null; // limits are for real money only
  const [limit] = await tx
    .select()
    .from(merchantRiskLimits)
    .where(and(eq(merchantRiskLimits.merchantId, inv.merchantId), eq(merchantRiskLimits.tokenId, inv.tokenId)));
  if (!limit) return null;
  if (limit.perInvoice !== null && received > limit.perInvoice) return 'risk: above the per-invoice limit';
  if (limit.perDay === null) return null;

  // Watchers of different chains run concurrently: serialize this merchant's daily-limit decisions.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`risk:${inv.merchantId}`}))`);
  const [today] = await tx
    .select({ total: sql<string>`coalesce(sum(${invoices.amountReceived}), 0)::text` })
    .from(invoices)
    .where(
      and(
        eq(invoices.merchantId, inv.merchantId),
        eq(invoices.livemode, true),
        eq(invoices.tokenId, inv.tokenId),
        inArray(invoices.status, [...ACCEPTED]),
        // status_changed_at is set by a DB trigger, so the day boundary comes from the DB clock too (UTC day).
        gte(invoices.statusChangedAt, sql`date_trunc('day', now(), 'UTC')`),
        ne(invoices.id, inv.id),
      ),
    );
  /* v8 ignore next -- an aggregate always returns its one row */
  const sofar = BigInt(today?.total ?? '0');
  return sofar + received > limit.perDay ? 'risk: daily limit reached' : null;
}
