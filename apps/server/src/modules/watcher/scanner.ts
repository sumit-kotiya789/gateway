// MONEY-CRITICAL
// Chain scanner: finds token transfers to watched deposit addresses, follows them to confirmation, survives reorgs,
// and moves invoices accordingly. One tick = RPC reads first, then ONE fenced DB transaction (D-017):
//   1. eth_getLogs for [cursor - reorgDepth + 1, min(latest, cursor + MAX_RANGE)], filtered by token AND recipient.
//      The rescan window re-finds transfers re-mined in replacement blocks after a reorg.
//   2. Every unconfirmed payment: is its block still canonical? If not, find the tx again (moved) or orphan it.
//      If canonical and deep enough (tiers + finality, D-008/D-035), re-check the receipt, then confirm.
//   3. Write payments, advance the cursor, re-plan every touched invoice (core planInvoice).
import type { BlockInfo, ChainAdapter, ChainConfig, Receipt, TokenConfig, Transfer } from '@gw/core';
import { isConfirmed, planInvoice, requiredConfirmations, type InvoiceStatus } from '@gw/core';
import { and, eq, gt, ne, or, sql } from 'drizzle-orm';
import { withSystem, type Tx } from '../../common/db.js';
import { chainCursors, depositAddresses, invoices, payments } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { transitionInvoice } from '../invoices/invoices.js';

/** A newer leader owns this chain: the tick wrote nothing and this process must stop scanning. */
export class FencedError extends Error {
  constructor(chainId: string) {
    super(`watcher for ${chainId} lost leadership`);
    this.name = 'FencedError';
  }
}

// ponytail: fixed sizes; make them per-chain registry columns if a provider needs different limits.
export const MAX_RANGE = 500n; // blocks per getLogs call
export const RECIPIENT_BATCH = 100; // addresses per topic OR-list
const ORPHAN_RECHECK_MS = 24 * 3600_000;

export interface Scanner {
  deps: Deps;
  adapter: ChainAdapter;
  chain: ChainConfig;
  tokens: readonly TokenConfig[];
  epoch: number;
}

type PaymentRow = typeof payments.$inferSelect;
type Decision =
  | { kind: 'confirm'; id: string }
  | { kind: 'orphan'; id: string }
  | { kind: 'move'; id: string; block: BlockInfo };

const REASON: Record<InvoiceStatus, string> = {
  detected: 'payment detected on-chain',
  confirming: 'payment has confirmations',
  pending: 'payment removed by chain reorganization',
  paid: 'payments confirmed: amount paid',
  underpaid: 'payments confirmed: amount short',
  overpaid: 'payments confirmed: amount exceeded',
  expired: 'payment arrived after the deadline',
  late_payment: 'payment confirmed after expiry or cancellation',
  // Never reached by the watcher (not in WATCHER_TRANSITIONS); listed so every status has a reason.
  created: 'watcher: created',
  settled: 'watcher: settled',
  cancelled: 'watcher: cancelled',
  failed: 'watcher: failed',
};

/** Creates the cursor on first leadership (no history backfill) and bumps the fencing epoch. Returns the new epoch. */
export async function becomeLeader(deps: Deps, adapter: ChainAdapter, chain: ChainConfig): Promise<number> {
  const latest = await adapter.getLatestBlock();
  const start = latest > BigInt(chain.reorgDepth) ? latest - BigInt(chain.reorgDepth) : 0n;
  const b = await adapter.getBlock(start);
  return withSystem(deps.db, async (tx) => {
    await tx
      .insert(chainCursors)
      .values({ chainId: chain.id, blockNumber: b.number, blockHash: b.hash, blockTime: new Date(Number(b.timestamp) * 1000) })
      .onConflictDoNothing();
    const [c] = await tx
      .update(chainCursors)
      .set({ leaderEpoch: sql`${chainCursors.leaderEpoch} + 1`, updatedAt: new Date(deps.clock()) })
      .where(eq(chainCursors.chainId, chain.id))
      .returning({ epoch: chainCursors.leaderEpoch });
    /* v8 ignore next -- invariant: the row was inserted above */
    if (!c) throw new Error(`cursor for ${chain.id} missing`);
    return c.epoch;
  });
}

function receiptHasPayment(r: Receipt, p: PaymentRow, token: TokenConfig): boolean {
  return (
    r.status === 'success' &&
    r.transfers.some(
      (t) =>
        t.logIndex === p.logIndex &&
        t.tokenAddress.toLowerCase() === token.contractAddress.toLowerCase() &&
        t.to.toLowerCase() === p.toAddress.toLowerCase() &&
        t.amount === p.amount,
    )
  );
}

const blockTime = (b: BlockInfo) => new Date(Number(b.timestamp) * 1000);

export async function scanTick(s: Scanner) {
  const { deps, adapter, chain } = s;
  const latest = await adapter.getLatestBlock();
  const finalized = await adapter.getFinalizedBlock();
  const [cursor] = await withSystem(deps.db, (tx) => tx.select().from(chainCursors).where(eq(chainCursors.chainId, chain.id)));
  /* v8 ignore next -- invariant: becomeLeader creates the cursor before the first tick */
  if (!cursor) throw new Error(`cursor for ${chain.id} missing`);
  // A lagging RPC behind our cursor: nothing safe to do this tick.
  if (latest < cursor.blockNumber) return { latest, from: cursor.blockNumber, to: cursor.blockNumber, found: 0, decisions: 0 };

  const depth = BigInt(chain.reorgDepth);
  const from = cursor.blockNumber + 1n > depth ? cursor.blockNumber + 1n - depth : 0n;
  const to = latest < cursor.blockNumber + MAX_RANGE ? latest : cursor.blockNumber + MAX_RANGE;

  // Read AFTER `latest`: an address created later cannot have been paid in a block <= latest.
  const watched = await withSystem(deps.db, (tx) =>
    tx
      .select({ address: depositAddresses.address, invoice: invoices })
      .from(depositAddresses)
      .innerJoin(invoices, eq(invoices.depositAddressId, depositAddresses.id))
      .where(and(eq(depositAddresses.chainId, chain.id), gt(depositAddresses.watchUntil, new Date(deps.clock())))),
  );
  const byAddress = new Map(watched.map((w) => [w.address.toLowerCase(), w.invoice]));
  const tokenById = new Map(s.tokens.map((t) => [t.id, t]));

  const found: { t: Transfer; token: TokenConfig; invoice: (typeof watched)[number]['invoice'] }[] = [];
  for (const token of s.tokens) {
    // Only the invoice's own token counts; other tokens sent to the address are not credited.
    const addrs = watched.filter((w) => w.invoice.tokenId === token.id).map((w) => w.address);
    for (let i = 0; i < addrs.length; i += RECIPIENT_BATCH) {
      for (const t of await adapter.getTokenTransfers(token, from, to, addrs.slice(i, i + RECIPIENT_BATCH))) {
        const invoice = byAddress.get(t.to.toLowerCase());
        // Dust is ignored (address-poisoning defense, and it could never be credited).
        if (invoice?.tokenId === token.id && t.amount >= token.minAmount) found.push({ t, token, invoice });
      }
    }
  }

  const blocks = new Map<bigint, BlockInfo>();
  const block = async (n: bigint) => {
    let b = blocks.get(n);
    if (!b) {
      b = await adapter.getBlock(n);
      blocks.set(n, b);
    }
    return b;
  };
  // A transfer whose block is no longer canonical (reorg mid-tick) is skipped; the next tick sees the new chain.
  const fresh: typeof found = [];
  for (const f of found) if ((await block(f.t.blockNumber)).hash === f.t.blockHash) fresh.push(f);

  // Unconfirmed payments, plus recently orphaned ones: an orphan caused by a flaky RPC view must be able to come back
  // even after it has left the rescan window.
  const tracked = await withSystem(deps.db, (tx) =>
    tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.chainId, chain.id),
          or(eq(payments.status, 'detected'), and(eq(payments.status, 'orphaned'), gt(payments.orphanedAt, new Date(deps.clock() - ORPHAN_RECHECK_MS)))),
        ),
      ),
  );
  /** Where the tx sits on the canonical chain now, or null if it is not (verifiably) there. */
  const canonicalBlock = async (p: PaymentRow, token: TokenConfig) => {
    const r = await adapter.getTransactionReceipt(p.txHash);
    if (!r || r.blockNumber > latest || !receiptHasPayment(r, p, token)) return null;
    const b = await block(r.blockNumber);
    return b.hash === r.blockHash ? b : null;
  };
  const decisions: Decision[] = [];
  for (const p of tracked) {
    const token = tokenById.get(p.tokenId);
    if (!token || p.blockNumber > latest) continue; // token disabled at runtime, or RPC behind this payment: wait
    if (p.status === 'orphaned') {
      const b = await canonicalBlock(p, token);
      if (b) decisions.push({ kind: 'move', id: p.id, block: b });
      continue;
    }
    if ((await block(p.blockNumber)).hash !== p.blockHash) {
      const b = await canonicalBlock(p, token);
      decisions.push(b ? { kind: 'move', id: p.id, block: b } : { kind: 'orphan', id: p.id });
      continue;
    }
    if (!isConfirmed({ txBlock: p.blockNumber, latest, finalized, required: p.requiredConfirmations })) continue;
    const r = await adapter.getTransactionReceipt(p.txHash);
    if (r?.blockHash === p.blockHash && receiptHasPayment(r, p, token)) decisions.push({ kind: 'confirm', id: p.id });
    else deps.log.warn({ chain: chain.id, payment: p.id }, 'deep payment failed receipt re-check; not confirming');
  }

  const toBlock = await block(to);
  // Our cursor block replaced although it is older than reorgDepth: confirmations may have been granted on a dead
  // chain. Operators must look (RUNBOOK "Deep reorg"); scanning continues.
  if (cursor.blockNumber + depth < latest && (await block(cursor.blockNumber)).hash !== cursor.blockHash) {
    deps.log.error({ chain: chain.id, block: cursor.blockNumber.toString() }, 'DEEP REORG: cursor block replaced beyond reorgDepth');
  }
  await withSystem(deps.db, async (tx) => {
    const [c] = await tx
      .select()
      .from(chainCursors)
      .where(and(eq(chainCursors.chainId, chain.id), eq(chainCursors.leaderEpoch, s.epoch)))
      .for('update');
    if (!c) throw new FencedError(chain.id);
    const now = new Date(deps.clock());
    const touched = new Set(tracked.map((p) => p.invoiceId));

    for (const { t, token, invoice } of fresh) {
      const required = requiredConfirmations(token, t.amount > invoice.amountExpected ? t.amount : invoice.amountExpected);
      const b = await block(t.blockNumber);
      const rows = await tx
        .insert(payments)
        .values({
          merchantId: invoice.merchantId,
          livemode: invoice.livemode,
          invoiceId: invoice.id,
          chainId: chain.id,
          tokenId: token.id,
          txHash: t.txHash,
          logIndex: t.logIndex,
          fromAddress: t.from,
          toAddress: t.to,
          amount: t.amount,
          blockNumber: t.blockNumber,
          blockHash: t.blockHash,
          blockTime: blockTime(b),
          requiredConfirmations: required,
        })
        // Seen again: revive an orphan, or follow a re-mine into a new block. Confirmed rows are never touched.
        .onConflictDoUpdate({
          target: [payments.chainId, payments.txHash, payments.logIndex],
          set: { status: 'detected', blockNumber: t.blockNumber, blockHash: t.blockHash, blockTime: blockTime(b), orphanedAt: null },
          setWhere: sql`${payments.status} = 'orphaned' or (${payments.status} = 'detected' and ${payments.blockHash} <> ${t.blockHash})`,
        })
        .returning({ invoiceId: payments.invoiceId });
      for (const r of rows) touched.add(r.invoiceId);
    }

    for (const d of decisions) {
      const set =
        d.kind === 'confirm'
          ? { status: 'confirmed' as const, confirmedAt: now }
          : d.kind === 'orphan'
            ? { status: 'orphaned' as const, orphanedAt: now }
            : { status: 'detected' as const, orphanedAt: null, blockNumber: d.block.number, blockHash: d.block.hash, blockTime: blockTime(d.block) };
      await tx
        .update(payments)
        .set(set)
        .where(and(eq(payments.id, d.id), d.kind === 'move' ? ne(payments.status, 'confirmed') : eq(payments.status, 'detected')));
    }

    if (to > c.blockNumber) {
      await tx
        .update(chainCursors)
        .set({ blockNumber: to, blockHash: toBlock.hash, blockTime: blockTime(toBlock), updatedAt: now })
        .where(eq(chainCursors.chainId, chain.id));
    }

    for (const invoiceId of touched) await reconcileInvoice(deps, tx, invoiceId, latest);
  });

  return { latest, from, to, found: fresh.length, decisions: decisions.length };
}

/** Recomputes an invoice from its payments: amount_received = confirmed sum, then the planned status path. */
export async function reconcileInvoice(deps: Deps, tx: Tx, invoiceId: string, latest: bigint): Promise<void> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  /* v8 ignore next -- invariant: payments reference invoices by FK and invoices are never deleted */
  if (!inv) return;
  const live = await tx.select().from(payments).where(and(eq(payments.invoiceId, invoiceId), ne(payments.status, 'orphaned')));
  const confirmed = live.filter((p) => p.status === 'confirmed').reduce((sum, p) => sum + p.amount, 0n);
  const pending = live.filter((p) => p.status === 'detected');
  const totals = {
    confirmed,
    outstanding: pending.length,
    outstandingMined: pending.some((p) => latest > p.blockNumber),
    allLate: live.length > 0 && live.every((p) => p.blockTime > inv.expiresAt),
  };
  if (inv.amountReceived !== confirmed) {
    await tx.update(invoices).set({ amountReceived: confirmed }).where(eq(invoices.id, invoiceId));
  }
  for (const step of planInvoice(inv.status, inv.amountExpected, inv.underpayToleranceBps, totals)) {
    await transitionInvoice(deps, tx, invoiceId, step, REASON[step]);
  }
}
