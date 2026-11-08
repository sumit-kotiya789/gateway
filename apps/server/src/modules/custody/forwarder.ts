// MONEY-CRITICAL
// Forwards (D-097): move each forwarder deposit address's confirmed funds on to the merchant (fee split on-chain).
//   plan       a forwarder invoice whose confirmed payments exceed what confirmed forwards moved, and whose address
//              holds a token balance on-chain -> one pending forward (amount = that balance)
//   pending -> ask the signer for the flush (gas wallet calls ForwarderFactory.deployAndFlush), broadcast -> sent
//   sent    -> once mined with enough confirmations: read what moved from the Flushed event, book the fee, settle the
//              invoice when everything it received has been forwarded                                         -> confirmed
// A transaction that is not mined yet is rebroadcast with the SAME signed bytes (signer_signatures), never re-signed.
// A reverted one fails the forward; the next planning round creates a new one. The destinations are fixed by the
// contract address, so the worst a bug here can do is spend gas or delay a forward, never redirect funds.
import { decodeFlushed } from '@gw/chains';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { withSystem } from '../../common/db.js';
import { chains, forwarderParams, forwards, signerSignatures, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { postForward, settleIfForwarded } from '../ledger/ledger.js';
import type { ChainTx } from './chain-tx.js';
import type { IntentKind, SignerClient } from './signer-client.js';

type ForwardRow = typeof forwards.$inferSelect;
type ChainRow = typeof chains.$inferSelect;

export interface ForwarderEnv {
  signer: SignerClient;
  chainTx: (chain: ChainRow) => ChainTx;
}

/** Limits a run to one merchant (tests, manual runs). */
export interface ForwardScope {
  merchantId?: string;
}

const BATCH = 20;
const PLAN_LIMIT = 100;
/** A claimed forward is retried after this long if its worker died mid-step. */
const LEASE_MS = 60_000;
/** Poll interval while waiting for a transaction to be mined or confirmed. */
const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Signer refusals that mean the data is wrong, not the moment: fail the forward and alert, never retry it. */
const FATAL = new Set(['not_found', 'wrong_status', 'params_mismatch', 'factory_mismatch', 'not_our_address', 'wrong_destination']);

const later = (deps: Deps, ms: number) => new Date(deps.clock() + ms);
const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 10));

/** Creates a forward for every forwarder deposit address that holds confirmed, unforwarded funds. Returns how many. */
export async function planForwards(deps: Deps, env: ForwarderEnv, scope: ForwardScope = {}): Promise<number> {
  const due = await withSystem(deps.db, (tx) =>
    tx.execute<{
      deposit_address_id: string;
      invoice_id: string;
      merchant_id: string;
      livemode: boolean;
      chain_id: string;
      token_id: string;
      address: string;
      token_contract: string;
    }>(sql`
      select f.deposit_address_id, (array_agg(i.id order by i.created_at desc, i.id desc))[1] as invoice_id,
             i.merchant_id, i.livemode, i.chain_id, i.token_id, d.address, f.token_contract
      from invoices i
      join deposit_addresses d on d.id = i.deposit_address_id
      join forwarder_params f on f.deposit_address_id = d.id
      where i.custody_mode = 'non_custodial_forwarder' ${scope.merchantId ? sql`and i.merchant_id = ${scope.merchantId}` : sql``}
        and not exists (select 1 from forwards w where w.deposit_address_id = d.id and w.status in ('pending', 'sent'))
      -- Per address: a user's permanent forwarder (D-101) collects several deposit invoices; one flush moves them all
      -- (booked to the latest one; settlement allocates oldest first, settleIfForwarded).
      group by f.deposit_address_id, i.merchant_id, i.livemode, i.chain_id, i.token_id, d.address, f.token_contract
      having (select coalesce(sum(p.amount), 0) from payments p join invoices x on x.id = p.invoice_id
              where x.deposit_address_id = f.deposit_address_id and p.status = 'confirmed')
          > (select coalesce(sum(w.to_merchant + w.fee), 0) from forwards w where w.deposit_address_id = f.deposit_address_id and w.status = 'confirmed')
      order by min(i.created_at)
      limit ${PLAN_LIMIT}`),
  );
  if (due.rows.length === 0) return 0;
  const chainRows = await withSystem(deps.db, (tx) => tx.select().from(chains).where(inArray(chains.id, [...new Set(due.rows.map((r) => r.chain_id))])));
  const byId = new Map(chainRows.map((c) => [c.id, c]));
  let created = 0;
  for (const r of due.rows) {
    const chain = byId.get(r.chain_id);
    /* v8 ignore next -- FK guarantees the chain */
    if (!chain) continue;
    let balance: bigint;
    try {
      balance = await env.chainTx(chain).tokenBalance(r.token_contract, r.address);
    } catch (err) {
      deps.log.warn({ depositAddressId: r.deposit_address_id, err: (err as Error).message }, 'forward planning: balance read failed; retrying next run');
      continue;
    }
    if (balance === 0n) {
      // Confirmed payments, nothing on the address: someone called flush directly (allowed: anyone may). Not booked here.
      deps.log.warn({ depositAddressId: r.deposit_address_id, invoiceId: r.invoice_id }, 'forwarder address already empty: flushed outside the gateway');
      continue;
    }
    const rows = await withSystem(deps.db, (tx) =>
      tx
        .insert(forwards)
        .values({
          merchantId: r.merchant_id,
          livemode: r.livemode,
          chainId: r.chain_id,
          tokenId: r.token_id,
          depositAddressId: r.deposit_address_id,
          invoiceId: r.invoice_id,
          forwarderAddress: r.address,
          amount: balance,
          nextAttemptAt: new Date(deps.clock()),
        })
        .onConflictDoNothing()
        .returning({ id: forwards.id }),
    );
    created += rows.length;
  }
  return created;
}

async function update(deps: Deps, id: string, set: Partial<typeof forwards.$inferInsert>): Promise<void> {
  await withSystem(deps.db, (tx) => tx.update(forwards).set(set).where(eq(forwards.id, id)));
}

/** The bytes the signer already signed for this intent (to rebroadcast). */
async function signedRaw(deps: Deps, kind: IntentKind, id: string): Promise<string | undefined> {
  const [r] = await withSystem(deps.db, (tx) =>
    tx.select({ raw: signerSignatures.rawTx }).from(signerSignatures).where(and(eq(signerSignatures.intentKind, kind), eq(signerSignatures.intentId, id))),
  );
  return r?.raw;
}

/** One step for one forward. Returns the status it ends in. */
async function step(deps: Deps, env: ForwarderEnv, f: ForwardRow, chain: ChainRow, tokenContract: string, confirmations: number): Promise<string> {
  const ctx = env.chainTx(chain);

  if (f.status === 'pending') {
    const r = await env.signer.sign('forward', f.id);
    if (!r.ok) {
      const attempts = f.attempts + 1;
      if (FATAL.has(r.code)) {
        deps.log.error({ forwardId: f.id, code: r.code }, 'FORWARD REFUSED BY SIGNER: data inconsistency, investigate');
        await update(deps, f.id, { status: 'failed', attempts, lastError: r.code });
        return 'failed';
      }
      deps.log.warn({ forwardId: f.id, code: r.code, message: r.message }, 'forward refused for now; retrying later');
      await update(deps, f.id, { attempts, lastError: r.code, nextAttemptAt: later(deps, backoff(attempts)) });
      return 'pending';
    }
    await ctx.sendRaw(r.tx.raw_tx);
    await update(deps, f.id, { status: 'sent', txHash: r.tx.tx_hash, lastError: null, nextAttemptAt: later(deps, POLL_MS) });
    return 'sent';
  }

  // sent
  /* v8 ignore next -- sent is only ever written together with tx_hash */
  if (!f.txHash) throw new Error('sent forward without tx_hash');
  const rc = await ctx.receipt(f.txHash);
  if (!rc) {
    const raw = await signedRaw(deps, 'forward', f.id);
    /* v8 ignore next -- sent is only written after the signer recorded the forward */
    if (raw) await ctx.sendRaw(raw);
    await update(deps, f.id, { nextAttemptAt: later(deps, POLL_MS) });
    return 'sent';
  }
  if (rc.status === 'reverted') {
    deps.log.error({ forwardId: f.id, txHash: f.txHash }, 'forward transaction reverted');
    await update(deps, f.id, { status: 'failed', lastError: 'forward_reverted', blockNumber: rc.blockNumber });
    return 'failed';
  }
  const head = await ctx.blockNumber();
  if (head - rc.blockNumber + 1n < BigInt(confirmations)) {
    await update(deps, f.id, { nextAttemptAt: later(deps, POLL_MS) });
    return 'sent';
  }
  // What actually moved, from the forwarder's own event (the balance may have grown since planning).
  const flushed = decodeFlushed(rc.logs, f.forwarderAddress).filter((e) => e.asset.toLowerCase() === tokenContract.toLowerCase());
  const toMerchant = flushed.reduce((s, e) => s + e.toMerchant, 0n);
  const fee = flushed.reduce((s, e) => s + e.fee, 0n);
  // Book and settle in one transaction: the ledger and the forward's status never disagree.
  await withSystem(deps.db, async (tx) => {
    const [done] = await tx
      .update(forwards)
      .set({ status: 'confirmed', toMerchant, fee, blockNumber: rc.blockNumber, confirmedAt: new Date(deps.clock()), lastError: null })
      .where(and(eq(forwards.id, f.id), eq(forwards.status, 'sent')))
      .returning();
    /* v8 ignore next -- another worker got there first (lease expired mid-step) */
    if (!done) return;
    await postForward(tx, done);
    await settleIfForwarded(deps, tx, done.invoiceId);
  });
  return 'confirmed';
}

/** Advances due forwards (safe on several workers: SKIP LOCKED claim + lease). */
export async function advanceForwards(deps: Deps, env: ForwarderEnv, scope: ForwardScope = {}): Promise<Record<string, number>> {
  const now = deps.clock();
  const claimed = await withSystem(deps.db, async (tx) => {
    const rows = await tx
      .select()
      .from(forwards)
      .where(
        and(
          inArray(forwards.status, ['pending', 'sent']),
          lte(forwards.nextAttemptAt, new Date(now)),
          scope.merchantId ? eq(forwards.merchantId, scope.merchantId) : undefined,
        ),
      )
      .orderBy(asc(forwards.nextAttemptAt))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length > 0) await tx.update(forwards).set({ nextAttemptAt: new Date(now + LEASE_MS) }).where(inArray(forwards.id, rows.map((r) => r.id)));
    return rows;
  });
  const out: Record<string, number> = {};
  for (const f of claimed) {
    const meta = await withSystem(deps.db, async (tx) => {
      const [c] = await tx.select().from(chains).where(eq(chains.id, f.chainId));
      const [t] = await tx.select({ min: tokens.minConfirmations }).from(tokens).where(eq(tokens.id, f.tokenId));
      const [p] = await tx.select({ tokenContract: forwarderParams.tokenContract }).from(forwarderParams).where(eq(forwarderParams.depositAddressId, f.depositAddressId));
      /* v8 ignore next -- FKs guarantee all three */
      return c && t && p ? { chain: c, tokenContract: p.tokenContract, confirmations: Math.max(c.defaultConfirmations, t.min) } : undefined;
    });
    /* v8 ignore next -- FKs guarantee all three */
    if (!meta) continue;
    try {
      const end = await step(deps, env, f, meta.chain, meta.tokenContract, meta.confirmations);
      out[end] = (out[end] ?? 0) + 1;
    } catch (err) {
      // RPC or signer unreachable: keep the state, retry after the lease.
      deps.log.warn({ forwardId: f.id, err: (err as Error).message }, 'forward step failed; retrying');
      out.error = (out.error ?? 0) + 1;
    }
  }
  return out;
}
