// Independent re-check of the ledger against payments and invoices (worker job, hourly). Postings and the DB guards
// should make every check return nothing; a hit means a bug or tampering. Results are kept in reconciliation_runs.
import { sql } from 'drizzle-orm';
import { withSystem } from '../../common/db.js';
import { reconciliationRuns } from '../../db/schema.js';
import type { Deps } from '../../deps.js';

const NC = sql.raw(`'non_custodial_xpub'`);
const C = sql.raw(`'custodial'`);

const CHECKS = {
  /** Every confirmed payment (non-custodial and custodial) has its payment journal. */
  payment_without_journal: sql`select p.id from payments p join invoices i on i.id = p.invoice_id
    where p.status = 'confirmed' and i.custody_mode in (${NC}, ${C})
      and not exists (select 1 from ledger_journals j where j.kind = 'payment' and j.payment_id = p.id)`,
  /** The journal books exactly the payment's amount. */
  payment_journal_amount: sql`select j.id from ledger_journals j join payments p on p.id = j.payment_id
    join ledger_entries e on e.journal_id = j.id join ledger_accounts a on a.id = e.account_id and a.kind in ('merchant_received', 'custody_deposits')
    where e.amount <> p.amount`,
  /** Custodial: what merchants were credited as pending = sum of their confirmed custodial payments. */
  custodial_received: sql`select concat_ws(':', x.merchant_id, x.livemode, x.token_id) as id from (
      select i.merchant_id, i.livemode, i.token_id, sum(p.amount) as paid from payments p join invoices i on i.id = p.invoice_id
      where p.status = 'confirmed' and i.custody_mode = ${C} group by 1, 2, 3) x
    full join (
      select a.merchant_id, a.livemode, a.token_id, -sum(e.amount) as booked from ledger_entries e
      join ledger_accounts a on a.id = e.account_id join ledger_journals j on j.id = e.journal_id
      where a.kind = 'merchant_pending' and j.kind = 'payment' group by 1, 2, 3) y
    using (merchant_id, livemode, token_id)
    where coalesce(x.paid, 0) <> coalesce(y.booked, 0)`,
  /** Settled custodial invoices: one settlement moving exactly what was received out of pending, net of the invoice's fee. */
  custodial_settlement: sql`select i.id from invoices i
    where i.status = 'settled' and i.custody_mode = ${C}
      and (i.fee_amount is null
        or i.amount_received <> coalesce((select sum(e.amount) from ledger_journals j join ledger_entries e on e.journal_id = j.id
          join ledger_accounts a on a.id = e.account_id and a.kind = 'merchant_pending' where j.kind = 'settlement' and j.invoice_id = i.id), 0)
        or i.fee_amount <> -coalesce((select sum(e.amount) from ledger_journals j join ledger_entries e on e.journal_id = j.id
          join ledger_accounts a on a.id = e.account_id and a.kind = 'platform_fee_revenue' where j.kind = 'settlement' and j.invoice_id = i.id), 0))`,
  /** Every confirmed sweep is booked once, for exactly its amount, out of custody_deposits. */
  sweep_journal: sql`select s.id from sweeps s where s.status = 'confirmed'
    and coalesce((select sum(e.amount) from ledger_journals j join ledger_entries e on e.journal_id = j.id
      join ledger_accounts a on a.id = e.account_id and a.kind = 'custody_deposits' where j.kind = 'sweep' and j.sweep_id = s.id), 0) <> -s.amount`,
  /** Platform custody accounts never go negative (nothing leaves custody that was not booked into it). */
  negative_custody: sql`select a.id from ledger_accounts a join ledger_entries e on e.account_id = a.id
    where a.kind in ('custody_deposits', 'custody_hot', 'custody_cold') group by a.id having sum(e.amount) < 0`,
  /** No merchant balance is ever negative (a withdrawal can never take more than was available). */
  negative_merchant_balance: sql`select a.id from ledger_accounts a join ledger_entries e on e.account_id = a.id
    where a.kind in ('merchant_pending', 'merchant_available', 'merchant_withdrawing') group by a.id having sum(e.amount) > 0`,
  /** invoices.amount_received = sum of confirmed payments. */
  invoice_received: sql`select i.id from invoices i left join payments p on p.invoice_id = i.id and p.status = 'confirmed'
    group by i.id having i.amount_received <> coalesce(sum(p.amount), 0)`,
  /** Ledger received = sum of confirmed payments, per merchant, mode and token. */
  received_balance: sql`select concat_ws(':', x.merchant_id, x.livemode, x.token_id) as id from (
      select i.merchant_id, i.livemode, i.token_id, sum(p.amount) as paid from payments p join invoices i on i.id = p.invoice_id
      where p.status = 'confirmed' and i.custody_mode = ${NC} group by 1, 2, 3) x
    full join (
      select a.merchant_id, a.livemode, a.token_id, sum(e.amount) as booked from ledger_entries e join ledger_accounts a on a.id = e.account_id
      where a.kind = 'merchant_received' group by 1, 2, 3) y
    using (merchant_id, livemode, token_id)
    where coalesce(x.paid, 0) <> coalesce(y.booked, 0)`,
  /** Settled non-custodial invoices carry a fee, booked exactly once for that amount. */
  settled_fee: sql`select i.id from invoices i
    where i.status = 'settled' and i.custody_mode = ${NC}
      and (i.fee_amount is null or i.fee_amount <> coalesce((
        select sum(e.amount) from ledger_journals j join ledger_entries e on e.journal_id = j.id
        join ledger_accounts a on a.id = e.account_id and a.kind = 'merchant_fees_owed'
        where j.kind = 'fee' and j.invoice_id = i.id), 0))`,
  /** Every prepaid fee top-up is booked once, for exactly its amount, against the merchant's fees owed (D-076). */
  topup_journal: sql`select t.id from fee_topups t
    where coalesce((select sum(e.amount) from ledger_journals j join ledger_entries e on e.journal_id = j.id
      join ledger_accounts a on a.id = e.account_id and a.kind = 'merchant_fees_owed'
      where j.kind = 'fee_topup' and j.topup_id = t.id), 0) <> -t.amount`,
  /** Paid non-custodial invoices settle in the same transaction; one left behind is stuck. */
  unsettled: sql`select i.id from invoices i where i.status in ('paid', 'overpaid') and i.custody_mode = ${NC}`,
  /** Whole ledger nets to zero per token (holds by construction; guards against disabled triggers). */
  ledger_unbalanced: sql`select a.token_id as id from ledger_entries e join ledger_accounts a on a.id = e.account_id
    group by a.token_id having sum(e.amount) <> 0`,
};

export type ReconciliationIssue = { check: keyof typeof CHECKS; count: number; sample: string[] };

export async function reconcileLedger(deps: Deps): Promise<ReconciliationIssue[]> {
  const startedAt = new Date(deps.clock());
  return withSystem(deps.db, async (tx) => {
    const issues: ReconciliationIssue[] = [];
    for (const [check, query] of Object.entries(CHECKS) as [keyof typeof CHECKS, (typeof CHECKS)[keyof typeof CHECKS]][]) {
      const r = await tx.execute<{ id: string }>(query);
      if (r.rows.length > 0) issues.push({ check, count: r.rows.length, sample: r.rows.slice(0, 20).map((x) => x.id) });
    }
    await tx.insert(reconciliationRuns).values({ startedAt, finishedAt: new Date(deps.clock()), ok: issues.length === 0, issues });
    if (issues.length > 0) deps.log.error({ issues }, 'RECONCILIATION MISMATCH');
    return issues;
  });
}
