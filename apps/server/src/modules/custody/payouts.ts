// MONEY-CRITICAL
// Sending approved withdrawals (M7d, D-090), in the custody worker next to sweeps:
//   approved -> ask the signer (it re-checks approvals, address, hold, flags, limits, hot balance), broadcast -> sent
//   sent     -> once mined with enough confirmations: the hold leaves custody                            -> confirmed
// Unmined transactions are rebroadcast with the same signed bytes. A mined revert, or a signer refusal that means
// the request itself is wrong, fails the withdrawal and releases the hold. Refusals of the moment (paused, limits,
// hot wallet short) wait with backoff: an admin can see them in the console.
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { withSystem } from '../../common/db.js';
import { chains, signerSignatures, tokens, withdrawals } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { completeWithdrawal, releaseWithdrawal } from '../ledger/ledger.js';
import { noticeDone } from '../withdrawals/withdrawals.js';
import type { SweepScope, SweeperEnv } from './sweeper.js';

type WithdrawalRow = typeof withdrawals.$inferSelect;

const BATCH = 20;
const LEASE_MS = 60_000;
const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Refusals that mean this withdrawal must not be sent at all. */
const FATAL = new Set(['not_approved', 'payouts_frozen', 'merchant_inactive', 'payout_address_changed', 'hold_mismatch', 'wrong_status', 'not_found', 'wallet_mismatch']);

const later = (deps: Deps, ms: number) => new Date(deps.clock() + ms);
const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 10));

async function fail(deps: Deps, w: WithdrawalRow, code: string, extra: Partial<WithdrawalRow> = {}): Promise<void> {
  await withSystem(deps.db, async (tx) => {
    const [next] = await tx
      .update(withdrawals)
      .set({ status: 'failed', lastError: code, attempts: w.attempts + 1, ...extra })
      .where(and(eq(withdrawals.id, w.id), inArray(withdrawals.status, ['approved', 'sent'])))
      .returning();
    /* v8 ignore next -- another worker finished it first (lease expired mid-step) */
    if (!next) return;
    await releaseWithdrawal(tx, next);
    await noticeDone(deps, tx, next, code);
  });
}

async function step(deps: Deps, env: SweeperEnv, w: WithdrawalRow, chain: typeof chains.$inferSelect, confirmations: number): Promise<string> {
  const ctx = env.chainTx(chain);
  if (w.status === 'approved') {
    const r = await env.signer.sign('withdrawal', w.id);
    if (!r.ok) {
      if (FATAL.has(r.code)) {
        deps.log.error({ withdrawalId: w.id, code: r.code }, 'withdrawal refused by the signer; released');
        await fail(deps, w, r.code);
        return 'failed';
      }
      deps.log.warn({ withdrawalId: w.id, code: r.code }, 'withdrawal waiting');
      await withSystem(deps.db, (tx) =>
        tx.update(withdrawals).set({ attempts: w.attempts + 1, lastError: r.code, nextAttemptAt: later(deps, backoff(w.attempts + 1)) }).where(eq(withdrawals.id, w.id)),
      );
      return 'approved';
    }
    await ctx.sendRaw(r.tx.raw_tx);
    await withSystem(deps.db, (tx) =>
      tx.update(withdrawals).set({ status: 'sent', txHash: r.tx.tx_hash, lastError: null, nextAttemptAt: later(deps, POLL_MS) }).where(eq(withdrawals.id, w.id)),
    );
    return 'sent';
  }

  /* v8 ignore next -- sent is only ever written together with tx_hash */
  if (!w.txHash) throw new Error('sent withdrawal without tx_hash');
  const rc = await ctx.receipt(w.txHash);
  if (!rc) {
    const [s] = await withSystem(deps.db, (tx) =>
      tx.select({ raw: signerSignatures.rawTx }).from(signerSignatures).where(and(eq(signerSignatures.intentKind, 'withdrawal'), eq(signerSignatures.intentId, w.id))),
    );
    /* v8 ignore next -- sent is only written after the signer recorded the withdrawal */
    if (s) await ctx.sendRaw(s.raw);
    await withSystem(deps.db, (tx) => tx.update(withdrawals).set({ nextAttemptAt: later(deps, POLL_MS) }).where(eq(withdrawals.id, w.id)));
    return 'sent';
  }
  if (rc.status === 'reverted') {
    deps.log.error({ withdrawalId: w.id, txHash: w.txHash }, 'withdrawal transaction reverted; released');
    await fail(deps, w, 'reverted', { blockNumber: rc.blockNumber });
    return 'failed';
  }
  if ((await ctx.blockNumber()) - rc.blockNumber + 1n < BigInt(confirmations)) {
    await withSystem(deps.db, (tx) => tx.update(withdrawals).set({ nextAttemptAt: later(deps, POLL_MS) }).where(eq(withdrawals.id, w.id)));
    return 'sent';
  }
  await withSystem(deps.db, async (tx) => {
    const [done] = await tx
      .update(withdrawals)
      .set({ status: 'confirmed', blockNumber: rc.blockNumber, confirmedAt: new Date(deps.clock()), lastError: null })
      .where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, 'sent')))
      .returning();
    /* v8 ignore next -- another worker finished it first (lease expired mid-step) */
    if (!done) return;
    await completeWithdrawal(tx, done);
    await noticeDone(deps, tx, done, null);
  });
  return 'confirmed';
}

/** Advances due withdrawals (safe on several workers: SKIP LOCKED claim + lease). */
export async function advanceWithdrawals(deps: Deps, env: SweeperEnv, scope: SweepScope = {}): Promise<Record<string, number>> {
  const now = deps.clock();
  const claimed = await withSystem(deps.db, async (tx) => {
    const rows = await tx
      .select()
      .from(withdrawals)
      .where(
        and(
          inArray(withdrawals.status, ['approved', 'sent']),
          lte(withdrawals.nextAttemptAt, new Date(now)),
          scope.merchantId ? eq(withdrawals.merchantId, scope.merchantId) : undefined,
        ),
      )
      .orderBy(asc(withdrawals.nextAttemptAt))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length > 0) await tx.update(withdrawals).set({ nextAttemptAt: new Date(now + LEASE_MS) }).where(inArray(withdrawals.id, rows.map((r) => r.id)));
    return rows;
  });
  const out: Record<string, number> = {};
  for (const w of claimed) {
    const meta = await withSystem(deps.db, async (tx) => {
      const [c] = await tx.select().from(chains).where(eq(chains.id, w.chainId));
      const [t] = await tx.select({ min: tokens.minConfirmations }).from(tokens).where(eq(tokens.id, w.tokenId));
      /* v8 ignore next -- FKs guarantee both */
      return c && t ? { chain: c, confirmations: Math.max(c.defaultConfirmations, t.min) } : undefined;
    });
    /* v8 ignore next -- FKs guarantee both */
    if (!meta) continue;
    try {
      const end = await step(deps, env, w, meta.chain, meta.confirmations);
      out[end] = (out[end] ?? 0) + 1;
    } catch (err) {
      deps.log.warn({ withdrawalId: w.id, err: (err as Error).message }, 'withdrawal step failed; retrying');
      out.error = (out.error ?? 0) + 1;
    }
  }
  return out;
}
