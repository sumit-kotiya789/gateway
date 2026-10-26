// MONEY-CRITICAL
// Double-entry ledger. Postings happen inside the transaction that confirms a payment or settles an invoice, so the
// ledger can never disagree with payments/invoices at a commit boundary. Signed minor units: debit > 0, credit < 0.
// Every journal sums to zero in one token (DB-enforced at commit). Journals are idempotent by payment / invoice.
//
// Non-custodial (MVP) postings:
//   payment confirmed (A):  Dr merchant_received A   / Cr merchant_sales A      (memo: funds in the merchant's wallet)
//   invoice settled  (fee): Dr merchant_fees_owed F  / Cr platform_fee_revenue F
//   fee top-up       (T):   Dr platform_topups T     / Cr merchant_fees_owed T   (prepaid fees, D-076)
// Custodial postings (pending/available balances, sweeps) arrive with M7; custodial invoices stay `paid` until then.
import { AppError, computeFee, feeBase } from '@gw/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { feeTopups, ledgerAccounts, ledgerEntries, ledgerJournals, invoices, payments } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { transitionInvoice } from '../invoices/invoices.js';

type AccountKind = (typeof ledgerAccounts.$inferSelect)['kind'];
type PaymentRow = typeof payments.$inferSelect;
type FeeTopupRow = typeof feeTopups.$inferSelect;

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
  kind: 'payment' | 'fee' | 'fee_topup';
  merchantId: string;
  livemode: boolean;
  tokenId: string;
  invoiceId?: string;
  paymentId?: string;
  topupId?: string;
}

/** Writes a journal and its lines. Returns false (and writes nothing) if this journal already exists. */
async function post(tx: Tx, head: JournalHead, lines: [AccountKind, 'merchant' | 'platform', bigint][]): Promise<boolean> {
  const [j] = await tx
    .insert(ledgerJournals)
    .values({ ...head, invoiceId: head.invoiceId ?? null, paymentId: head.paymentId ?? null, topupId: head.topupId ?? null })
    .onConflictDoNothing()
    .returning({ id: ledgerJournals.id });
  if (!j) return false;
  for (const [kind, owner, amount] of lines) {
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
  if (inv?.mode !== 'non_custodial_xpub') return; // custodial postings: M7
  const head = { kind: 'payment' as const, merchantId: p.merchantId, livemode: p.livemode, tokenId: p.tokenId, invoiceId: p.invoiceId, paymentId: p.id };
  await post(tx, head, [
    ['merchant_received', 'merchant', p.amount],
    ['merchant_sales', 'merchant', -p.amount],
  ]);
}

/**
 * Non-custodial settlement: charges the platform fee on min(received, expected) at the invoice's snapshotted rate (plus
 * its snapshotted fixed fee, never more than the base) and
 * moves paid/overpaid -> settled, all in the caller's transaction. No-op for any other invoice. Also the path for
 * manual resolutions that end in `paid` (resolveInvoice).
 */
export async function settleInvoice(deps: Deps, tx: Tx, invoiceId: string): Promise<void> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (!inv || inv.custodyMode !== 'non_custodial_xpub' || (inv.status !== 'paid' && inv.status !== 'overpaid')) return;
  const fee = computeFee(feeBase(inv.amountExpected, inv.amountReceived), inv.feeBps, inv.feeFixed);
  if (fee > 0n) {
    const head = { kind: 'fee' as const, merchantId: inv.merchantId, livemode: inv.livemode, tokenId: inv.tokenId, invoiceId: inv.id };
    await post(tx, head, [
      ['merchant_fees_owed', 'merchant', fee],
      ['platform_fee_revenue', 'platform', -fee],
    ]);
  }
  await tx.update(invoices).set({ feeAmount: fee }).where(eq(invoices.id, inv.id));
  await transitionInvoice(deps, tx, inv.id, 'settled', 'platform fee charged');
}

/**
 * Manual resolution (admin, M5b): an underpaid or late_payment invoice is accepted as paid, then settled like any other
 * paid invoice (fee on what arrived, capped at expected). Only these two edges; everything else is a conflict.
 */
export async function resolveInvoice(deps: Deps, tx: Tx, invoiceId: string, reason: string): Promise<void> {
  const [inv] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (!inv) throw new AppError('not_found', 'invoice not found');
  if (inv.status !== 'underpaid' && inv.status !== 'late_payment') {
    throw new AppError('conflict', `only underpaid or late_payment invoices can be resolved (status: ${inv.status})`);
  }
  await transitionInvoice(deps, tx, invoiceId, 'paid', `manual: ${reason}`);
  await settleInvoice(deps, tx, invoiceId);
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
    })
    .from(ledgerAccounts)
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(and(eq(ledgerAccounts.merchantId, merchantId), eq(ledgerAccounts.livemode, livemode)))
    .groupBy(ledgerAccounts.kind, ledgerAccounts.tokenId);
  const out = new Map<string, { received: bigint; feesOwed: bigint; feesCharged: bigint }>();
  for (const r of rows) {
    const b = out.get(r.tokenId) ?? { received: 0n, feesOwed: 0n, feesCharged: 0n };
    if (r.kind === 'merchant_received') b.received = BigInt(r.total);
    if (r.kind === 'merchant_fees_owed') {
      b.feesOwed = BigInt(r.total);
      b.feesCharged = BigInt(r.debits);
    }
    out.set(r.tokenId, b);
  }
  return out;
}
