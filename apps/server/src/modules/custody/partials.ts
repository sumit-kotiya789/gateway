// MONEY-CRITICAL
// Custodial partial payments (D-099). An underpaid custodial invoice stays open until its deadline, so the customer can
// still send the rest. After the deadline it closes as partially_paid and the merchant is credited what arrived, minus
// the fee on that amount. Late payments (after expiry) are different: credited only when an admin resolves them
// (resolveInvoice). Non-custodial merchants already hold what arrived: their underpaid stays a manual decision.
import { sql } from 'drizzle-orm';
import { withSystem } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { closePartialPayment } from '../ledger/ledger.js';
import type { SweepScope } from './sweeper.js';

/**
 * Closes underpaid custodial invoices past their deadline, oldest first. Only once the chain's scanner has passed the
 * deadline (a top-up mined in time is always recorded first, as for expiry) and every confirmed payment was swept (the
 * credit is backed by funds in the hot wallet). Safe to run concurrently (SKIP LOCKED). Returns the ids closed.
 */
export async function closeUnderpaidInvoices(deps: Deps, scope: SweepScope = {}, batch = 100): Promise<string[]> {
  return withSystem(deps.db, async (tx) => {
    const now = new Date(deps.clock()).toISOString();
    const due = await tx.execute<{ id: string }>(sql`
      select i.id from invoices i
      where i.status = 'underpaid' and i.custody_mode = 'custodial' and i.expires_at <= ${now}::timestamptz
        ${scope.merchantId ? sql`and i.merchant_id = ${scope.merchantId}` : sql``}
        and exists (select 1 from chain_cursors c where c.chain_id = i.chain_id and c.block_time >= i.expires_at)
        and (select coalesce(sum(s.amount), 0) from sweeps s where s.invoice_id = i.id and s.status = 'confirmed')
          >= (select coalesce(sum(p.amount), 0) from payments p where p.invoice_id = i.id and p.status = 'confirmed')
      order by i.expires_at
      limit ${batch}
      for update of i skip locked`);
    // Rows are locked and still underpaid custodial: each one closes.
    for (const r of due.rows) await closePartialPayment(deps, tx, r.id);
    return due.rows.map((r) => r.id);
  });
}
