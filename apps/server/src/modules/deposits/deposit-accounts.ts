// MONEY-CRITICAL
// Permanent deposit addresses per user (D-101). A web3 project asks for its user's address once (per token) and shows
// it; every transfer to it becomes a deposit invoice that runs through the normal pipeline for the account's custody
// mode: custodial (swept, credited to the merchant's balance), forwarder (an uncapped forwarder pays the merchant's
// wallet, fee split on-chain) or xpub (an address of the merchant's own wallet, fee from the prepaid balance).
import { AppError, feeUnitsToMinor, fromMinorUnits } from '@gw/core';
import { forwarderFeeOn } from '@gw/chains';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { chains, depositAccounts, depositAddresses, forwarderParams, invoices, merchants, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { allocateDepositAddress } from '../custody/custody.js';
import { currentPayoutAddress } from '../custody/payout-addresses.js';
import { resolveToken, transitionInvoice, type InvoiceRow } from '../invoices/invoices.js';
import { assertFeeBalance } from '../ledger/fee-balance.js';
import { rowToChain } from '../registry/registry.js';

export type DepositAccountRow = typeof depositAccounts.$inferSelect;

/** Account addresses are watched for as long as the account exists. */
export const ACCOUNT_WATCH_UNTIL = new Date('9999-12-31T00:00:00Z');
/** A permanent forwarder takes the fee on every deposit (no single amount to cap it at). */
const UNCAPPED = 2n ** 256n - 1n;
/** A deposit invoice only waits this long if its transfer is reorged away before confirmation. */
const DEPOSIT_EXPIRY_MS = 30 * 24 * 3600_000;

/** Still the address to hand out: same custody mode, and a forwarder still pays the current payout address. */
async function stillCurrent(tx: Tx, a: DepositAccountRow, mode: string): Promise<boolean> {
  if (a.custodyMode !== mode) return false;
  if (a.custodyMode !== 'non_custodial_forwarder') return true;
  const [p] = await tx.select({ payout: forwarderParams.payoutAddressId }).from(forwarderParams).where(eq(forwarderParams.depositAddressId, a.depositAddressId));
  const [c] = await tx.select({ family: chains.family }).from(chains).where(eq(chains.id, a.chainId));
  /* v8 ignore next -- an account's chain is a foreign key */
  if (!c) return false;
  const cur = await currentPayoutAddress(tx, a.merchantId, a.livemode, c.family);
  return cur?.id === p?.payout;
}

/**
 * The user's deposit address for a token: the existing one, or a new one. Idempotent per (user, token). A forwarder
 * account whose payout address was replaced, or an account of another custody mode, is retired (still watched and
 * credited) and a new address is issued.
 */
export async function openDepositAccount(
  deps: Deps,
  tx: Tx,
  p: { merchantId: string; livemode: boolean; customerRef: string; tokenId: string },
): Promise<{ account: DepositAccountRow; created: boolean }> {
  const { token, chain } = await resolveToken(tx, p.tokenId, p.livemode);
  // One request per (user, token) at a time: two concurrent calls must not both allocate an address.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deposit-account:${p.merchantId}:${String(p.livemode)}:${p.customerRef}:${token.id}`}))`);
  const [m] = await tx.select({ mode: merchants.custodyMode, feeBps: merchants.feeBps, feeGrace: merchants.feeGrace }).from(merchants).where(eq(merchants.id, p.merchantId));
  /* v8 ignore next -- callers pass the authenticated merchant */
  if (!m) throw new AppError('not_found', 'merchant not found');
  const [cur] = await tx
    .select()
    .from(depositAccounts)
    .where(and(eq(depositAccounts.merchantId, p.merchantId), eq(depositAccounts.livemode, p.livemode), eq(depositAccounts.customerRef, p.customerRef), eq(depositAccounts.tokenId, token.id), isNull(depositAccounts.retiredAt)));
  if (cur) {
    if (await stillCurrent(tx, cur, m.mode)) return { account: cur, created: false };
    await tx.update(depositAccounts).set({ retiredAt: sql`now()` }).where(eq(depositAccounts.id, cur.id));
  }
  // Before an address is allocated: a refused request must not burn a derivation index (xpub wallet gap).
  if (m.mode === 'non_custodial_xpub') await assertFeeBalance(tx, p.merchantId, p.livemode, token, m.feeGrace);
  const addr = await allocateDepositAddress(
    tx,
    { merchantId: p.merchantId, livemode: p.livemode, chain: rowToChain(chain), terms: { tokenId: token.id, tokenContract: token.contractAddress, amountExpected: 0n, feeBps: m.feeBps, feeCap: UNCAPPED } },
    { custodialEnabled: deps.config.FEATURE_CUSTODIAL, forwarderEnabled: deps.config.FEATURE_FORWARDER },
  );
  await tx.update(depositAddresses).set({ watchUntil: ACCOUNT_WATCH_UNTIL }).where(eq(depositAddresses.id, addr.id));
  const [account] = await tx
    .insert(depositAccounts)
    .values({ merchantId: p.merchantId, livemode: p.livemode, customerRef: p.customerRef, chainId: chain.id, tokenId: token.id, custodyMode: addr.custodyMode, depositAddressId: addr.id })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!account) throw new Error('deposit account insert failed');
  return { account, created: true };
}

/**
 * The deposit invoice of one transfer to an account's address (watcher, in the scan transaction): created once per
 * (tx hash, log index), for exactly the transferred amount, at the fee terms of the account's custody mode.
 */
export async function depositInvoiceFor(
  deps: Deps,
  tx: Tx,
  a: DepositAccountRow & { address: string },
  t: { txHash: string; logIndex: number; amount: bigint; blockTime: Date },
): Promise<InvoiceRow> {
  const ref = `${t.txHash}:${String(t.logIndex)}`;
  const [existing] = await tx.select().from(invoices).where(and(eq(invoices.depositAccountId, a.id), eq(invoices.depositRef, ref), eq(invoices.kind, 'deposit')));
  if (existing) return existing;
  const [m] = await tx.select({ feeBps: merchants.feeBps, feeFixed: merchants.feeFixed, tolerance: merchants.underpayToleranceBps }).from(merchants).where(eq(merchants.id, a.merchantId));
  const [t0] = await tx.select({ decimals: tokens.decimals }).from(tokens).where(eq(tokens.id, a.tokenId));
  /* v8 ignore next -- foreign keys */
  if (!m || !t0) throw new Error('deposit account merchant or token missing');
  const forwarder = a.custodyMode === 'non_custodial_forwarder';
  // A forwarder's rate is fixed in its address; no fixed fee on-chain (D-097).
  const [f] = forwarder ? await tx.select({ feeBps: forwarderParams.feeBps }).from(forwarderParams).where(eq(forwarderParams.depositAddressId, a.depositAddressId)) : [];
  await tx.execute(sql`select set_config('app.transition_reason', 'deposit received', true)`);
  const [inv] = await tx
    .insert(invoices)
    .values({
      merchantId: a.merchantId,
      livemode: a.livemode,
      kind: 'deposit',
      depositAccountId: a.id,
      depositRef: ref,
      customerRef: a.customerRef,
      chainId: a.chainId,
      tokenId: a.tokenId,
      amountExpected: t.amount,
      depositAddressId: a.depositAddressId,
      depositAddress: a.address,
      custodyMode: a.custodyMode,
      underpayToleranceBps: m.tolerance,
      feeBps: f?.feeBps ?? m.feeBps,
      feeFixed: forwarder ? 0n : feeUnitsToMinor(m.feeFixed, t0.decimals),
      expiresAt: new Date(t.blockTime.getTime() + DEPOSIT_EXPIRY_MS),
    })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!inv) throw new Error('deposit invoice insert failed');
  return transitionInvoice(deps, tx, inv.id, 'pending', 'deposit to a user address');
}

/** The forwarder fee of one deposit (what its share of a flush is), for the deposit invoice's fee_amount. */
export const forwarderDepositFee = (amount: bigint, bps: number) => forwarderFeeOn(amount, bps);

export async function listDepositAccounts(tx: Tx, merchantId: string, livemode: boolean, q: { customerRef?: string; startingAfter?: string; limit: number }) {
  const rows = await tx
    .select({ a: depositAccounts, address: depositAddresses.address, decimals: tokens.decimals, symbol: tokens.symbol })
    .from(depositAccounts)
    .innerJoin(depositAddresses, eq(depositAddresses.id, depositAccounts.depositAddressId))
    .innerJoin(tokens, eq(tokens.id, depositAccounts.tokenId))
    .where(
      and(
        eq(depositAccounts.merchantId, merchantId),
        eq(depositAccounts.livemode, livemode),
        q.customerRef ? eq(depositAccounts.customerRef, q.customerRef) : undefined,
        q.startingAfter ? lt(depositAccounts.id, q.startingAfter) : undefined,
      ),
    )
    .orderBy(desc(depositAccounts.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const totals = await receivedByAccount(tx, page.map((r) => r.a.id));
  return {
    data: page.map((r) => accountView(r.a, r.address, r, totals.get(r.a.id) ?? 0n)),
    has_more: rows.length > q.limit,
    next_cursor: rows.length > q.limit ? (page.at(-1)?.a.id ?? null) : null,
  };
}

/** Confirmed deposits per account (minor units). */
async function receivedByAccount(tx: Tx, ids: string[]): Promise<Map<string, bigint>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; total: string }>(sql`
    select deposit_account_id as id, coalesce(sum(amount_received), 0)::text as total from ${invoices}
    where kind = 'deposit' and deposit_account_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) group by 1`);
  return new Map(rows.rows.map((r) => [r.id, BigInt(r.total)]));
}

export async function getDepositAccount(tx: Tx, merchantId: string, livemode: boolean, id: string) {
  const [r] = await tx
    .select({ a: depositAccounts, address: depositAddresses.address, decimals: tokens.decimals, symbol: tokens.symbol })
    .from(depositAccounts)
    .innerJoin(depositAddresses, eq(depositAddresses.id, depositAccounts.depositAddressId))
    .innerJoin(tokens, eq(tokens.id, depositAccounts.tokenId))
    .where(and(eq(depositAccounts.id, id), eq(depositAccounts.merchantId, merchantId), eq(depositAccounts.livemode, livemode)));
  if (!r) throw new AppError('not_found', 'deposit account not found');
  const deposits = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.depositAccountId, r.a.id), eq(invoices.kind, 'deposit')))
    .orderBy(desc(invoices.id))
    .limit(100);
  const totals = await receivedByAccount(tx, [r.a.id]);
  return {
    ...accountView(r.a, r.address, r, totals.get(r.a.id) ?? 0n),
    deposits: deposits.map((i) => ({
      invoice_id: i.id,
      status: i.status,
      amount: fromMinorUnits(i.amountExpected, r.decimals),
      fee: i.feeAmount === null ? null : fromMinorUnits(i.feeAmount, r.decimals),
      // tx hash:log index of the transfer
      deposit_ref: i.depositRef,
      created_at: i.createdAt.toISOString(),
    })),
  };
}

export function accountView(a: DepositAccountRow, address: string, t: { decimals: number; symbol: string }, received: bigint) {
  return {
    id: a.id,
    object: 'deposit_account' as const,
    livemode: a.livemode,
    customer_ref: a.customerRef,
    token: a.tokenId,
    symbol: t.symbol,
    chain: a.chainId,
    address,
    custody_mode: a.custodyMode,
    received: fromMinorUnits(received, t.decimals),
    retired_at: a.retiredAt?.toISOString() ?? null,
    created_at: a.createdAt.toISOString(),
  };
}
