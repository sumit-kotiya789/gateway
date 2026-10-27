import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withSystem } from '../../src/common/db.js';
import { payments } from '../../src/db/schema.js';
import { transitionInvoice } from '../../src/modules/invoices/invoices.js';
import { postPayment, resolveInvoice, settleCustodialInvoice } from '../../src/modules/ledger/ledger.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import { buildTestApp, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool } from './helpers.js';

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
async function pay(inv: { id: string; deposit_address: string }, merchantId: string, amount: bigint, to: 'paid' | 'overpaid' | 'underpaid') {
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, false, $2, 'evm-local', 'evm-local:usdt', '0xc0ffee', $3, '0x0000000000000000000000000000000000000001', $4, $5, 7, '0x01', now(), 2) returning id`,
    [merchantId, inv.id, logIndex++, inv.deposit_address, amount.toString()],
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
