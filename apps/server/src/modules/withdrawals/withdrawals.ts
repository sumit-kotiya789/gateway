// MONEY-CRITICAL
// Custodial payouts (M7d, D-090): payout addresses (24 h activation for live), withdrawal requests that hold the
// amount at once, admin approval (two different admins above WITHDRAWAL_TWO_PERSON_MIN), and the merchant's or an
// admin's cancel / reject that releases it. Sending happens in the worker (payouts.ts) through the signer.
// Payout-address timing uses the database clock: the guards that enforce it run in the database.
import { AppError, fromMinorUnits, toMinorUnits } from '@gw/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getAddress, isAddress } from 'viem';
import type { Tx } from '../../common/db.js';
import { ledgerAccounts, ledgerEntries, merchants, payoutAddresses, tokens, withdrawals } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { notifyOwners } from '../email/outbox.js';
import { templates } from '../email/templates.js';
import { resolveToken } from '../invoices/invoices.js';
import { holdWithdrawal, releaseWithdrawal } from '../ledger/ledger.js';

/** A new live payout address takes effect this long after it was added (owners are emailed meanwhile). */
export const PAYOUT_ADDRESS_COOLDOWN_H = 24;

type PayoutRow = typeof payoutAddresses.$inferSelect;
type WithdrawalRow = typeof withdrawals.$inferSelect;
type Family = PayoutRow['family'];

/** The address withdrawals of this mode and family go to now: newest activated, not cancelled. */
export async function currentPayoutAddress(tx: Tx, merchantId: string, livemode: boolean, family: Family): Promise<PayoutRow | undefined> {
  const [row] = await tx
    .select()
    .from(payoutAddresses)
    .where(
      and(
        eq(payoutAddresses.merchantId, merchantId),
        eq(payoutAddresses.livemode, livemode),
        eq(payoutAddresses.family, family),
        isNull(payoutAddresses.cancelledAt),
        sql`${payoutAddresses.activatesAt} <= now()`,
      ),
    )
    .orderBy(desc(payoutAddresses.activatesAt), desc(payoutAddresses.createdAt))
    .limit(1);
  return row;
}

async function custodialMerchant(tx: Tx, merchantId: string, lock = false) {
  const q = tx.select().from(merchants).where(eq(merchants.id, merchantId));
  const [m] = lock ? await q.for('update') : await q;
  /* v8 ignore next -- callers pass the authenticated merchant */
  if (!m) throw new AppError('not_found', 'merchant not found');
  if (m.custodyMode !== 'custodial') throw new AppError('forbidden', 'withdrawals are for custodial accounts; your funds are already in your own wallet');
  return m;
}

export async function addPayoutAddress(
  deps: Deps,
  tx: Tx,
  p: { merchantId: string; livemode: boolean; address: string; label: string | null; userId: string },
): Promise<PayoutRow> {
  await custodialMerchant(tx, p.merchantId);
  // Mixed case means an EIP-55 checksum: a typo there is caught here, not after the money left.
  if (!isAddress(p.address, { strict: true })) throw new AppError('validation_error', 'address checksum does not match: check for a typo', { field: 'address' });
  const address = getAddress(p.address);
  const delay = p.livemode ? sql`now() + make_interval(hours => ${PAYOUT_ADDRESS_COOLDOWN_H})` : sql`now()`;
  const [row] = await tx
    .insert(payoutAddresses)
    .values({ merchantId: p.merchantId, livemode: p.livemode, family: 'evm', address, label: p.label, createdBy: p.userId, activatesAt: delay })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!row) throw new Error('payout address insert failed');
  if (p.livemode) {
    await notifyOwners(deps, tx, p.merchantId, 'payout_address_added', templates.payoutAddressAdded({ livemode: true, address: row.address, activatesAt: row.activatesAt.toISOString(), dashboardUrl: deps.config.DASHBOARD_URL }));
  }
  return row;
}

/** Cancels a payout address that is not active yet (the current one keeps serving). */
export async function cancelPayoutAddress(tx: Tx, merchantId: string, id: string): Promise<PayoutRow> {
  const [row] = await tx
    .update(payoutAddresses)
    .set({ cancelledAt: sql`now()` })
    .where(and(eq(payoutAddresses.id, id), eq(payoutAddresses.merchantId, merchantId), isNull(payoutAddresses.cancelledAt), sql`${payoutAddresses.activatesAt} > now()`))
    .returning();
  if (!row) throw new AppError('conflict', 'only a payout address that is not active yet can be cancelled');
  return row;
}

/** Withdrawable balance in minor units (merchant_available is a credit balance). */
async function availableBalance(tx: Tx, merchantId: string, livemode: boolean, tokenId: string): Promise<bigint> {
  const [r] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerAccounts.kind, 'merchant_available'), eq(ledgerAccounts.merchantId, merchantId), eq(ledgerAccounts.livemode, livemode), eq(ledgerAccounts.tokenId, tokenId)));
  /* v8 ignore next -- an aggregate without GROUP BY returns exactly one row */
  if (!r) throw new Error('balance query returned no row');
  return -BigInt(r.total);
}

export async function requestWithdrawal(
  deps: Deps,
  tx: Tx,
  p: { merchantId: string; livemode: boolean; tokenId: string; amount: string; requestedBy: string },
): Promise<WithdrawalRow> {
  // The merchant row lock serializes this merchant's withdrawals: two requests cannot both spend the same balance.
  const m = await custodialMerchant(tx, p.merchantId, true);
  if (m.status !== 'active') throw new AppError('forbidden', 'account is suspended');
  if (m.riskFlags.includes('payouts_frozen')) throw new AppError('forbidden', 'payouts are frozen on this account; contact support', { reason: 'payouts_frozen' });
  const { token, chain } = await resolveToken(tx, p.tokenId, p.livemode);
  const amount = toMinorUnits(p.amount, token.decimals);
  if (amount <= 0n) throw new AppError('invalid_amount', 'amount must be greater than zero');
  const to = await currentPayoutAddress(tx, p.merchantId, p.livemode, chain.family);
  if (!to) throw new AppError('conflict', `no active ${p.livemode ? 'live' : 'test'} payout address`, { reason: 'no_payout_address' });
  const available = await availableBalance(tx, p.merchantId, p.livemode, token.id);
  if (amount > available) {
    throw new AppError('conflict', `amount exceeds the available balance (${fromMinorUnits(available, token.decimals)} ${token.symbol})`, { reason: 'insufficient_balance' });
  }
  // Test mode moves testnet tokens only: no approval. Live: one admin, two at or above the threshold.
  const approvalsRequired = !p.livemode ? 0 : amount >= toMinorUnits(deps.config.WITHDRAWAL_TWO_PERSON_MIN, token.decimals) ? 2 : 1;
  const [w] = await tx
    .insert(withdrawals)
    .values({
      merchantId: p.merchantId,
      livemode: p.livemode,
      chainId: chain.id,
      tokenId: token.id,
      amount,
      payoutAddressId: to.id,
      toAddress: to.address,
      status: approvalsRequired === 0 ? 'approved' : 'pending_approval',
      approvalsRequired,
      requestedBy: p.requestedBy,
      nextAttemptAt: new Date(deps.clock()),
    })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!w) throw new Error('withdrawal insert failed');
  await holdWithdrawal(tx, w);
  await notifyOwners(deps, tx, p.merchantId, 'withdrawal_requested', templates.withdrawalRequested({ livemode: p.livemode, amount: p.amount, symbol: token.symbol, address: to.address }));
  return w;
}

async function locked(tx: Tx, id: string, merchantId?: string): Promise<WithdrawalRow> {
  const [w] = await tx
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.id, id), merchantId ? eq(withdrawals.merchantId, merchantId) : undefined))
    .for('update');
  if (!w) throw new AppError('not_found', 'withdrawal not found');
  return w;
}

/** The merchant withdraws its own request while it still awaits approval. */
export async function cancelWithdrawal(tx: Tx, merchantId: string, id: string): Promise<WithdrawalRow> {
  const w = await locked(tx, id, merchantId);
  if (w.status !== 'pending_approval') throw new AppError('conflict', `a ${w.status} withdrawal cannot be cancelled`);
  const [next] = await tx.update(withdrawals).set({ status: 'cancelled' }).where(eq(withdrawals.id, id)).returning();
  /* v8 ignore next -- row locked above */
  if (!next) throw new Error('withdrawal update failed');
  await releaseWithdrawal(tx, next);
  return next;
}

/** One admin's approval. Approved (and queued for sending) once enough different admins agreed. */
export async function approveWithdrawal(deps: Deps, tx: Tx, id: string, adminId: string): Promise<WithdrawalRow> {
  const w = await locked(tx, id);
  if (w.status !== 'pending_approval') throw new AppError('conflict', `withdrawal is ${w.status}`);
  if (w.approvedBy.includes(adminId)) throw new AppError('conflict', 'you already approved this withdrawal; another admin must approve it', { reason: 'second_approver_required' });
  const approvedBy = [...w.approvedBy, adminId];
  const done = approvedBy.length >= w.approvalsRequired;
  const [next] = await tx
    .update(withdrawals)
    .set({ approvedBy, ...(done ? { status: 'approved' as const, nextAttemptAt: new Date(deps.clock()) } : {}) })
    .where(eq(withdrawals.id, id))
    .returning();
  /* v8 ignore next -- row locked above */
  if (!next) throw new Error('withdrawal update failed');
  return next;
}

export async function rejectWithdrawal(deps: Deps, tx: Tx, id: string, reason: string): Promise<WithdrawalRow> {
  const w = await locked(tx, id);
  if (w.status !== 'pending_approval') throw new AppError('conflict', `withdrawal is ${w.status}`);
  const [next] = await tx.update(withdrawals).set({ status: 'rejected', decisionReason: reason }).where(eq(withdrawals.id, id)).returning();
  /* v8 ignore next -- row locked above */
  if (!next) throw new Error('withdrawal update failed');
  await releaseWithdrawal(tx, next);
  await noticeDone(deps, tx, next, reason);
  return next;
}

/** Emails the owners how a withdrawal ended. Callers pass a confirmed, failed or rejected withdrawal. */
export async function noticeDone(deps: Deps, tx: Tx, w: WithdrawalRow, reason: string | null): Promise<void> {
  const status = w.status as 'confirmed' | 'failed' | 'rejected';
  const [t] = await tx.select({ decimals: tokens.decimals, symbol: tokens.symbol }).from(tokens).where(eq(tokens.id, w.tokenId));
  /* v8 ignore next -- FK */
  if (!t) return;
  await notifyOwners(
    deps,
    tx,
    w.merchantId,
    `withdrawal_${status}`,
    templates.withdrawalDone({ status, amount: fromMinorUnits(w.amount, t.decimals), symbol: t.symbol, address: w.toAddress, txHash: w.txHash, reason }),
  );
}

/** Every payout address of a mode, newest first, with its status by the database clock. */
export async function listPayoutAddresses(tx: Tx, merchantId: string, livemode: boolean) {
  const rows = await tx
    .select({ a: payoutAddresses, active: sql<boolean>`${payoutAddresses.activatesAt} <= now()` })
    .from(payoutAddresses)
    .where(and(eq(payoutAddresses.merchantId, merchantId), eq(payoutAddresses.livemode, livemode)))
    .orderBy(desc(payoutAddresses.createdAt))
    .limit(50);
  const current = (await currentPayoutAddress(tx, merchantId, livemode, 'evm'))?.id ?? null;
  return rows.map(({ a, active }) => payoutAddressView(a, a.cancelledAt ? 'cancelled' : a.id === current ? 'current' : active ? 'superseded' : 'pending'));
}

export function payoutAddressView(a: PayoutRow, status: 'current' | 'pending' | 'superseded' | 'cancelled') {
  return {
    id: a.id,
    livemode: a.livemode,
    address: a.address,
    label: a.label,
    status,
    activates_at: a.activatesAt.toISOString(),
    created_at: a.createdAt.toISOString(),
  };
}

export function withdrawalView(w: WithdrawalRow, t: { decimals: number; symbol: string }) {
  return {
    id: w.id,
    object: 'withdrawal' as const,
    livemode: w.livemode,
    status: w.status,
    token: w.tokenId,
    symbol: t.symbol,
    amount: fromMinorUnits(w.amount, t.decimals),
    to_address: w.toAddress,
    approvals_required: w.approvalsRequired,
    approvals: w.approvedBy.length,
    tx_hash: w.txHash,
    reason: w.decisionReason,
    created_at: w.createdAt.toISOString(),
    confirmed_at: w.confirmedAt?.toISOString() ?? null,
  };
}
