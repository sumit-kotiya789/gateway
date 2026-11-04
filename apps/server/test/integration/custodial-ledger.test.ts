import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withSystem } from '../../src/common/db.js';
import { payments, sweeps } from '../../src/db/schema.js';
import { closeUnderpaidInvoices } from '../../src/modules/custody/partials.js';
import { transitionInvoice } from '../../src/modules/invoices/invoices.js';
import { closePartialPayment, postPayment, postSweep, resolveInvoice, settleCustodialInvoice } from '../../src/modules/ledger/ledger.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import { LOCAL_USDT, buildTestApp, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  await ensurePlatformCustody(owner);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** Custodial test merchant (fee 1% + 0.5 fixed) with a key. */
async function custodialMerchant() {
  const m = await merchantWithKey(app, clock, owner);
  await owner.query("update merchants set custody_mode = 'custodial', fee_bps = 100, fee_fixed = 0.5 where id = $1", [m.merchantId]);
  return m;
}

let logIndex = 0;
/** Records a confirmed payment the way the scanner does (payment row, journal, invoice status), in one transaction. */
async function pay(inv: { id: string; deposit_address: string }, merchantId: string, amount: bigint, to: 'paid' | 'overpaid' | 'underpaid', chain = 'evm-local') {
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, false, $2, $6, $7, '0xc0ffee', $3, '0x0000000000000000000000000000000000000001', $4, $5, 7, '0x01', now(), 2) returning id`,
    [merchantId, inv.id, logIndex++, inv.deposit_address, amount.toString(), chain, `${chain}:usdt`],
  );
  await withSystem(deps.db, async (tx) => {
    const [p] = await tx.update(payments).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(payments.id, r.rows[0]?.id ?? '')).returning();
    if (!p) throw new Error('payment missing');
    await postPayment(tx, p);
    await tx.execute(`update invoices set amount_received = amount_received + ${amount.toString()} where id = '${inv.id}'`);
    await transitionInvoice(deps, tx, inv.id, 'detected', 'test');
    await transitionInvoice(deps, tx, inv.id, 'confirming', 'test');
    await transitionInvoice(deps, tx, inv.id, to, 'test');
  });
}

type Bal = { token: string; received: string; pending: string; available: string; withdrawing: string; fees_charged: string; fee_status: string };
const balance = async (m: Awaited<ReturnType<typeof custodialMerchant>>) =>
  (await m.api('GET', '/v1/balances')).json<{ custody_mode: string; data: Bal[] }>();
const journalLines = async (invoiceId: string) =>
  (
    await owner.query<{ kind: string; account: string; amount: string }>(
      `select j.kind, a.kind as account, e.amount::text from ledger_journals j join ledger_entries e on e.journal_id = j.id
       join ledger_accounts a on a.id = e.account_id where j.invoice_id = $1 order by j.created_at, e.id`,
      [invoiceId],
    )
  ).rows;

describe('custodial ledger', () => {
  it('payment credits pending; settlement moves it to available minus the fee and settles the invoice', async () => {
    const m = await custodialMerchant();
    const inv = (await m.api('POST', '/v1/invoices', { amount: '100', token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string; custody_mode: string }>();
    expect(inv.custody_mode).toBe('custodial');
    await pay(inv, m.merchantId, 100n * E18, 'paid');
    expect((await balance(m)).data.find((b) => b.token === 'evm-local:usdt')).toMatchObject({ received: '100', pending: '100', available: '0', fee_status: 'not_enforced' });
    expect(await journalLines(inv.id)).toEqual([
      { kind: 'payment', account: 'custody_deposits', amount: (100n * E18).toString() },
      { kind: 'payment', account: 'merchant_pending', amount: (-100n * E18).toString() },
    ]);

    expect(await withSystem(deps.db, (tx) => settleCustodialInvoice(deps, tx, inv.id))).toBe(true);
    // Fee: 1% of 100 + 0.5 fixed = 1.5.
    const b = (await balance(m)).data.find((x) => x.token === 'evm-local:usdt');
    expect(b).toMatchObject({ received: '100', pending: '0', available: '98.5', fees_charged: '1.5' });
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'settled' });
    // Idempotent: a second call books nothing.
    expect(await withSystem(deps.db, (tx) => settleCustodialInvoice(deps, tx, inv.id))).toBe(false);
    expect((await journalLines(inv.id)).filter((l) => l.kind === 'settlement')).toHaveLength(3);
  });

  it('overpaid: everything received is credited, fee on the expected amount only; underpaid stays pending until resolved', async () => {
    const m = await custodialMerchant();
    const over = (await m.api('POST', '/v1/invoices', { amount: '10', token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string }>();
    await pay(over, m.merchantId, 12n * E18, 'overpaid');
    await withSystem(deps.db, (tx) => settleCustodialInvoice(deps, tx, over.id));
    // Fee 1% of 10 + 0.5 = 0.6; credited 12 - 0.6.
    expect((await balance(m)).data.find((x) => x.token === 'evm-local:usdt')).toMatchObject({ available: '11.4', fees_charged: '0.6' });

    const under = (await m.api('POST', '/v1/invoices', { amount: '10', token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string }>();
    await pay(under, m.merchantId, 4n * E18, 'underpaid');
    expect(await withSystem(deps.db, (tx) => settleCustodialInvoice(deps, tx, under.id))).toBe(false);
    expect((await balance(m)).data.find((x) => x.token === 'evm-local:usdt')).toMatchObject({ pending: '4', available: '11.4' });
    // An admin accepting the shortfall makes it paid; it settles once swept (resolveInvoice does not settle custodial).
    await withSystem(deps.db, (tx) => resolveInvoice(deps, tx, under.id, 'customer confirmed'));
    expect((await m.api('GET', `/v1/invoices/${under.id}`)).json()).toMatchObject({ status: 'paid' });
    await withSystem(deps.db, (tx) => settleCustodialInvoice(deps, tx, under.id));
    expect((await balance(m)).data.find((x) => x.token === 'evm-local:usdt')).toMatchObject({ pending: '0', available: '14.86' }); // 11.4 + 4 - (1% of 4 + 0.5)
  });

  it('live custodial invoices do not need a prepaid fee balance', async () => {
    const m = await custodialMerchant();
    const r = await m.api('POST', '/v1/invoices', { amount: '1', token: 'evm-local:usdt' });
    expect(r.statusCode).toBe(201);
  });

  it('the database keeps custodial and non-custodial bookings apart', async () => {
    const m = await custodialMerchant();
    const inv = (await m.api('POST', '/v1/invoices', { amount: '5', token: 'evm-local:usdt' })).json<{ id: string }>();
    // A settlement journal for an invoice that is not paid yet is refused.
    await expect(
      owner.query(`insert into ledger_journals (id, kind, merchant_id, livemode, token_id, invoice_id) values (gen_random_uuid(), 'settlement', $1, false, 'evm-local:usdt', $2)`, [m.merchantId, inv.id]),
    ).rejects.toThrow(/paid custodial invoices/);
    // A non-custodial fee journal on a custodial invoice is refused.
    await expect(
      owner.query(`insert into ledger_journals (id, kind, merchant_id, livemode, token_id, invoice_id) values (gen_random_uuid(), 'fee', $1, false, 'evm-local:usdt', $2)`, [m.merchantId, inv.id]),
    ).rejects.toThrow(/non-custodial invoices/);
  });

  it('a custodial payment journal cannot book into non-custodial accounts', async () => {
    const m = await custodialMerchant();
    const inv = (await m.api('POST', '/v1/invoices', { amount: '5', token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string }>();
    await pay(inv, m.merchantId, 5n * E18, 'paid');
    const c = await owner.connect();
    try {
      await c.query('begin');
      const j = await c.query<{ id: string }>("select id from ledger_journals where invoice_id = $1 and kind = 'payment'", [inv.id]);
      const a = await c.query<{ id: string }>(
        "insert into ledger_accounts (id, kind, merchant_id, livemode, token_id) values (gen_random_uuid(), 'merchant_received', $1, false, 'evm-local:usdt') on conflict do nothing returning id",
        [m.merchantId],
      );
      const accountId = a.rows[0]?.id ?? (await c.query<{ id: string }>("select id from ledger_accounts where kind = 'merchant_received' and merchant_id = $1", [m.merchantId])).rows[0]?.id;
      await expect(c.query('insert into ledger_entries (journal_id, account_id, merchant_id, amount) values ($1, $2, $3, 1)', [j.rows[0]?.id, accountId, m.merchantId])).rejects.toThrow(/not allowed in a payment journal/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('reconciliation finds nothing wrong with custodial bookings', async () => {
    const issues = await reconcileLedger(deps);
    const custodial = issues.filter((i) => ['custodial_received', 'custodial_settlement', 'negative_merchant_balance', 'payment_without_journal', 'payment_journal_amount'].includes(i.check));
    expect(custodial).toEqual([]);
  });
});

describe('custodial partial payments (D-092)', () => {
  // Own chain and scanner cursor: the evm-local cursor is moved by the expiry tests in invoices.test.ts.
  const CHAIN = 'evm-partial';
  const TOKEN = `${CHAIN}:usdt`;
  let hot = '';
  beforeAll(async () => {
    await owner.query(
      `insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
         default_confirmations, reorg_depth, finality, testnet, enabled)
       values ($1, 'evm', 'Partial payments test chain', 31339, $2, 'ETH', 18, 1000, 2, 16, 'tag', true, true)
       on conflict (id) do update set enabled = true`,
      [CHAIN, ['http://127.0.0.1:1']],
    );
    await owner.query(
      `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
       values ($1, $2, 'USDT', 'Partial USDT', $3, 18, 2, 10000000000000000, true) on conflict do nothing`,
      [TOKEN, CHAIN, LOCAL_USDT],
    );
    hot = (await ensurePlatformCustody(owner)).hot;
  });
  afterAll(async () => {
    await owner.query('update chains set enabled = false where id = $1', [CHAIN]);
  });

  /** This chain's scanner has reached a block with this timestamp. */
  const scannedUpTo = (at: Date) =>
    owner.query(
      `insert into chain_cursors (chain_id, block_number, block_hash, block_time) values ($1, 1, '0x', $2)
       on conflict (chain_id) do update set block_time = excluded.block_time`,
      [CHAIN, at],
    );
  /** The invoice's deposit address swept into the hot wallet (the sweep path itself: sweeps.test.ts). */
  const swept = (inv: { id: string; deposit_address: string }, merchantId: string, amount: bigint) =>
    withSystem(deps.db, async (tx) => {
      const [d] = (await tx.execute<{ id: string }>(`select deposit_address_id as id from invoices where id = '${inv.id}'`)).rows;
      const [row] = await tx
        .insert(sweeps)
        .values({ merchantId, livemode: false, chainId: CHAIN, tokenId: TOKEN, depositAddressId: d?.id ?? '', invoiceId: inv.id, fromAddress: inv.deposit_address, toAddress: hot, amount })
        .returning();
      await tx.update(sweeps).set({ status: 'sweep_sent', txHash: '0x02' }).where(eq(sweeps.id, row?.id ?? ''));
      const [done] = await tx.update(sweeps).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(sweeps.id, row?.id ?? '')).returning();
      if (!done) throw new Error('sweep missing');
      await postSweep(tx, done);
    });
  type Inv = { id: string; deposit_address: string; status: string; expires_at: string };
  const close = (merchantId: string) => closeUnderpaidInvoices(deps, { merchantId });

  it('underpaid stays open until the deadline; then, scanned and swept, it closes and credits what arrived minus the fee', async () => {
    const m = await custodialMerchant();
    const inv = (await m.api('POST', '/v1/invoices', { amount: '10', token: TOKEN, expires_in: 600 })).json<Inv>();
    await pay(inv, m.merchantId, 4n * E18, 'underpaid', CHAIN);
    const deadline = new Date(inv.expires_at);
    await scannedUpTo(new Date(deadline.getTime() + 86_400_000));
    // Before the deadline the customer can still send the rest.
    expect(await close(m.merchantId)).toEqual([]);
    clock.advance(601_000);
    // The scanner has not reached the deadline: a top-up mined in time may not be recorded yet.
    await scannedUpTo(new Date(deadline.getTime() - 1000));
    expect(await close(m.merchantId)).toEqual([]);
    // Scanned, but the funds are not in the hot wallet yet.
    await scannedUpTo(deadline);
    expect(await close(m.merchantId)).toEqual([]);
    await swept(inv, m.merchantId, 4n * E18);
    expect(await close(m.merchantId)).toEqual([inv.id]);

    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'partially_paid', amount_received: '4' });
    // Fee on what arrived: 1% of 4 + 0.5 fixed = 0.54.
    expect((await balance(m)).data.find((b) => b.token === TOKEN)).toMatchObject({ pending: '0', available: '3.46', fees_charged: '0.54' });
    expect((await journalLines(inv.id)).filter((l) => l.kind === 'settlement')).toEqual([
      { kind: 'settlement', account: 'merchant_pending', amount: (4n * E18).toString() },
      { kind: 'settlement', account: 'merchant_available', amount: (-346n * 10n ** 16n).toString() },
      { kind: 'settlement', account: 'platform_fee_revenue', amount: (-54n * 10n ** 16n).toString() },
    ]);
    const events = await owner.query<{ type: string }>('select type from outbox_events where invoice_id = $1 order by created_at', [inv.id]);
    expect(events.rows.map((e) => e.type)).toContain('invoice.partially_paid');

    // Final: never closed twice, never resolved to paid afterwards.
    expect(await close(m.merchantId)).toEqual([]);
    await expect(withSystem(deps.db, (tx) => resolveInvoice(deps, tx, inv.id, 'customer confirmed'))).rejects.toThrow(/only underpaid or late_payment/);
    await expect(owner.query("update invoices set status = 'paid' where id = $1", [inv.id])).rejects.toThrow(/illegal invoice transition partially_paid -> paid/);
    const issues = await reconcileLedger(deps);
    expect(issues.filter((i) => i.sample.includes(inv.id))).toEqual([]);
  });

  it('the fee never takes more than arrived; the production run (no merchant scope) is valid', async () => {
    const m = await custodialMerchant();
    const inv = (await m.api('POST', '/v1/invoices', { amount: '10', token: TOKEN, expires_in: 600 })).json<Inv>();
    await pay(inv, m.merchantId, 3n * 10n ** 17n, 'underpaid', CHAIN); // 0.3 < the 0.5 fixed fee
    await swept(inv, m.merchantId, 3n * 10n ** 17n);
    clock.advance(601_000);
    await scannedUpTo(new Date(clock() + 86_400_000));
    // Unscoped, as the worker runs it; limit 0 so it cannot touch invoices of other test files.
    expect(await closeUnderpaidInvoices(deps, {}, 0)).toEqual([]);
    expect(await close(m.merchantId)).toEqual([inv.id]);
    expect((await balance(m)).data.find((b) => b.token === TOKEN)).toMatchObject({ pending: '0', available: '0', fees_charged: '0.3' });
  });

  it('late payments wait for an admin; non-custodial invoices never close as partial', async () => {
    // Late (after expiry): not touched by the worker; credited only once an admin accepts it.
    const m = await custodialMerchant();
    const late = (await m.api('POST', '/v1/invoices', { amount: '10', token: TOKEN, expires_in: 600 })).json<Inv>();
    await withSystem(deps.db, (tx) => transitionInvoice(deps, tx, late.id, 'expired', 'test'));
    const r = await owner.query<{ id: string }>(
      `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
       values (gen_random_uuid(), $1, false, $2, $3, $4, '0xc0ffee', $5, '0x0000000000000000000000000000000000000001', $6, $7, 7, '0x01', now(), 2) returning id`,
      [m.merchantId, late.id, CHAIN, TOKEN, logIndex++, late.deposit_address, (10n * E18).toString()],
    );
    await withSystem(deps.db, async (tx) => {
      const [p] = await tx.update(payments).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(payments.id, r.rows[0]?.id ?? '')).returning();
      if (!p) throw new Error('payment missing');
      await postPayment(tx, p);
      await tx.execute(`update invoices set amount_received = ${(10n * E18).toString()} where id = '${late.id}'`);
      await transitionInvoice(deps, tx, late.id, 'late_payment', 'test');
    });
    await swept(late, m.merchantId, 10n * E18);
    clock.advance(601_000);
    await scannedUpTo(new Date(clock() + 86_400_000));
    expect(await close(m.merchantId)).toEqual([]);
    expect((await balance(m)).data.find((b) => b.token === TOKEN)).toMatchObject({ pending: '10', available: '0' });
    await withSystem(deps.db, (tx) => resolveInvoice(deps, tx, late.id, 'merchant accepts the late payment'));
    expect((await m.api('GET', `/v1/invoices/${late.id}`)).json()).toMatchObject({ status: 'settled' });
    expect((await balance(m)).data.find((b) => b.token === TOKEN)).toMatchObject({ pending: '0', available: '9.4' }); // 10 - (1% + 0.5)

    // Non-custodial: the merchant already holds what arrived; underpaid stays a manual decision.
    const nc = await merchantWithKey(app, clock, owner);
    const ncInv = (await nc.api('POST', '/v1/invoices', { amount: '10', token: 'evm-local:usdt' })).json<Inv>();
    await pay(ncInv, nc.merchantId, 4n * E18, 'underpaid');
    clock.advance(3_601_000);
    expect(await closeUnderpaidInvoices(deps, { merchantId: nc.merchantId })).toEqual([]);
    expect(await withSystem(deps.db, (tx) => closePartialPayment(deps, tx, ncInv.id))).toBe(false);
    await expect(owner.query("update invoices set status = 'partially_paid' where id = $1", [ncInv.id])).rejects.toThrow(/only custodial invoices close as partially paid/);
    expect((await nc.api('GET', `/v1/invoices/${ncInv.id}`)).json()).toMatchObject({ status: 'underpaid' });
  });
});
