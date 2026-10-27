import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { eq } from 'drizzle-orm';
import { withSystem } from '../../src/common/db.js';
import { payments } from '../../src/db/schema.js';
import { advanceSweeps, planSweeps, type SweeperEnv } from '../../src/modules/custody/sweeper.js';
import { transitionInvoice } from '../../src/modules/invoices/invoices.js';
import { postPayment, resolveInvoice } from '../../src/modules/ledger/ledger.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import { FakeChain, custodyEnv, signerPool } from './custody-sim.js';
import { buildTestApp, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
let pool: pg.Pool;
let chain: FakeChain;
let env: SweeperEnv;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  custody = await ensurePlatformCustody(owner);
  pool = await signerPool(owner);
});
afterAll(async () => {
  await pool.end();
  await t.close();
  await owner.end();
});

let logIndex = 0;
/** Custodial merchant (1% fee) with an invoice of `expected` that received a confirmed `received`. */
async function custodialPayment(expected: string, received: bigint, status: 'paid' | 'underpaid' = 'paid') {
  const m = await merchantWithKey(app, clock, owner);
  await owner.query("update merchants set custody_mode = 'custodial', fee_bps = 100 where id = $1", [m.merchantId]);
  const inv = (await m.api('POST', '/v1/invoices', { amount: expected, token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string }>();
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, false, $2, 'evm-local', 'evm-local:usdt', '0xbeef', $3, '0x0000000000000000000000000000000000000001', $4, $5, 7, '0x01', now(), 2) returning id`,
    [m.merchantId, inv.id, 2000 + logIndex++, inv.deposit_address, received.toString()],
  );
  await withSystem(deps.db, async (tx) => {
    const [p] = await tx.update(payments).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(payments.id, r.rows[0]?.id ?? '')).returning();
    if (!p) throw new Error('payment missing');
    await postPayment(tx, p);
    await tx.execute(`update invoices set amount_received = ${received.toString()} where id = '${inv.id}'`);
    await transitionInvoice(deps, tx, inv.id, 'detected', 'test');
    await transitionInvoice(deps, tx, inv.id, 'confirming', 'test');
    await transitionInvoice(deps, tx, inv.id, status, 'test');
  });
  chain.token.set(inv.deposit_address.toLowerCase(), received); // the customer's transfer, on chain
  return { m, inv };
}

const sweepsOf = async (merchantId: string) =>
  (await owner.query<{ id: string; status: string; amount: string; last_error: string | null }>('select id, status, amount::text, last_error from sweeps where merchant_id = $1 order by created_at', [merchantId])).rows;
/** One worker tick, past any poll interval or backoff. */
async function tick(merchantId: string) {
  clock.advance(31 * 60_000);
  return advanceSweeps(deps, env, { merchantId });
}
const balance = async (m: Awaited<ReturnType<typeof merchantWithKey>>) =>
  (await m.api('GET', '/v1/balances')).json<{ data: { token: string; pending: string; available: string }[] }>().data.find((b) => b.token === 'evm-local:usdt');

describe('sweeps', () => {
  beforeAll(() => {
    chain = new FakeChain();
    env = custodyEnv(pool, chain);
  });

  it('gas top-up, sweep, confirmations, then the invoice settles and the balance becomes available', async () => {
    const { m, inv } = await custodialPayment('10', 10n * E18);
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(1);
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(0); // one open sweep per address
    expect((await sweepsOf(m.merchantId))[0]).toMatchObject({ status: 'pending', amount: (10n * E18).toString() });

    expect(await tick(m.merchantId)).toMatchObject({ gas_sent: 1 });
    const sent = chain.broadcasts;
    expect(await tick(m.merchantId)).toMatchObject({ gas_sent: 1 }); // not mined yet: rebroadcast of the same bytes
    expect(chain.broadcasts).toBe(sent + 1);
    expect(chain.mempool.size).toBe(1);
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 });
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 }); // 1 confirmation of 2
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });

    expect(chain.token.get(custody.hot.toLowerCase())).toBeGreaterThanOrEqual(10n * E18);
    expect(chain.token.get(inv.deposit_address.toLowerCase())).toBe(0n);
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'settled' });
    expect(await balance(m)).toMatchObject({ pending: '0', available: '9.9' });
    const lines = await owner.query<{ account: string; amount: string }>(
      `select a.kind as account, e.amount::text from ledger_journals j join ledger_entries e on e.journal_id = j.id join ledger_accounts a on a.id = e.account_id
       where j.invoice_id = $1 and j.kind = 'sweep' order by e.id`,
      [inv.id],
    );
    expect(lines.rows).toEqual([
      { account: 'custody_hot', amount: (10n * E18).toString() },
      { account: 'custody_deposits', amount: (-10n * E18).toString() },
    ]);
    expect(await tick(m.merchantId)).toEqual({}); // nothing left to do
  });

  it('an address that already holds gas skips the top-up', async () => {
    const { m, inv } = await custodialPayment('2', 2n * E18);
    chain.native.set(inv.deposit_address.toLowerCase(), 10n ** 16n);
    await planSweeps(deps, { merchantId: m.merchantId });
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 });
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
  });

  it('a reverted sweep fails; the next round plans a new one that succeeds', async () => {
    const { m, inv } = await custodialPayment('3', 3n * E18);
    chain.native.set(inv.deposit_address.toLowerCase(), 10n ** 16n);
    await planSweeps(deps, { merchantId: m.merchantId });
    await tick(m.merchantId);
    chain.revertNextSweep = true;
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ failed: 1 });
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'paid' }); // not settled
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(1);
    await tick(m.merchantId);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
    expect((await sweepsOf(m.merchantId)).map((s) => s.status)).toEqual(['failed', 'confirmed']);
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'settled' });
  });

  it('a paused signer leaves sweeps waiting (never failed); they resume when unpaused', async () => {
    const { m } = await custodialPayment('1', 1n * E18);
    await planSweeps(deps, { merchantId: m.merchantId });
    // SIGNER_PAUSED (this signer only): the global admin switch would pause every test file signing in parallel.
    clock.advance(31 * 60_000);
    expect(await advanceSweeps(deps, custodyEnv(pool, chain, { SIGNER_PAUSED: 'true' }), { merchantId: m.merchantId })).toMatchObject({ pending: 1 });
    expect((await sweepsOf(m.merchantId))[0]).toMatchObject({ status: 'pending', last_error: 'paused' });
    expect(await tick(m.merchantId)).toMatchObject({ gas_sent: 1 });
    await chain.mine();
    await tick(m.merchantId);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
  });

  it('underpaid funds are swept but stay pending until an admin accepts them, then settle at once', async () => {
    const { m, inv } = await custodialPayment('10', 4n * E18, 'underpaid');
    chain.native.set(inv.deposit_address.toLowerCase(), 10n ** 16n);
    await planSweeps(deps, { merchantId: m.merchantId });
    await tick(m.merchantId);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
    expect(await balance(m)).toMatchObject({ pending: '4', available: '0' });
    await withSystem(deps.db, (tx) => resolveInvoice(deps, tx, inv.id, 'customer confirmed'));
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'settled' });
    expect(await balance(m)).toMatchObject({ pending: '0', available: '3.96' });
  });

  it('rebroadcasts unmined transactions; a broadcast error keeps the state and retries', async () => {
    const { m } = await custodialPayment('1', 1n * E18);
    await planSweeps(deps, { merchantId: m.merchantId });
    chain.failNextSend = true;
    expect(await tick(m.merchantId)).toEqual({ error: 1 });
    expect((await sweepsOf(m.merchantId))[0]?.status).toBe('pending');
    expect(await tick(m.merchantId)).toMatchObject({ gas_sent: 1 });
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 });
    const before = chain.broadcasts;
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 }); // not mined: same bytes again
    expect(chain.broadcasts).toBe(before + 1);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
  });

  it('a reverted gas top-up fails the sweep; fees that rose after a top-up make the sweep wait', async () => {
    const a = await custodialPayment('1', 1n * E18);
    await planSweeps(deps, { merchantId: a.m.merchantId });
    await tick(a.m.merchantId);
    chain.revertNextNative = true;
    await chain.mine();
    expect(await tick(a.m.merchantId)).toEqual({ failed: 1 });
    expect((await sweepsOf(a.m.merchantId))[0]).toMatchObject({ status: 'failed', last_error: 'gas_topup_reverted' });

    const b = await custodialPayment('1', 1n * E18);
    await planSweeps(deps, { merchantId: b.m.merchantId });
    await tick(b.m.merchantId);
    await chain.mine();
    chain.gasPrice *= 3n; // still under the signer's ceiling, but the top-up no longer covers the fee
    try {
      expect(await tick(b.m.merchantId)).toEqual({ gas_sent: 1 });
      expect((await sweepsOf(b.m.merchantId))[0]).toMatchObject({ status: 'gas_sent', last_error: 'needs_gas' });
    } finally {
      chain.gasPrice /= 3n;
    }
    await chain.mine(); // nothing pending; fee back to normal
    expect(await tick(b.m.merchantId)).toMatchObject({ sweep_sent: 1 });
    await chain.mine(3);
    expect(await tick(b.m.merchantId)).toMatchObject({ confirmed: 1 });
  });

  it('a signer holding another seed refuses: the sweep fails as an inconsistency (never retried)', async () => {
    const { m } = await custodialPayment('1', 1n * E18);
    await planSweeps(deps, { merchantId: m.merchantId });
    const stranger = custodyEnv(pool, chain, {}, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    clock.advance(60_000);
    expect(await advanceSweeps(deps, stranger, { merchantId: m.merchantId })).toEqual({ failed: 1 });
    expect((await sweepsOf(m.merchantId))[0]).toMatchObject({ status: 'failed', last_error: 'not_our_address' });
    // The next plan starts over with a correct signer.
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(1);
    await tick(m.merchantId);
    await chain.mine();
    await tick(m.merchantId);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
  });

  it('the unscoped worker run (production path) plans and advances without errors', async () => {
    await planSweeps(deps);
    const r = await advanceSweeps(deps, env);
    expect(r.error ?? 0).toBe(0);
  });

  it('reconciliation stays clean across sweeps and settlements', async () => {
    const issues = await reconcileLedger(deps);
    expect(issues.filter((i) => ['custodial_received', 'custodial_settlement', 'negative_merchant_balance', 'sweep_journal', 'negative_custody', 'ledger_unbalanced'].includes(i.check))).toEqual([]);
  });

  it('the hot wallet received exactly what was swept', () => {
    // Every sweep of this file's merchants reached the hot wallet, and nothing is left in flight for them.
    expect(chain.token.get(custody.hot.toLowerCase())).toBeGreaterThanOrEqual((10n + 2n + 3n + 1n + 4n + 1n + 1n + 1n) * E18);
  });
});
