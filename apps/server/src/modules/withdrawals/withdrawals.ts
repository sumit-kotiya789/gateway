// MONEY-CRITICAL
// Custodial payouts (M7d, D-090): payout addresses (24 h activation for live), withdrawal requests that hold the
// amount at once, admin approval (two different admins above WITHDRAWAL_TWO_PERSON_MIN), and the merchant's or an
// admin's cancel / reject that releases it. Sending happens in the worker (payouts.ts) through the signer.
// Payout-address timing uses the database clock: the guards that enforce it run in the database.
// D-100: payouts to the merchant's users (any wallet, auto-approved, flat payout fee) and the merchant's own
// withdrawal limits (one-time and daily per token), enforced here, in the database guard and again by the signer.
import { AppError, feeUnitsToMinor, fromMinorUnits, toMinorUnits } from '@gw/core';
import { and, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { getAddress, isAddress } from 'viem';
import type { Tx } from '../../common/db.js';
import { ledgerAccounts, ledgerEntries, merchantWithdrawalLimits, merchants, payoutAddresses, tokens, withdrawals } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { notifyOwners } from '../email/outbox.js';
import { templates } from '../email/templates.js';
import { resolveToken } from '../invoices/invoices.js';
import { holdWithdrawal, releaseWithdrawal } from '../ledger/ledger.js';
import { currentPayoutAddress } from '../custody/payout-addresses.js';
import { effectiveTwoPersonMin, readAdminSettings } from '../admin/settings.js';
import { assertPayoutWhitelisted } from '../security/whitelist.js';

/** A new live payout address takes effect this long after it was added (owners are emailed meanwhile). */
export const PAYOUT_ADDRESS_COOLDOWN_H = 24;

type PayoutRow = typeof payoutAddresses.$inferSelect;
type WithdrawalRow = typeof withdrawals.$inferSelect;
type LimitsRow = typeof merchantWithdrawalLimits.$inferSelect;
type TokenMeta = { id: string; decimals: number; symbol: string };

/** The address withdrawals (and forwarders, D-097) of this mode and family go to now. */
export { currentPayoutAddress };

/** Payout addresses are for custodial merchants (withdrawals) and forwarder merchants (where forwarders pay, D-097). */
async function payoutMerchant(tx: Tx, merchantId: string) {
  const [m] = await tx.select({ mode: merchants.custodyMode }).from(merchants).where(eq(merchants.id, merchantId));
  /* v8 ignore next -- callers pass the authenticated merchant */
  if (!m) throw new AppError('not_found', 'merchant not found');
  if (m.mode === 'non_custodial_xpub') throw new AppError('forbidden', 'payout addresses are for custodial and wallet-address (forwarder) accounts; xpub accounts are paid to their own wallet');
}

/**
 * Withdrawals exist only while custody is on (FEATURE_CUSTODIAL): with it off no worker sends them, so none may be
 * requested or approved. Cancelling and rejecting stay allowed: they only release a hold back to the balance.
 */
function assertCustodyOn(deps: Deps): void {
  if (!deps.config.FEATURE_CUSTODIAL) throw new AppError('forbidden', 'withdrawals are not available: custody is off on this platform', { reason: 'custody_off' });
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
  await payoutMerchant(tx, p.merchantId);
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

/** The merchant's own withdrawal limits for a mode and token (D-100), or null when none are set. */
export async function withdrawalLimits(tx: Tx, merchantId: string, livemode: boolean, tokenId: string): Promise<LimitsRow | null> {
  const [l] = await tx
    .select()
    .from(merchantWithdrawalLimits)
    .where(and(eq(merchantWithdrawalLimits.merchantId, merchantId), eq(merchantWithdrawalLimits.livemode, livemode), eq(merchantWithdrawalLimits.tokenId, tokenId)));
  return l ?? null;
}

/** What the merchant withdrew (or holds for withdrawals) in a token over the last 24 hours, by the database clock. */
export async function withdrawnToday(tx: Tx, merchantId: string, livemode: boolean, tokenId: string): Promise<bigint> {
  const [r] = await tx
    .select({ total: sql<string>`coalesce(sum(${withdrawals.amount}), 0)::text` })
    .from(withdrawals)
    .where(
      and(
        eq(withdrawals.merchantId, merchantId),
        eq(withdrawals.livemode, livemode),
        eq(withdrawals.tokenId, tokenId),
        notInArray(withdrawals.status, ['failed', 'rejected', 'cancelled']),
        sql`${withdrawals.createdAt} > now() - interval '24 hours'`,
      ),
    );
  /* v8 ignore next -- an aggregate without GROUP BY returns exactly one row */
  if (!r) throw new Error('daily total query returned no row');
  return BigInt(r.total);
}

/** Refuses a withdrawal above the merchant's limits. Callers hold the merchant row lock (one request at a time). */
async function assertWithinLimits(tx: Tx, p: { merchantId: string; livemode: boolean; token: TokenMeta; amount: bigint; requireBoth: boolean }): Promise<void> {
  const l = await withdrawalLimits(tx, p.merchantId, p.livemode, p.token.id);
  const perTx = l?.perTx ?? null;
  const perDay = l?.perDay ?? null;
  const units = (v: bigint) => `${fromMinorUnits(v, p.token.decimals)} ${p.token.symbol}`;
  if (p.requireBoth && (perTx === null || perDay === null)) {
    throw new AppError('conflict', `set a one-time and a daily withdrawal limit for ${p.token.symbol} before paying users in live mode`, { reason: 'limits_required' });
  }
  if (perTx !== null && p.amount > perTx) throw new AppError('conflict', `amount above your one-time withdrawal limit (${units(perTx)})`, { reason: 'over_tx_limit' });
  if (perDay !== null) {
    const used = await withdrawnToday(tx, p.merchantId, p.livemode, p.token.id);
    if (used + p.amount > perDay) {
      const left = perDay > used ? perDay - used : 0n;
      throw new AppError('conflict', `amount above your daily withdrawal limit (${units(left)} left for the next 24 hours)`, { reason: 'over_day_limit' });
    }
  }
}

export async function requestWithdrawal(
  deps: Deps,
  tx: Tx,
  p: { merchantId: string; livemode: boolean; tokenId: string; amount: string; requestedBy: string },
): Promise<WithdrawalRow> {
  assertCustodyOn(deps);
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
  await assertWithinLimits(tx, { merchantId: p.merchantId, livemode: p.livemode, token, amount, requireBoth: false });
  // Test mode moves testnet tokens only: no approval. Live: one admin, two at or above the threshold (console
  // setting, never above the server's WITHDRAWAL_TWO_PERSON_MIN; D-107).
  const twoPersonMin = toMinorUnits(effectiveTwoPersonMin(await readAdminSettings(deps), deps.config.WITHDRAWAL_TWO_PERSON_MIN), token.decimals);
  const approvalsRequired = !p.livemode ? 0 : amount >= twoPersonMin ? 2 : 1;
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

/**
 * A payout to one of the merchant's users (D-100): any wallet the user gives, sent automatically (no approval) within
 * the merchant's limits, which live mode requires. The amount plus the merchant's flat payout fee is held at once.
 * Never to a platform wallet, a deposit address or a blocked address (checked again by the database and the signer).
 */
export async function requestPayout(
  deps: Deps,
  tx: Tx,
  p: { merchantId: string; livemode: boolean; tokenId: string; amount: string; toAddress: string; customerRef: string; requestedBy: string },
): Promise<WithdrawalRow> {
  assertCustodyOn(deps);
  const m = await custodialMerchant(tx, p.merchantId, true);
  if (m.status !== 'active') throw new AppError('forbidden', 'account is suspended');
  if (m.riskFlags.includes('payouts_frozen')) throw new AppError('forbidden', 'payouts are frozen on this account; contact support', { reason: 'payouts_frozen' });
  const { token } = await resolveToken(tx, p.tokenId, p.livemode);
  const amount = toMinorUnits(p.amount, token.decimals);
  if (amount <= 0n) throw new AppError('invalid_amount', 'amount must be greater than zero');
  if (!isAddress(p.toAddress, { strict: true })) throw new AppError('validation_error', 'address checksum does not match: check for a typo', { field: 'to_address' });
  const to = getAddress(p.toAddress);
  const [ok] = await tx.execute<{ allowed: boolean }>(sql`select payout_destination_allowed(${to}) as allowed`).then((r) => r.rows);
  if (!ok?.allowed) throw new AppError('validation_error', 'this address cannot receive payouts (a gateway address or a blocked address)', { field: 'to_address', reason: 'bad_destination' });
  // Address whitelist (D-109): while on for this mode, only active whitelisted addresses (the database checks too).
  await assertPayoutWhitelisted(tx, { merchantId: p.merchantId, livemode: p.livemode, chainId: token.chainId, address: to, now: deps.clock() });
  await assertWithinLimits(tx, { merchantId: p.merchantId, livemode: p.livemode, token, amount, requireBoth: p.livemode });
  const fee = feeUnitsToMinor(m.payoutFee, token.decimals);
  const available = await availableBalance(tx, p.merchantId, p.livemode, token.id);
  if (amount + fee > available) {
    const extra = fee > 0n ? ` for the amount plus the ${fromMinorUnits(fee, token.decimals)} ${token.symbol} payout fee` : '';
    throw new AppError('conflict', `available balance (${fromMinorUnits(available, token.decimals)} ${token.symbol}) is not enough${extra}`, { reason: 'insufficient_balance' });
  }
  const [w] = await tx
    .insert(withdrawals)
    .values({
      merchantId: p.merchantId,
      livemode: p.livemode,
      chainId: token.chainId,
      tokenId: token.id,
      amount,
      kind: 'customer',
      payoutAddressId: null,
      customerRef: p.customerRef,
      toAddress: to,
      fee,
      status: 'approved',
      approvalsRequired: 0,
      requestedBy: p.requestedBy,
      nextAttemptAt: new Date(deps.clock()),
    })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!w) throw new Error('payout insert failed');
  await holdWithdrawal(tx, w);
  return w;
}

/** Sets (or clears, with null) the merchant's one-time and daily limits for a mode and token. Applies at once. */
export async function setWithdrawalLimits(
  tx: Tx,
  p: { merchantId: string; livemode: boolean; tokenId: string; perTx: string | null; perDay: string | null; userId: string },
): Promise<{ before: LimitsRow | null; after: LimitsRow }> {
  const { token } = await resolveToken(tx, p.tokenId, p.livemode);
  const parse = (v: string | null, field: string) => {
    if (v === null) return null;
    const minor = toMinorUnits(v, token.decimals);
    if (minor <= 0n) throw new AppError('validation_error', 'a limit must be greater than zero (or empty for no limit)', { field });
    return minor;
  };
  const perTx = parse(p.perTx, 'per_tx');
  const perDay = parse(p.perDay, 'per_day');
  if (perTx !== null && perDay !== null && perTx > perDay) throw new AppError('validation_error', 'the one-time limit cannot be above the daily limit', { field: 'per_tx' });
  const before = await withdrawalLimits(tx, p.merchantId, p.livemode, token.id);
  const [after] = await tx
    .insert(merchantWithdrawalLimits)
    .values({ merchantId: p.merchantId, livemode: p.livemode, tokenId: token.id, perTx, perDay, updatedBy: p.userId })
    .onConflictDoUpdate({
      target: [merchantWithdrawalLimits.merchantId, merchantWithdrawalLimits.livemode, merchantWithdrawalLimits.tokenId],
      set: { perTx, perDay, updatedBy: p.userId, updatedAt: sql`now()` },
    })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!after) throw new Error('limits upsert failed');
  return { before, after };
}

/** Limits of a mode for every token that has them, with what was used over the last 24 hours. */
export async function listWithdrawalLimits(tx: Tx, merchantId: string, livemode: boolean) {
  const rows = await tx
    .select({ l: merchantWithdrawalLimits, decimals: tokens.decimals, symbol: tokens.symbol })
    .from(merchantWithdrawalLimits)
    .innerJoin(tokens, eq(tokens.id, merchantWithdrawalLimits.tokenId))
    .where(and(eq(merchantWithdrawalLimits.merchantId, merchantId), eq(merchantWithdrawalLimits.livemode, livemode)))
    .orderBy(merchantWithdrawalLimits.tokenId);
  return Promise.all(rows.map(async ({ l, decimals, symbol }) => limitsView(l, { decimals, symbol }, await withdrawnToday(tx, merchantId, livemode, l.tokenId))));
}

export function limitsView(l: LimitsRow, t: { decimals: number; symbol: string }, used: bigint) {
  return {
    token: l.tokenId,
    symbol: t.symbol,
    livemode: l.livemode,
    per_tx: l.perTx === null ? null : fromMinorUnits(l.perTx, t.decimals),
    per_day: l.perDay === null ? null : fromMinorUnits(l.perDay, t.decimals),
    used_24h: fromMinorUnits(used, t.decimals),
    updated_at: l.updatedAt.toISOString(),
  };
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
  assertCustodyOn(deps);
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
  // Payouts to users are many and automatic: the merchant follows them by webhook (payout.*), not by email.
  if (w.kind === 'customer') return;
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
    object: w.kind === 'customer' ? ('payout' as const) : ('withdrawal' as const),
    livemode: w.livemode,
    kind: w.kind,
    customer_ref: w.customerRef,
    status: w.status,
    token: w.tokenId,
    symbol: t.symbol,
    amount: fromMinorUnits(w.amount, t.decimals),
    fee: fromMinorUnits(w.fee, t.decimals),
    to_address: w.toAddress,
    approvals_required: w.approvalsRequired,
    approvals: w.approvedBy.length,
    tx_hash: w.txHash,
    reason: w.decisionReason,
    created_at: w.createdAt.toISOString(),
    confirmed_at: w.confirmedAt?.toISOString() ?? null,
  };
}
