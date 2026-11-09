// MONEY-CRITICAL
// Hot wallet policy (D-105), per mode and token, set by an admin:
//   max_balance: above it, one automatic hot -> cold transfer for the excess. The hot wallet's balance is the smaller
//                of the ledger's and the chain's count; one to_cold transfer in flight at a time; none for 30 minutes
//                after an automatic one failed. Treasury carries it on; the signer signs it only with
//                SIGNER_AUTO_TO_COLD and only to its allowlisted cold address; the DB guard caps it at the excess.
//   low_balance: below it (on chain), an email to every active admin who can manage treasury, again every 24 hours
//                while it stays low; re-armed once the balance is back at or above the mark.
import { ADMIN_PERMISSIONS, AppError, fromMinorUnits, toMinorUnits } from '@gw/core';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { audit } from '../../common/audit.js';
import { withSystem, type Tx } from '../../common/db.js';
import { adminUsers, chains, hotWalletPolicies, platformWallets, tokens, treasuryTransfers } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { enqueueEmail } from '../email/outbox.js';
import { templates } from '../email/templates.js';
import { resolveToken } from '../invoices/invoices.js';
import type { SweeperEnv } from './sweeper.js';
import { custodyBalance } from './treasury.js';

const ALERT_EVERY_MS = 24 * 3600_000;
const FAILED_BACKOFF_MS = 30 * 60_000;

type Policy = typeof hotWalletPolicies.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;
type ChainRow = typeof chains.$inferSelect;

export function policyView(p: Policy, t: { decimals: number; symbol: string }, hotAddress: string | null) {
  const fmt = (v: bigint | null) => (v === null ? null : fromMinorUnits(v, t.decimals));
  const b = p.lastBalance;
  // Where the last checked balance stands (exact, in minor units): for the admin console's badges.
  const state = b === null ? null : p.lowBalance !== null && b < p.lowBalance ? 'low' : p.maxBalance !== null && b > p.maxBalance ? 'above_cap' : 'ok';
  return {
    state,
    livemode: p.livemode,
    token: p.tokenId,
    symbol: t.symbol,
    max_balance: fmt(p.maxBalance),
    low_balance: fmt(p.lowBalance),
    hot_address: hotAddress,
    last_balance: fmt(p.lastBalance),
    last_checked_at: p.lastCheckedAt?.toISOString() ?? null,
    low_alert_at: p.lowAlertAt?.toISOString() ?? null,
    updated_by: p.updatedBy,
    updated_at: p.updatedAt.toISOString(),
  };
}

/** Sets (or switches off, with null) the cap and the low mark of one mode and token. Returns the old and new rows. */
export async function setHotWalletPolicy(
  deps: Deps,
  tx: Tx,
  p: { livemode: boolean; tokenId: string; maxBalance: string | null; lowBalance: string | null; adminId: string },
): Promise<{ before: Policy | undefined; after: Policy; token: TokenRow }> {
  const { token } = await resolveToken(tx, p.tokenId, p.livemode);
  const max = p.maxBalance === null ? null : toMinorUnits(p.maxBalance, token.decimals);
  const low = p.lowBalance === null ? null : toMinorUnits(p.lowBalance, token.decimals);
  if (max !== null && max <= 0n) throw new AppError('validation_error', 'max_balance must be greater than zero', { field: 'max_balance' });
  if (low !== null && low < 0n) throw new AppError('validation_error', 'low_balance cannot be negative', { field: 'low_balance' });
  if (max !== null && low !== null && low >= max) throw new AppError('validation_error', 'low_balance must be below max_balance', { field: 'low_balance' });
  const [before] = await tx
    .select()
    .from(hotWalletPolicies)
    .where(and(eq(hotWalletPolicies.livemode, p.livemode), eq(hotWalletPolicies.tokenId, token.id)))
    .for('update');
  const now = new Date(deps.clock());
  const [after] = await tx
    .insert(hotWalletPolicies)
    .values({ livemode: p.livemode, tokenId: token.id, maxBalance: max, lowBalance: low, updatedBy: p.adminId, updatedAt: now })
    .onConflictDoUpdate({
      target: [hotWalletPolicies.livemode, hotWalletPolicies.tokenId],
      // A new low mark is judged afresh: the next check emails again if the balance is below it.
      set: { maxBalance: max, lowBalance: low, updatedBy: p.adminId, updatedAt: now, lowAlertAt: null },
    })
    .returning();
  /* v8 ignore next -- INSERT ... ON CONFLICT DO UPDATE ... RETURNING yields the row or throws */
  if (!after) throw new Error('hot wallet policy upsert failed');
  return { before, after, token };
}

async function activeWallet(tx: Tx, kind: 'hot' | 'cold', family: ChainRow['family'], livemode: boolean) {
  const [w] = await tx
    .select()
    .from(platformWallets)
    .where(and(eq(platformWallets.kind, kind), eq(platformWallets.family, family), eq(platformWallets.livemode, livemode), isNull(platformWallets.retiredAt)));
  return w;
}

/** Worker (custody job): checks every policy once. An RPC failure skips that policy until the next run. */
export async function runHotWalletPolicies(deps: Deps, env: SweeperEnv): Promise<Record<string, number>> {
  const rows = await withSystem(deps.db, (tx) =>
    tx
      .select({ p: hotWalletPolicies, token: tokens, chain: chains })
      .from(hotWalletPolicies)
      .innerJoin(tokens, eq(tokens.id, hotWalletPolicies.tokenId))
      .innerJoin(chains, eq(chains.id, tokens.chainId))
      .where(and(eq(tokens.enabled, true), eq(chains.enabled, true))),
  );
  const out = { checked: 0, to_cold: 0, low_alerts: 0 };
  for (const { p, token, chain } of rows) {
    if (p.maxBalance === null && p.lowBalance === null) continue;
    try {
      const r = await checkPolicy(deps, env, p, token, chain);
      if (!r) continue;
      out.checked++;
      if (r.toCold) out.to_cold++;
      if (r.alerted) out.low_alerts++;
    } catch (err) {
      deps.log.warn({ token: token.id, livemode: p.livemode, err: (err as Error).message }, 'hot wallet policy check failed; retrying next run');
    }
  }
  return out;
}

async function checkPolicy(deps: Deps, env: SweeperEnv, p: Policy, token: TokenRow, chain: ChainRow): Promise<{ toCold: boolean; alerted: boolean } | undefined> {
  const hot = await withSystem(deps.db, (tx) => activeWallet(tx, 'hot', chain.family, p.livemode));
  /* v8 ignore next -- operator setup (platform:register); removing the shared test wallets would disturb parallel test files */
  if (!hot) return undefined;
  // Read the chain outside the transaction: no row lock is held across an RPC call.
  const onChain = await env.chainTx(chain).tokenBalance(token.contractAddress, hot.address);
  return withSystem(deps.db, async (tx) => {
    const [cur] = await tx.select().from(hotWalletPolicies).where(eq(hotWalletPolicies.id, p.id)).for('update');
    /* v8 ignore next -- policies are never deleted (no DELETE grant) */
    if (!cur) return undefined;
    const now = deps.clock();
    let alerted = false;
    let lowAlertAt = cur.lowAlertAt;
    if (cur.lowBalance !== null && onChain < cur.lowBalance) {
      if (!lowAlertAt || now - lowAlertAt.getTime() >= ALERT_EVERY_MS) {
        await alertAdmins(deps, tx, { livemode: cur.livemode, token, balance: onChain, threshold: cur.lowBalance, address: hot.address });
        lowAlertAt = new Date(now);
        alerted = true;
      }
    } else if (lowAlertAt) {
      lowAlertAt = null; // back above the mark: the next drop alerts again
    }
    const toCold = cur.maxBalance !== null && (await moveExcess(deps, tx, cur, cur.maxBalance, token, chain, hot.address, onChain));
    await tx.update(hotWalletPolicies).set({ lastBalance: onChain, lastCheckedAt: new Date(now), lowAlertAt }).where(eq(hotWalletPolicies.id, cur.id));
    return { toCold, alerted };
  });
}

async function moveExcess(deps: Deps, tx: Tx, p: Policy, max: bigint, token: TokenRow, chain: ChainRow, hotAddress: string, onChain: bigint): Promise<boolean> {
  const cold = await activeWallet(tx, 'cold', chain.family, p.livemode);
  /* v8 ignore next -- operator setup (platform:register), as above */
  if (!cold) return false;
  // Never more than both the ledger and the chain say the hot wallet holds.
  const ledger = await custodyBalance(tx, 'custody_hot', p.livemode, token.id);
  const held = onChain < ledger ? onChain : ledger;
  const excess = held - max;
  if (excess <= 0n || excess < token.minAmount) return false;
  const busy = await tx
    .select({ id: treasuryTransfers.id })
    .from(treasuryTransfers)
    .where(and(eq(treasuryTransfers.livemode, p.livemode), eq(treasuryTransfers.tokenId, token.id), eq(treasuryTransfers.direction, 'to_cold'), inArray(treasuryTransfers.status, ['approved', 'sent'])))
    .limit(1);
  if (busy.length > 0) return false;
  const failed = await tx
    .select({ id: treasuryTransfers.id })
    .from(treasuryTransfers)
    .where(
      and(
        eq(treasuryTransfers.livemode, p.livemode),
        eq(treasuryTransfers.tokenId, token.id),
        eq(treasuryTransfers.auto, true),
        eq(treasuryTransfers.status, 'failed'),
        gt(treasuryTransfers.createdAt, new Date(deps.clock() - FAILED_BACKOFF_MS)),
      ),
    )
    .limit(1);
  if (failed.length > 0) return false;
  const reason = `automatic: hot wallet above its cap of ${fromMinorUnits(max, token.decimals)} ${token.symbol}`;
  const [t] = await tx
    .insert(treasuryTransfers)
    .values({
      livemode: p.livemode,
      chainId: chain.id,
      tokenId: token.id,
      direction: 'to_cold',
      amount: excess,
      coldAddress: cold.address,
      hotAddress,
      status: 'approved',
      auto: true,
      requestedBy: p.updatedBy,
      reason,
      nextAttemptAt: new Date(deps.clock()),
      // App clock, like the 30-minute pause after a failure that reads it.
      createdAt: new Date(deps.clock()),
    })
    .returning();
  /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
  if (!t) throw new Error('treasury insert failed');
  await audit(tx, {
    actorType: 'system',
    action: 'custody.treasury_to_cold_auto',
    targetType: 'treasury_transfer',
    targetId: t.id,
    after: { amount: fromMinorUnits(excess, token.decimals), token: token.id, livemode: p.livemode, cap: fromMinorUnits(max, token.decimals) },
  });
  deps.log.info({ treasuryId: t.id, token: token.id, livemode: p.livemode }, 'hot wallet above its cap: automatic transfer to cold storage');
  return true;
}

async function alertAdmins(deps: Deps, tx: Tx, a: { livemode: boolean; token: TokenRow; balance: bigint; threshold: bigint; address: string }): Promise<void> {
  const to = await tx
    .select({ email: adminUsers.email })
    .from(adminUsers)
    .where(and(isNull(adminUsers.disabledAt), inArray(adminUsers.role, [...ADMIN_PERMISSIONS['treasury:manage']])));
  const msg = templates.hotWalletLow({
    livemode: a.livemode,
    token: a.token.id,
    symbol: a.token.symbol,
    balance: fromMinorUnits(a.balance, a.token.decimals),
    threshold: fromMinorUnits(a.threshold, a.token.decimals),
    address: a.address,
  });
  for (const r of to) await enqueueEmail(deps, tx, { merchantId: null, kind: 'hot_wallet_low', to: r.email, ...msg });
  deps.log.warn({ token: a.token.id, livemode: a.livemode, admins: to.length }, 'hot wallet balance below its alert level: admins emailed');
}
