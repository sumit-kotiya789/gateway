// MONEY-CRITICAL
// Double-entry ledger. Postings happen inside the transaction that confirms a payment or settles an invoice, so the
// ledger can never disagree with payments/invoices at a commit boundary. Signed minor units: debit > 0, credit < 0.
// Every journal sums to zero in one token (DB-enforced at commit). Journals are idempotent by payment / invoice.
//
// Non-custodial (MVP) postings:
//   payment confirmed (A):  Dr merchant_received A   / Cr merchant_sales A      (memo: funds in the merchant's wallet)
//   invoice settled  (fee): Dr merchant_fees_owed F  / Cr platform_fee_revenue F
//   fee top-up       (T):   Dr platform_topups T     / Cr merchant_fees_owed T   (prepaid fees, D-076)
//
// Custodial postings (M7, D-087): the platform holds the funds.
//   payment confirmed (A):  Dr custody_deposits A (platform) / Cr merchant_pending A
//   sweep confirmed  (S):   Dr custody_hot S / Cr custody_deposits S        (platform assets only)
//   withdrawal (W): requested  Dr merchant_available W  / Cr merchant_withdrawing W   (hold)
//                   confirmed  Dr merchant_withdrawing W / Cr custody_hot W           (left custody)
//                   released   Dr merchant_withdrawing W / Cr merchant_available W    (rejected, cancelled, reverted)
//   invoice settled  (R received, F fee, after the funds were swept):
//                           Dr merchant_pending R / Cr merchant_available R-F / Cr platform_fee_revenue F
// The database allows each journal kind only its own account kinds (ledger_entry_guard).
import { AppError, classifyPayment, computeFee, feeBase } from '@gw/core';
import { forwarderFeeOn } from '@gw/chains';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { feeTopups, forwards, ledgerAccounts, ledgerEntries, ledgerJournals, invoices, payments, sweeps } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { transitionInvoice, type InvoiceRow } from '../invoices/invoices.js';
import { noticeFeeBalance } from './fee-balance.js';

type AccountKind = (typeof ledgerAccounts.$inferSelect)['kind'];
type PaymentRow = typeof payments.$inferSelect;
type FeeTopupRow = typeof feeTopups.$inferSelect;
type SweepRow = typeof sweeps.$inferSelect;
type ForwardRow = typeof forwards.$inferSelect;

async function accountId(tx: Tx, kind: AccountKind, merchantId: string | null, livemode: boolean, tokenId: string): Promise<string> {
  await tx.insert(ledgerAccounts).values({ kind, merchantId, livemode, tokenId }).onConflictDoNothing();
  const [a] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, kind),
        merchantId === null ? sql`${ledgerAccounts.merchantId} is null` : eq(ledgerAccounts.merchantId, merchantId),
        eq(ledgerAccounts.livemode, livemode),
        eq(ledgerAccounts.tokenId, tokenId),
      ),
    );
  /* v8 ignore next -- invariant: inserted or already present just above */
  if (!a) throw new Error(`ledger account ${kind} missing`);
  return a.id;
}

interface JournalHead {
  kind: 'payment' | 'fee' | 'fee_topup' | 'settlement' | 'sweep' | 'withdrawal_hold' | 'withdrawal' | 'withdrawal_release' | 'forward_fee';
  merchantId: string;
  livemode: boolean;
  tokenId: string;
  invoiceId?: string;
  paymentId?: string;
  topupId?: string;
  sweepId?: string;
  withdrawalId?: string;
  forwardId?: string;
}

/** Writes a journal and its lines. Returns false (and writes nothing) if this journal already exists. */
async function post(tx: Tx, head: JournalHead, lines: [AccountKind, 'merchant' | 'platform', bigint][]): Promise<boolean> {
  const [j] = await tx
    .insert(ledgerJournals)
    .values({ ...head, invoiceId: head.invoiceId ?? null, paymentId: head.paymentId ?? null, topupId: head.topupId ?? null, sweepId: head.sweepId ?? null, withdrawalId: head.withdrawalId ?? null, forwardId: head.forwardId ?? null })
    .onConflictDoNothing()
    .returning({ id: ledgerJournals.id });
  if (!j) return false;
  for (const [kind, owner, amount] of lines) {
    if (amount === 0n) continue; // e.g. a fee that takes the whole amount: no zero lines
    const merchantId = owner === 'merchant' ? head.merchantId : null;
    await tx.insert(ledgerEntries).values({
      journalId: j.id,
      accountId: await accountId(tx, kind, merchantId, head.livemode, head.tokenId),
      merchantId,
      amount,
    });
  }
  return true;
}

/** Posts a just-confirmed payment. Idempotent per payment. */
export async function postPayment(tx: Tx, p: PaymentRow): Promise<void> {
  const [inv] = await tx.select({ mode: invoices.custodyMode }).from(invoices).where(eq(invoices.id, p.invoiceId));
  const head = { kind: 'payment' as const, merchantId: p.merchantId, livemode: p.livemode, tokenId: p.tokenId, invoiceId: p.invoiceId, paymentId: p.id };
  // Non-custodial (xpub, forwarder): the funds are the merchant's from the start (memo pair).
  if (inv?.mode === 'non_custodial_xpub' || inv?.mode === 'non_custodial_forwarder') {
    await post(tx, head, [
      ['merchant_received', 'merchant', p.amount],
      ['merchant_sales', 'merchant', -p.amount],
    ]);
  } else if (inv?.mode === 'custodial') {
    // On a platform deposit address now; the merchant can withdraw it once swept and the invoice settled.
    await post(tx, head, [
      ['custody_deposits', 'platform', p.amount],
      ['merchant_pending', 'merchant', -p.amount],
    ]);
  }
}

/**
 * Custodial settlement: the invoice's funds reached the hot wallet, so what it received moves from pending to
 * available, minus the platform fee (on min(received, expected), snapshotted rate and fixed fee, never more than the
 * base), and paid/overpaid -> settled. Call only once the deposit address was swept (M7c). No-op for any other
 * invoice; idempotent (one settlement journal per invoice).
 */
export async function settleCustodialInvoice(deps: Deps, tx: Tx, invoiceId: string): Promise<boolean> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (!inv || inv.custodyMode !== 'custodial' || (inv.status !== 'paid' && inv.status !== 'overpaid')) return false;
  await creditReceived(tx, inv);
  await transitionInvoice(deps, tx, inv.id, 'settled', 'funds swept; platform fee deducted');
  return true;
}

/**
 * Custodial partial payment (D-099): an underpaid invoice whose deadline passed closes as partially_paid, and what it
 * received moves from pending to available minus the fee on that amount (percentage + fixed, never more than what
 * arrived). The caller checked the deadline and that every confirmed payment was swept. No-op for any other invoice.
 */
export async function closePartialPayment(deps: Deps, tx: Tx, invoiceId: string): Promise<boolean> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (!inv || inv.custodyMode !== 'custodial' || inv.status !== 'underpaid') return false;
  // Status first: the journal guard credits only paid, overpaid or partially_paid custodial invoices.
  await creditReceived(tx, await transitionInvoice(deps, tx, inv.id, 'partially_paid', 'deadline passed: what arrived is credited'));
  return true;
}

/**
 * Forwarded deposits of a user's permanent address (D-101), oldest first: settled once the address's confirmed
 * forwards moved at least everything up to them. Each deposit's fee_amount is the fee the uncapped forwarder takes on
 * it alone (a flush of several deposits at once can take up to one minor unit more in total, booked by postForward).
 */
async function settleForwardedDeposits(deps: Deps, tx: Tx, depositAddressId: string): Promise<boolean> {
  const [r] = await tx
    .select({ moved: sql<string>`coalesce(sum(${forwards.toMerchant} + ${forwards.fee}), 0)::text` })
    .from(forwards)
    .where(and(eq(forwards.depositAddressId, depositAddressId), eq(forwards.status, 'confirmed')));
  let any = false;
  for (const d of await depositsCovered(tx, depositAddressId, BigInt(r?.moved ?? '0'))) {
    if (d.status !== 'paid' && d.status !== 'overpaid') continue;
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, d.id)).for('update');
    /* v8 ignore next -- the row was just read */
    if (!inv) continue;
    await tx.update(invoices).set({ feeAmount: forwarderFeeOn(inv.amountReceived, inv.feeBps) }).where(eq(invoices.id, inv.id));
    await transitionInvoice(deps, tx, inv.id, 'settled', 'deposit forwarded to the merchant wallet');
    any = true;
  }
  return any;
}

/**
 * Pending -> available for everything the invoice received, minus its fee (on min(received, expected)); records the
 * fee. Callers hold the invoice row lock and checked a status that has no settlement journal yet.
 */
async function creditReceived(tx: Tx, inv: InvoiceRow): Promise<void> {
  const received = inv.amountReceived;
  const fee = computeFee(feeBase(inv.amountExpected, received), inv.feeBps, inv.feeFixed);
  const head = { kind: 'settlement' as const, merchantId: inv.merchantId, livemode: inv.livemode, tokenId: inv.tokenId, invoiceId: inv.id };
  const posted = await post(tx, head, [
    ['merchant_pending', 'merchant', received],
    ['merchant_available', 'merchant', -(received - fee)],
    ['platform_fee_revenue', 'platform', -fee],
  ]);
  /* v8 ignore next -- invariant: callers checked the status; the one-settlement-per-invoice index refuses a second one */
  if (!posted) throw new Error('settlement already posted');
  await tx.update(invoices).set({ feeAmount: fee }).where(eq(invoices.id, inv.id));
}

/**
 * Non-custodial settlement: charges the platform fee on min(received, expected) at the invoice's snapshotted rate (plus
 * its snapshotted fixed fee, never more than the base) and
 * moves paid/overpaid -> settled, all in the caller's transaction. No-op for any other invoice. Also the path for
 * manual resolutions that end in `paid` (resolveInvoice). Custodial invoices go to settleIfSwept instead.
 */
export async function settleInvoice(deps: Deps, tx: Tx, invoiceId: string): Promise<void> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (inv?.custodyMode === 'custodial') {
    await settleIfSwept(deps, tx, invoiceId);
    return;
  }
  // Forwarder invoices settle when their funds have been forwarded (settleIfForwarded), not here.
  if (inv?.custodyMode === 'non_custodial_forwarder') {
    await settleIfForwarded(deps, tx, invoiceId);
    return;
  }
  // xpub from here on (custodial and forwarder returned above)
  if (!inv || (inv.status !== 'paid' && inv.status !== 'overpaid')) return;
  const fee = computeFee(feeBase(inv.amountExpected, inv.amountReceived), inv.feeBps, inv.feeFixed);
  if (fee > 0n) {
    const head = { kind: 'fee' as const, merchantId: inv.merchantId, livemode: inv.livemode, tokenId: inv.tokenId, invoiceId: inv.id };
    await post(tx, head, [
      ['merchant_fees_owed', 'merchant', fee],
      ['platform_fee_revenue', 'platform', -fee],
    ]);
    if (inv.livemode) await noticeFeeBalance(deps, tx, inv.merchantId, inv.tokenId, fee);
  }
  await tx.update(invoices).set({ feeAmount: fee }).where(eq(invoices.id, inv.id));
  await transitionInvoice(deps, tx, inv.id, 'settled', 'platform fee charged');
}

/**
 * Forwarder mode (D-097): books a confirmed flush. The contract paid `fee` of what the merchant received into the
 * platform fee wallet: merchant_received -fee / merchant_sales +fee (the merchant kept less), platform_fee_wallet +fee /
 * platform_fee_revenue -fee. Idempotent per forward (one forward_fee journal each). No journal for a zero fee.
 */
export async function postForward(tx: Tx, f: ForwardRow): Promise<void> {
  /* v8 ignore next -- only confirmed forwards (fee set, DB check) are posted */
  if (f.status !== 'confirmed' || f.fee === null) throw new Error('only a confirmed forward can be posted');
  if (f.fee === 0n) return;
  await post(tx, { kind: 'forward_fee', merchantId: f.merchantId, livemode: f.livemode, tokenId: f.tokenId, invoiceId: f.invoiceId, forwardId: f.id }, [
    ['merchant_received', 'merchant', -f.fee],
    ['merchant_sales', 'merchant', f.fee],
    ['platform_fee_wallet', 'platform', f.fee],
    ['platform_fee_revenue', 'platform', -f.fee],
  ]);
}

/**
 * Forwarder settlement (D-097): a paid / overpaid forwarder invoice settles once confirmed forwards have moved at
 * least everything its confirmed payments brought in. Its fee_amount is what the forwarders took (the contract caps it
 * at the fee on the expected amount). Payments that arrive later are still forwarded and booked by postForward, but
 * the settled invoice keeps its fee.
 */
export async function settleIfForwarded(deps: Deps, tx: Tx, invoiceId: string): Promise<boolean> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (inv?.kind === 'deposit' && inv.custodyMode === 'non_custodial_forwarder') return settleForwardedDeposits(deps, tx, inv.depositAddressId);
  if (!inv || inv.custodyMode !== 'non_custodial_forwarder' || (inv.status !== 'paid' && inv.status !== 'overpaid')) return false;
  const [r] = await tx
    .select({
      moved: sql<string>`coalesce(sum(${forwards.toMerchant} + ${forwards.fee}), 0)::text`,
      fee: sql<string>`coalesce(sum(${forwards.fee}), 0)::text`,
    })
    .from(forwards)
    .where(and(eq(forwards.invoiceId, inv.id), eq(forwards.status, 'confirmed')));
  const [p] = await tx
    .select({ received: sql<string>`coalesce(sum(${payments.amount}), 0)::text` })
    .from(payments)
    .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, 'confirmed')));
  /* v8 ignore next -- aggregates always return one row */
  if (!r || !p) return false;
  const received = BigInt(p.received);
  if (received === 0n || BigInt(r.moved) < received) return false;
  await tx.update(invoices).set({ feeAmount: BigInt(r.fee) }).where(eq(invoices.id, inv.id));
  await transitionInvoice(deps, tx, inv.id, 'settled', 'funds forwarded to the merchant wallet');
  return true;
}

/** Books a just-confirmed sweep (platform assets move from the deposit address to the hot wallet). Idempotent. */
export async function postSweep(tx: Tx, s: SweepRow): Promise<void> {
  await post(tx, { kind: 'sweep', merchantId: s.merchantId, livemode: s.livemode, tokenId: s.tokenId, invoiceId: s.invoiceId, sweepId: s.id }, [
    ['custody_hot', 'platform', s.amount],
    ['custody_deposits', 'platform', -s.amount],
  ]);
}

type WithdrawalRef = { id: string; merchantId: string; livemode: boolean; tokenId: string; amount: bigint; fee: bigint };
const withdrawalHead = (kind: 'withdrawal_hold' | 'withdrawal' | 'withdrawal_release', w: WithdrawalRef) => ({
  kind,
  merchantId: w.merchantId,
  livemode: w.livemode,
  tokenId: w.tokenId,
  withdrawalId: w.id,
});

/**
 * Holds a requested withdrawal's amount plus its payout fee (user payouts, D-100; 0 otherwise). The caller checked the
 * available balance under the merchant's row lock.
 */
export async function holdWithdrawal(tx: Tx, w: WithdrawalRef): Promise<void> {
  await post(tx, withdrawalHead('withdrawal_hold', w), [
    ['merchant_available', 'merchant', w.amount + w.fee],
    ['merchant_withdrawing', 'merchant', -(w.amount + w.fee)],
  ]);
}

/** The payout confirmed on chain: the amount leaves custody; the fee stays in the hot wallet as platform revenue. */
export async function completeWithdrawal(tx: Tx, w: WithdrawalRef): Promise<void> {
  const lines: [AccountKind, 'merchant' | 'platform', bigint][] = [
    ['merchant_withdrawing', 'merchant', w.amount + w.fee],
    ['custody_hot', 'platform', -w.amount],
  ];
  if (w.fee > 0n) lines.push(['platform_fee_revenue', 'platform', -w.fee]);
  await post(tx, withdrawalHead('withdrawal', w), lines);
}

/** Rejected, cancelled or reverted: the held amount and fee are available again. */
export async function releaseWithdrawal(tx: Tx, w: WithdrawalRef): Promise<void> {
  await post(tx, withdrawalHead('withdrawal_release', w), [
    ['merchant_withdrawing', 'merchant', w.amount + w.fee],
    ['merchant_available', 'merchant', -(w.amount + w.fee)],
  ]);
}

/**
 * Settles a paid/overpaid custodial invoice once every confirmed payment to its address has been swept (whichever
 * comes last: the payment, the sweep or an admin's acceptance). No-op otherwise. A deposit invoice (D-101) shares its
 * address with the user's other deposits: sweeps of the address are allocated to them oldest first.
 */
export async function settleIfSwept(deps: Deps, tx: Tx, invoiceId: string): Promise<boolean> {
  const [inv] = await tx.select({ kind: invoices.kind, depositAddressId: invoices.depositAddressId }).from(invoices).where(eq(invoices.id, invoiceId));
  if (inv?.kind === 'deposit') return settleSweptDeposits(deps, tx, inv.depositAddressId);
  const [r] = await tx.execute<{ booked: string; swept: string }>(sql`
    select coalesce((select sum(amount) from ${payments} where invoice_id = ${invoiceId} and status = 'confirmed'), 0)::text as booked,
           coalesce((select sum(amount) from ${sweeps} where invoice_id = ${invoiceId} and status = 'confirmed'), 0)::text as swept`).then((x) => x.rows);
  if (!r || BigInt(r.booked) === 0n || BigInt(r.swept) < BigInt(r.booked)) return false;
  return settleCustodialInvoice(deps, tx, invoiceId);
}

/**
 * Deposits of one address, oldest first, with what they received (confirmed). Each is covered by the address's
 * confirmed sweeps / forwards once the running total up to it is within what was moved.
 */
async function depositsCovered(tx: Tx, depositAddressId: string, moved: bigint) {
  const rows = await tx
    .select({ id: invoices.id, status: invoices.status, received: invoices.amountReceived })
    .from(invoices)
    .where(and(eq(invoices.depositAddressId, depositAddressId), eq(invoices.kind, 'deposit'), sql`${invoices.amountReceived} > 0`))
    .orderBy(invoices.createdAt, invoices.id);
  const covered: typeof rows = [];
  let total = 0n;
  for (const r of rows) {
    total += r.received;
    if (total > moved) break;
    covered.push(r);
  }
  return covered;
}

async function settleSweptDeposits(deps: Deps, tx: Tx, depositAddressId: string): Promise<boolean> {
  const [s] = await tx
    .select({ swept: sql<string>`coalesce(sum(${sweeps.amount}), 0)::text` })
    .from(sweeps)
    .where(and(eq(sweeps.depositAddressId, depositAddressId), eq(sweeps.status, 'confirmed')));
  let any = false;
  for (const d of await depositsCovered(tx, depositAddressId, BigInt(s?.swept ?? '0'))) {
    if (d.status === 'paid' || d.status === 'overpaid') any = (await settleCustodialInvoice(deps, tx, d.id)) || any;
  }
  return any;
}

/**
 * Manual resolution (admin, M5b): an underpaid or late_payment invoice is accepted as paid, then settled like any other
 * paid invoice (fee on what arrived, capped at expected). Only these two edges; everything else is a conflict.
 */
/**
 * Admin decision on an invoice that waits for one. underpaid / late_payment: accept (-> paid). held (risk review,
 * D-094): release (-> what its confirmed total classifies as) or reject (-> failed; the funds stay where they are and
 * any refund is handled outside the gateway).
 */
export async function resolveInvoice(deps: Deps, tx: Tx, invoiceId: string, reason: string, action: 'release' | 'reject' = 'release'): Promise<void> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (!inv) throw new AppError('not_found', 'invoice not found');
  if (inv.status === 'held') {
    const to = action === 'reject' ? 'failed' : classifyPayment(inv.amountExpected, inv.amountReceived, inv.underpayToleranceBps);
    await transitionInvoice(deps, tx, invoiceId, to, `manual: ${action === 'reject' ? 'rejected' : 'released'}: ${reason}`);
  } else if ((inv.status === 'underpaid' || inv.status === 'late_payment') && action === 'release') {
    await transitionInvoice(deps, tx, invoiceId, 'paid', `manual: ${reason}`);
  } else {
    throw new AppError('conflict', `cannot ${action} an invoice in status ${inv.status}`);
  }
  await settleInvoice(deps, tx, invoiceId); // no-op unless paid / overpaid
}

export interface TopupInput {
  merchantId: string;
  livemode: boolean;
  tokenId: string;
  amount: bigint;
  reference: string;
  adminId: string;
}

/** Records a prepaid fee top-up and posts its journal, in the caller's transaction (a top-up never exists alone). */
export async function recordFeeTopup(tx: Tx, t: TopupInput): Promise<FeeTopupRow> {
  if (t.amount <= 0n) throw new AppError('invalid_amount', 'top-up amount must be greater than zero');
  const [row] = await tx
    .insert(feeTopups)
    .values({ merchantId: t.merchantId, livemode: t.livemode, tokenId: t.tokenId, amount: t.amount, reference: t.reference, createdBy: t.adminId })
    .returning();
  /* v8 ignore next -- invariant: INSERT ... RETURNING yields the row or throws */
  if (!row) throw new Error('fee top-up insert failed');
  await post(tx, { kind: 'fee_topup', merchantId: t.merchantId, livemode: t.livemode, tokenId: t.tokenId, topupId: row.id }, [
    ['platform_topups', 'platform', t.amount],
    ['merchant_fees_owed', 'merchant', -t.amount],
  ]);
  return row;
}

/**
 * Per-token balances of one merchant in one mode (minor units). Positive = debit balance. `feesOwed` is the net
 * merchant_fees_owed balance (fees charged minus top-ups: negative = prepaid); `feesCharged` is its gross debit side.
 */
export async function merchantBalances(tx: Tx, merchantId: string, livemode: boolean) {
  const rows = await tx
    .select({
      kind: ledgerAccounts.kind,
      tokenId: ledgerAccounts.tokenId,
      total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text`,
      debits: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.amount} > 0), 0)::text`,
      credits: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.amount} < 0), 0)::text`,
    })
    .from(ledgerAccounts)
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(and(eq(ledgerAccounts.merchantId, merchantId), eq(ledgerAccounts.livemode, livemode)))
    .groupBy(ledgerAccounts.kind, ledgerAccounts.tokenId);
  const out = new Map<string, MerchantBalance>();
  const get = (token: string) => {
    const b = out.get(token) ?? { received: 0n, feesOwed: 0n, feesCharged: 0n, pending: 0n, available: 0n, withdrawing: 0n };
    out.set(token, b);
    return b;
  };
  for (const r of rows) {
    const b = get(r.tokenId);
    // Liabilities are credit balances: negate them so the merchant sees positive amounts.
    if (r.kind === 'merchant_received') b.received = BigInt(r.total);
    if (r.kind === 'merchant_fees_owed') {
      b.feesOwed = BigInt(r.total);
      b.feesCharged = BigInt(r.debits);
    }
    if (r.kind === 'merchant_pending') {
      b.pending = -BigInt(r.total);
      b.received = -BigInt(r.credits); // every credit to pending is a confirmed payment
    }
    if (r.kind === 'merchant_available') b.available = -BigInt(r.total);
    if (r.kind === 'merchant_withdrawing') b.withdrawing = -BigInt(r.total);
  }
  // Fees taken out of the merchant's money, read from the merchant's own lines (platform account rows are invisible in
  // the merchant's tenant context, RLS). Custodial, per settlement journal: pending debit R + available credit -(R-F) = F.
  // Forwarder, per forward_fee journal: merchant_received -F (the fee went to the platform on-chain, D-097).
  const fees = await tx
    .select({ tokenId: ledgerJournals.tokenId, kind: ledgerJournals.kind, total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerJournals)
    .innerJoin(ledgerEntries, eq(ledgerEntries.journalId, ledgerJournals.id))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerJournals.merchantId, merchantId),
        eq(ledgerJournals.livemode, livemode),
        or(
          and(eq(ledgerJournals.kind, 'settlement'), inArray(ledgerAccounts.kind, ['merchant_pending', 'merchant_available'])),
          and(eq(ledgerJournals.kind, 'forward_fee'), eq(ledgerAccounts.kind, 'merchant_received')),
        ),
      ),
    )
    .groupBy(ledgerJournals.tokenId, ledgerJournals.kind);
  for (const f of fees) {
    const b = get(f.tokenId);
    if (f.kind === 'forward_fee') {
      // Received stays the gross amount customers paid, as in the other modes; the fee is shown beside it.
      b.feesCharged += -BigInt(f.total);
      b.received += -BigInt(f.total);
    } else {
      b.feesCharged += BigInt(f.total);
    }
  }
  return out;
}

export interface MerchantBalance {
  /** Confirmed payments received (non-custodial: into the merchant's wallet; custodial: into platform custody). */
  received: bigint;
  /** Net merchant_fees_owed (non-custodial prepaid model, D-076). */
  feesOwed: bigint;
  feesCharged: bigint;
  /** Custodial: received, not swept and settled yet. */
  pending: bigint;
  /** Custodial: withdrawable. */
  available: bigint;
  /** Custodial: held for withdrawals in flight. */
  withdrawing: bigint;
}
