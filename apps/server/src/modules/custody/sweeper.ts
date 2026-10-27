// MONEY-CRITICAL
// Sweeps (M7c, D-089): move each custodial deposit address's confirmed funds into the hot wallet.
//   pending    -> ask the signer for a gas top-up (gas wallet -> deposit address), broadcast   -> gas_sent
//                 (or, when the address already holds enough gas, go straight to the sweep)
//   gas_sent   -> once the top-up is mined, ask for the sweep (deposit -> hot wallet), broadcast -> sweep_sent
//   sweep_sent -> once mined with enough confirmations: book it and settle the invoice           -> confirmed
// A transaction that is not mined yet is rebroadcast with the SAME signed bytes (from signer_signatures), never
// re-signed. Only a mined-and-reverted transaction fails a sweep; the next planning round then creates a new one.
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { withSystem } from '../../common/db.js';
import { chains, platformWallets, signerSignatures, sweeps, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { postSweep, settleIfSwept } from '../ledger/ledger.js';
import type { ChainTx } from './chain-tx.js';
import type { IntentKind, SignerClient } from './signer-client.js';

type SweepRow = typeof sweeps.$inferSelect;
type ChainRow = typeof chains.$inferSelect;

export interface SweeperEnv {
  signer: SignerClient;
  chainTx: (chain: ChainRow) => ChainTx;
}

const BATCH = 20;
/** A claimed sweep is retried after this long if its worker died mid-step. */
const LEASE_MS = 60_000;
/** Poll interval while waiting for a transaction to be mined or confirmed. */
const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Signer refusals that mean something is wrong with the data, not the moment: stop and alert, never retry. */
const FATAL = new Set(['over_booked', 'not_our_address', 'wrong_destination', 'wallet_mismatch', 'wrong_status', 'not_found']);

/** Limits a run to one merchant (tests, manual runs). */
export interface SweepScope {
  merchantId?: string;
}

/** Creates a sweep for every custodial deposit address holding confirmed, unswept funds. Returns how many. */
export async function planSweeps(deps: Deps, scope: SweepScope = {}): Promise<number> {
  return withSystem(deps.db, async (tx) => {
    const due = await tx.execute<{
      deposit_address_id: string;
      invoice_id: string;
      merchant_id: string;
      livemode: boolean;
      chain_id: string;
      token_id: string;
      address: string;
      family: 'evm' | 'tron' | 'solana';
      unswept: string;
    }>(sql`
      select d.id as deposit_address_id, i.id as invoice_id, i.merchant_id, i.livemode, i.chain_id, i.token_id, d.address, d.family,
             (sum(p.amount) - coalesce((select sum(s.amount) from sweeps s where s.deposit_address_id = d.id and s.status = 'confirmed'), 0))::text as unswept
      from invoices i
      join deposit_addresses d on d.id = i.deposit_address_id
      join payments p on p.invoice_id = i.id and p.status = 'confirmed'
      where i.custody_mode = 'custodial' ${scope.merchantId ? sql`and i.merchant_id = ${scope.merchantId}` : sql``}
        and not exists (select 1 from sweeps s where s.deposit_address_id = d.id and s.status in ('pending', 'gas_sent', 'sweep_sent'))
      group by d.id, i.id
      having sum(p.amount) > coalesce((select sum(s.amount) from sweeps s where s.deposit_address_id = d.id and s.status = 'confirmed'), 0)
      limit 100`);
    let created = 0;
    for (const r of due.rows) {
      const [hot] = await tx
        .select({ address: platformWallets.address })
        .from(platformWallets)
        .where(and(eq(platformWallets.kind, 'hot'), eq(platformWallets.family, r.family), eq(platformWallets.livemode, r.livemode), sql`${platformWallets.retiredAt} is null`));
      if (!hot) {
        deps.log.warn({ family: r.family, livemode: r.livemode }, 'no active hot wallet: custodial funds are not being swept');
        continue;
      }
      const rows = await tx
        .insert(sweeps)
        .values({
          merchantId: r.merchant_id,
          livemode: r.livemode,
          chainId: r.chain_id,
          tokenId: r.token_id,
          depositAddressId: r.deposit_address_id,
          invoiceId: r.invoice_id,
          fromAddress: r.address,
          toAddress: hot.address,
          amount: BigInt(r.unswept),
          nextAttemptAt: new Date(deps.clock()),
        })
        .onConflictDoNothing()
        .returning({ id: sweeps.id });
      created += rows.length;
    }
    return created;
  });
}

async function update(deps: Deps, id: string, set: Partial<typeof sweeps.$inferInsert>): Promise<void> {
  await withSystem(deps.db, (tx) => tx.update(sweeps).set(set).where(eq(sweeps.id, id)));
}

const later = (deps: Deps, ms: number) => new Date(deps.clock() + ms);
const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 10));

/** The bytes the signer already signed for this intent (to rebroadcast). */
async function signedRaw(deps: Deps, kind: IntentKind, id: string): Promise<string | undefined> {
  const [r] = await withSystem(deps.db, (tx) =>
    tx.select({ raw: signerSignatures.rawTx }).from(signerSignatures).where(and(eq(signerSignatures.intentKind, kind), eq(signerSignatures.intentId, id))),
  );
  return r?.raw;
}

/** One step for one sweep. Returns the status it ends in. */
async function step(deps: Deps, env: SweeperEnv, s: SweepRow, chain: ChainRow, confirmations: number): Promise<string> {
  const ctx = env.chainTx(chain);

  const refused = async (code: string, message: string, stage: string) => {
    const attempts = s.attempts + 1;
    if (FATAL.has(code)) {
      deps.log.error({ sweepId: s.id, code, stage }, 'SWEEP REFUSED BY SIGNER: data inconsistency, investigate');
      await update(deps, s.id, { status: 'failed', attempts, lastError: code });
      return 'failed';
    }
    deps.log.warn({ sweepId: s.id, code, message, stage }, 'sweep step refused; retrying later');
    await update(deps, s.id, { attempts, lastError: code, nextAttemptAt: later(deps, backoff(attempts)) });
    return s.status;
  };

  const sendSweep = async (): Promise<string> => {
    const r = await env.signer.sign('sweep', s.id);
    if (!r.ok) return refused(r.code, r.message, 'sweep');
    await ctx.sendRaw(r.tx.raw_tx);
    await update(deps, s.id, { status: 'sweep_sent', txHash: r.tx.tx_hash, lastError: null, nextAttemptAt: later(deps, POLL_MS) });
    return 'sweep_sent';
  };

  if (s.status === 'pending') {
    const r = await env.signer.sign('gas_topup', s.id);
    if (!r.ok && r.code === 'not_needed') return sendSweep();
    if (!r.ok) return refused(r.code, r.message, 'gas_topup');
    await ctx.sendRaw(r.tx.raw_tx);
    await update(deps, s.id, { status: 'gas_sent', gasTxHash: r.tx.tx_hash, lastError: null, nextAttemptAt: later(deps, POLL_MS) });
    return 'gas_sent';
  }

  if (s.status === 'gas_sent') {
    /* v8 ignore next -- gas_sent is only ever written together with gas_tx_hash */
    if (!s.gasTxHash) throw new Error('gas_sent sweep without gas_tx_hash');
    const rc = await ctx.receipt(s.gasTxHash);
    if (!rc) {
      const raw = await signedRaw(deps, 'gas_topup', s.id);
      if (raw) await ctx.sendRaw(raw);
      await update(deps, s.id, { nextAttemptAt: later(deps, POLL_MS) });
      return 'gas_sent';
    }
    if (rc.status === 'reverted') {
      await update(deps, s.id, { status: 'failed', lastError: 'gas_topup_reverted' });
      return 'failed';
    }
    return sendSweep();
  }

  // sweep_sent
  /* v8 ignore next -- sweep_sent is only ever written together with tx_hash */
  if (!s.txHash) throw new Error('sweep_sent sweep without tx_hash');
  const rc = await ctx.receipt(s.txHash);
  if (!rc) {
    const raw = await signedRaw(deps, 'sweep', s.id);
    if (raw) await ctx.sendRaw(raw);
    await update(deps, s.id, { nextAttemptAt: later(deps, POLL_MS) });
    return 'sweep_sent';
  }
  if (rc.status === 'reverted') {
    deps.log.error({ sweepId: s.id, txHash: s.txHash }, 'sweep transaction reverted');
    await update(deps, s.id, { status: 'failed', lastError: 'sweep_reverted', blockNumber: rc.blockNumber });
    return 'failed';
  }
  const head = await ctx.blockNumber();
  if (head - rc.blockNumber + 1n < BigInt(confirmations)) {
    await update(deps, s.id, { nextAttemptAt: later(deps, POLL_MS) });
    return 'sweep_sent';
  }
  // Book and settle in one transaction: the ledger and the sweep's status never disagree.
  await withSystem(deps.db, async (tx) => {
    const [done] = await tx
      .update(sweeps)
      .set({ status: 'confirmed', blockNumber: rc.blockNumber, confirmedAt: new Date(deps.clock()), lastError: null })
      .where(and(eq(sweeps.id, s.id), eq(sweeps.status, 'sweep_sent')))
      .returning();
    if (!done) return; // another worker got there first
    await postSweep(tx, done);
    await settleIfSwept(deps, tx, done.invoiceId);
  });
  return 'confirmed';
}

/** Advances due sweeps (safe on several workers: SKIP LOCKED claim + lease). */
export async function advanceSweeps(deps: Deps, env: SweeperEnv, scope: SweepScope = {}): Promise<Record<string, number>> {
  const now = deps.clock();
  const claimed = await withSystem(deps.db, async (tx) => {
    const rows = await tx
      .select()
      .from(sweeps)
      .where(
        and(
          inArray(sweeps.status, ['pending', 'gas_sent', 'sweep_sent']),
          lte(sweeps.nextAttemptAt, new Date(now)),
          scope.merchantId ? eq(sweeps.merchantId, scope.merchantId) : undefined,
        ),
      )
      .orderBy(asc(sweeps.nextAttemptAt))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length > 0) await tx.update(sweeps).set({ nextAttemptAt: new Date(now + LEASE_MS) }).where(inArray(sweeps.id, rows.map((r) => r.id)));
    return rows;
  });
  const out: Record<string, number> = {};
  for (const s of claimed) {
    const meta = await withSystem(deps.db, async (tx) => {
      const [c] = await tx.select().from(chains).where(eq(chains.id, s.chainId));
      const [t] = await tx.select({ min: tokens.minConfirmations }).from(tokens).where(eq(tokens.id, s.tokenId));
      return c && t ? { chain: c, confirmations: Math.max(c.defaultConfirmations, t.min) } : undefined;
    });
    /* v8 ignore next -- FKs guarantee both */
    if (!meta) continue;
    try {
      const end = await step(deps, env, s, meta.chain, meta.confirmations);
      out[end] = (out[end] ?? 0) + 1;
    } catch (err) {
      // RPC or signer unreachable: keep the state, retry after the lease.
      deps.log.warn({ sweepId: s.id, err: (err as Error).message }, 'sweep step failed; retrying');
      out.error = (out.error ?? 0) + 1;
    }
  }
  return out;
}
