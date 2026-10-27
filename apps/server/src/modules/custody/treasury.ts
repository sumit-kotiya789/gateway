// MONEY-CRITICAL
// Treasury (M7e, D-091): platform funds between the hot wallet and the cold multisig.
//   to_cold: admin proposes (TOTP) -> a different admin approves (TOTP) -> signer signs hot -> cold (allowlisted in
//            the signer's own config) -> worker broadcasts -> confirmed: Dr custody_cold / Cr custody_hot.
//   to_hot:  the cold multisig sent tokens to the hot wallet outside the system; an admin records the transaction ->
//            the worker books it only once the receipt shows exactly that token transfer from cold to hot, with
//            enough confirmations: Dr custody_hot / Cr custody_cold.
import { AppError, toMinorUnits } from '@gw/core';
import { decodeTokenTransfers } from '@gw/chains';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withSystem, type Tx } from '../../common/db.js';
import { chains, ledgerAccounts, ledgerEntries, ledgerJournals, platformWallets, signerSignatures, tokens, treasuryTransfers } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { resolveToken } from '../invoices/invoices.js';
import type { SweeperEnv } from './sweeper.js';

type Row = typeof treasuryTransfers.$inferSelect;

const BATCH = 20;
const LEASE_MS = 60_000;
const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const FATAL = new Set(['wrong_status', 'not_found', 'not_approved', 'cold_not_allowlisted', 'wrong_source', 'wallet_mismatch']);
const later = (deps: Deps, ms: number) => new Date(deps.clock() + ms);
const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 10));

async function wallets(tx: Tx, family: 'evm' | 'tron' | 'solana', livemode: boolean) {
  const rows = await tx
    .select()
    .from(platformWallets)
    .where(and(eq(platformWallets.family, family), eq(platformWallets.livemode, livemode), isNull(platformWallets.retiredAt), inArray(platformWallets.kind, ['hot', 'cold'])));
  const hot = rows.find((r) => r.kind === 'hot');
  const cold = rows.find((r) => r.kind === 'cold');
  if (!hot || !cold) throw new AppError('conflict', 'register an active hot and cold wallet first');
  return { hot, cold };
}

/** Proposes hot -> cold, or records a cold -> hot refill by its transaction hash. */
export async function createTreasuryTransfer(
  deps: Deps,
  tx: Tx,
  p: { livemode: boolean; tokenId: string; direction: 'to_cold' | 'to_hot'; amount: string; txHash?: string; adminId: string; reason: string },
): Promise<Row> {
  const { token, chain } = await resolveToken(tx, p.tokenId, p.livemode);
  const amount = toMinorUnits(p.amount, token.decimals);
  if (amount <= 0n) throw new AppError('invalid_amount', 'amount must be greater than zero');
  if (p.direction === 'to_hot' && !p.txHash) throw new AppError('validation_error', 'tx_hash of the refill transaction is required', { field: 'tx_hash' });
  if (p.direction === 'to_cold' && p.txHash) throw new AppError('validation_error', 'tx_hash is only for recording a refill', { field: 'tx_hash' });
  if (p.direction === 'to_cold') {
    // Never propose more than the ledger says the hot wallet holds.
    if (amount > (await custodyBalance(tx, 'custody_hot', p.livemode, token.id))) {
      throw new AppError('conflict', 'amount exceeds the hot wallet balance in the ledger', { reason: 'insufficient_balance' });
    }
  } else if (amount > (await custodyBalance(tx, 'custody_cold', p.livemode, token.id))) {
    // A refill only brings back custody funds that went to cold; anything else is not customer money.
    throw new AppError('conflict', 'amount exceeds what the ledger holds in cold storage', { reason: 'insufficient_balance' });
  }
  const w = await wallets(tx, chain.family, p.livemode);
  const [row] = await tx
    .insert(treasuryTransfers)
    .values({
      livemode: p.livemode,
      chainId: chain.id,
      tokenId: token.id,
      direction: p.direction,
      amount,
      coldAddress: w.cold.address,
      hotAddress: w.hot.address,
      status: p.direction === 'to_cold' ? 'pending_approval' : 'sent',
      requestedBy: p.adminId,
      reason: p.reason,
      txHash: p.txHash?.toLowerCase() ?? null,
      nextAttemptAt: new Date(deps.clock()),
    })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!row) throw new Error('treasury insert failed');
  return row;
}

/** A platform custody account's balance (debit) for one mode and token, in minor units. */
async function custodyBalance(tx: Tx, kind: 'custody_hot' | 'custody_cold', livemode: boolean, tokenId: string): Promise<bigint> {
  const [r] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerAccounts.kind, kind), eq(ledgerAccounts.livemode, livemode), eq(ledgerAccounts.tokenId, tokenId)));
  /* v8 ignore next -- an aggregate without GROUP BY returns exactly one row */
  if (!r) throw new Error('custody balance query returned no row');
  return BigInt(r.total);
}

async function locked(tx: Tx, id: string): Promise<Row> {
  const [r] = await tx.select().from(treasuryTransfers).where(eq(treasuryTransfers.id, id)).for('update');
  if (!r) throw new AppError('not_found', 'treasury transfer not found');
  return r;
}

export async function approveTreasuryTransfer(deps: Deps, tx: Tx, id: string, adminId: string): Promise<Row> {
  const r = await locked(tx, id);
  if (r.status !== 'pending_approval') throw new AppError('conflict', `transfer is ${r.status}`);
  if (r.requestedBy === adminId) throw new AppError('conflict', 'a different admin must approve', { reason: 'second_approver_required' });
  const [next] = await tx.update(treasuryTransfers).set({ status: 'approved', approvedBy: adminId, nextAttemptAt: new Date(deps.clock()) }).where(eq(treasuryTransfers.id, id)).returning();
  /* v8 ignore next -- row locked above */
  if (!next) throw new Error('treasury update failed');
  return next;
}

export async function rejectTreasuryTransfer(tx: Tx, id: string): Promise<Row> {
  const r = await locked(tx, id);
  if (r.status !== 'pending_approval') throw new AppError('conflict', `transfer is ${r.status}`);
  const [next] = await tx.update(treasuryTransfers).set({ status: 'rejected' }).where(eq(treasuryTransfers.id, id)).returning();
  /* v8 ignore next -- row locked above */
  if (!next) throw new Error('treasury update failed');
  return next;
}

/** Books a confirmed transfer (platform accounts only; no merchant). */
async function postTreasury(tx: Tx, t: Row): Promise<void> {
  const [j] = await tx.insert(ledgerJournals).values({ kind: 'treasury', merchantId: null, livemode: t.livemode, tokenId: t.tokenId, treasuryId: t.id }).onConflictDoNothing().returning({ id: ledgerJournals.id });
  /* v8 ignore next -- one journal per transfer; the status update in the same transaction guards a second run */
  if (!j) return;
  const [to, from] = t.direction === 'to_cold' ? (['custody_cold', 'custody_hot'] as const) : (['custody_hot', 'custody_cold'] as const);
  for (const [kind, amount] of [
    [to, t.amount],
    [from, -t.amount],
  ] as const) {
    await tx.insert(ledgerAccounts).values({ kind, merchantId: null, livemode: t.livemode, tokenId: t.tokenId }).onConflictDoNothing();
    const [a] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.kind, kind), isNull(ledgerAccounts.merchantId), eq(ledgerAccounts.livemode, t.livemode), eq(ledgerAccounts.tokenId, t.tokenId)));
    /* v8 ignore next -- inserted or already present just above */
    if (!a) throw new Error(`ledger account ${kind} missing`);
    await tx.insert(ledgerEntries).values({ journalId: j.id, accountId: a.id, merchantId: null, amount });
  }
}

async function update(deps: Deps, id: string, set: Partial<typeof treasuryTransfers.$inferInsert>) {
  await withSystem(deps.db, (tx) => tx.update(treasuryTransfers).set(set).where(eq(treasuryTransfers.id, id)));
}

async function step(deps: Deps, env: SweeperEnv, t: Row, chain: typeof chains.$inferSelect, contract: string, confirmations: number): Promise<string> {
  const ctx = env.chainTx(chain);
  if (t.status === 'approved') {
    const r = await env.signer.sign('treasury', t.id);
    if (!r.ok) {
      if (FATAL.has(r.code)) {
        deps.log.error({ treasuryId: t.id, code: r.code }, 'TREASURY TRANSFER REFUSED BY SIGNER');
        await update(deps, t.id, { status: 'failed', lastError: r.code, attempts: t.attempts + 1 });
        return 'failed';
      }
      await update(deps, t.id, { lastError: r.code, attempts: t.attempts + 1, nextAttemptAt: later(deps, backoff(t.attempts + 1)) });
      return 'approved';
    }
    await ctx.sendRaw(r.tx.raw_tx);
    await update(deps, t.id, { status: 'sent', txHash: r.tx.tx_hash, lastError: null, nextAttemptAt: later(deps, POLL_MS) });
    return 'sent';
  }
  /* v8 ignore next -- sent always carries a tx hash (guard + to_hot insert check) */
  if (!t.txHash) throw new Error('sent treasury transfer without tx_hash');
  const rc = await ctx.receipt(t.txHash);
  if (!rc) {
    if (t.direction === 'to_cold') {
      const [s] = await withSystem(deps.db, (tx) =>
        tx.select({ raw: signerSignatures.rawTx }).from(signerSignatures).where(and(eq(signerSignatures.intentKind, 'treasury'), eq(signerSignatures.intentId, t.id))),
      );
      /* v8 ignore next -- sent is only written after the signer recorded the transfer */
      if (s) await ctx.sendRaw(s.raw);
    }
    await update(deps, t.id, { nextAttemptAt: later(deps, POLL_MS) });
    return 'sent';
  }
  if (rc.status === 'reverted') {
    await update(deps, t.id, { status: 'failed', lastError: 'reverted', blockNumber: rc.blockNumber });
    return 'failed';
  }
  if (t.direction === 'to_hot') {
    // Exactly this token, from the cold address to the hot wallet, for exactly the recorded amount.
    const transfers = decodeTokenTransfers(chain.id, contract, rc.logs);
    const match = transfers.some((x) => x.from.toLowerCase() === t.coldAddress.toLowerCase() && x.to.toLowerCase() === t.hotAddress.toLowerCase() && x.amount === t.amount);
    if (!match) {
      deps.log.error({ treasuryId: t.id, txHash: t.txHash }, 'recorded refill does not match the transaction on chain');
      await update(deps, t.id, { status: 'failed', lastError: 'not_a_matching_transfer', blockNumber: rc.blockNumber });
      return 'failed';
    }
  }
  if ((await ctx.blockNumber()) - rc.blockNumber + 1n < BigInt(confirmations)) {
    await update(deps, t.id, { nextAttemptAt: later(deps, POLL_MS) });
    return 'sent';
  }
  await withSystem(deps.db, async (tx) => {
    const [done] = await tx
      .update(treasuryTransfers)
      .set({ status: 'confirmed', blockNumber: rc.blockNumber, confirmedAt: new Date(deps.clock()), lastError: null })
      .where(and(eq(treasuryTransfers.id, t.id), eq(treasuryTransfers.status, 'sent')))
      .returning();
    /* v8 ignore next -- another worker finished it first (lease expired mid-step) */
    if (!done) return;
    await postTreasury(tx, done);
  });
  return 'confirmed';
}

/** Advances due treasury transfers (SKIP LOCKED claim + lease, like sweeps). */
export async function advanceTreasury(deps: Deps, env: SweeperEnv): Promise<Record<string, number>> {
  const now = deps.clock();
  const claimed = await withSystem(deps.db, async (tx) => {
    const rows = await tx
      .select()
      .from(treasuryTransfers)
      .where(and(inArray(treasuryTransfers.status, ['approved', 'sent']), lte(treasuryTransfers.nextAttemptAt, new Date(now))))
      .orderBy(asc(treasuryTransfers.nextAttemptAt))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length > 0) await tx.update(treasuryTransfers).set({ nextAttemptAt: new Date(now + LEASE_MS) }).where(inArray(treasuryTransfers.id, rows.map((r) => r.id)));
    return rows;
  });
  const out: Record<string, number> = {};
  for (const t of claimed) {
    const meta = await withSystem(deps.db, async (tx) => {
      const [c] = await tx.select().from(chains).where(eq(chains.id, t.chainId));
      const [k] = await tx.select({ min: tokens.minConfirmations, contract: tokens.contractAddress }).from(tokens).where(eq(tokens.id, t.tokenId));
      /* v8 ignore next -- FKs guarantee both */
      return c && k ? { chain: c, contract: k.contract, confirmations: Math.max(c.defaultConfirmations, k.min) } : undefined;
    });
    /* v8 ignore next -- FKs guarantee both */
    if (!meta) continue;
    try {
      const end = await step(deps, env, t, meta.chain, meta.contract, meta.confirmations);
      out[end] = (out[end] ?? 0) + 1;
    } catch (err) {
      deps.log.warn({ treasuryId: t.id, err: (err as Error).message }, 'treasury step failed; retrying');
      out.error = (out.error ?? 0) + 1;
    }
  }
  return out;
}

export function treasuryView(t: Row, decimals: number, fmt: (v: bigint, d: number) => string) {
  return {
    id: t.id,
    livemode: t.livemode,
    token: t.tokenId,
    direction: t.direction,
    amount: fmt(t.amount, decimals),
    cold_address: t.coldAddress,
    hot_address: t.hotAddress,
    status: t.status,
    requested_by: t.requestedBy,
    approved_by: t.approvedBy,
    reason: t.reason,
    tx_hash: t.txHash,
    last_error: t.lastError,
    created_at: t.createdAt.toISOString(),
    confirmed_at: t.confirmedAt?.toISOString() ?? null,
  };
}
