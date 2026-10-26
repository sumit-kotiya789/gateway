import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/common/db.js';
import { noticeFeeBalance } from '../../src/modules/ledger/fee-balance.js';
import { adminAgent, buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();
const LIVE = 'evm-livefee:usdt';

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  // A mainnet chain + token so live invoices can be created (no RPC needed: nothing is scanned here).
  await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
      default_confirmations, reorg_depth, finality, testnet, enabled)
    values ('evm-livefee', 'evm', 'Live fee test', 990001, '{}', 'ETH', 18, 1000, 2, 16, 'tag', false, true) on conflict do nothing`);
  await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
    values ($1, 'evm-livefee', 'USDT', 'Live fee USDT', '0x00000000000000000000000000000000000000f1', 6, 2, 10000, true) on conflict do nothing`, [LIVE]);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

type Balance = { token: string; prepaid_fees: string; fee_status: string; fees_owed: string };
const liveBalance = async (m: Awaited<ReturnType<typeof merchantWithKey>>) =>
  (await m.api('GET', '/v1/balances')).json<{ data: Balance[] }>().data.find((b) => b.token === LIVE);

async function liveMerchant() {
  const m = await merchantWithKey(app, clock, owner, { livemode: true });
  const op = await adminAgent(t, owner);
  const B = `/admin/v1/merchants/${m.merchantId}`;
  const topUp = (amount: string) =>
    op.agent.req('POST', `${B}/fee-topups`, { livemode: true, token: LIVE, amount, reference: `0x${amount}`, reason: 'prepaid fees received' }, op.stepUp());
  const setFees = (body: Record<string, unknown>) => op.agent.req('PUT', `${B}/fees`, { fee_bps: 100, fee_fixed: '0', fee_grace: '0', reason: 'pricing update', ...body }, op.stepUp());
  const invoice = () => m.api('POST', '/v1/invoices', { amount: '5', token: LIVE });
  return { m, op, B, topUp, setFees, invoice };
}

describe('prepaid fee balance (live)', () => {
  it('a live invoice needs prepaid fees; it is refused without burning an address; a top-up unblocks it', async () => {
    const { m, topUp, invoice } = await liveMerchant();
    expect(await liveBalance(m)).toMatchObject({ prepaid_fees: '0', fee_status: 'blocked', fees_owed: '0' });
    const r = await invoice();
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toMatchObject({ code: 'insufficient_fee_balance', details: { token: LIVE } });
    const x = await owner.query<{ next_index: string }>('select next_index from merchant_xpubs where merchant_id = $1', [m.merchantId]);
    expect(Number(x.rows[0]?.next_index)).toBe(0);

    expect((await topUp('5')).statusCode).toBe(201);
    expect(await liveBalance(m)).toMatchObject({ prepaid_fees: '5', fee_status: 'low' }); // below the 10-unit warning line
    expect((await invoice()).statusCode).toBe(201);
    await topUp('10');
    expect(await liveBalance(m)).toMatchObject({ prepaid_fees: '15', fee_status: 'ok' });
  });

  it('a grace amount lets a merchant start before the first top-up', async () => {
    const { m, setFees, invoice } = await liveMerchant();
    expect((await setFees({ fee_grace: '2' })).json()).toMatchObject({ fee_grace: '2' });
    expect(await liveBalance(m)).toMatchObject({ prepaid_fees: '0', fee_status: 'low' });
    expect((await invoice()).statusCode).toBe(201);
  });

  it('new invoices snapshot the fixed fee; later changes leave them alone', async () => {
    const { topUp, setFees, invoice } = await liveMerchant();
    await topUp('20');
    await setFees({ fee_fixed: '0.25' });
    const id = (await invoice()).json<{ id: string }>().id;
    await setFees({ fee_fixed: '1' });
    const id2 = (await invoice()).json<{ id: string }>().id;
    const r = await owner.query<{ id: string; fee_fixed: string }>('select id, fee_fixed::text from invoices where id = any($1)', [[id, id2]]);
    expect(Object.fromEntries(r.rows.map((x) => [x.id, x.fee_fixed]))).toEqual({ [id]: '250000', [id2]: '1000000' });
    await expect(owner.query('update invoices set fee_fixed = 0 where id = $1', [id])).rejects.toThrow(/immutable/);
  });
});

describe('admin fee management', () => {
  it('needs fees:manage and step-up; validates values; audits before/after', async () => {
    const { m, op, B, setFees } = await liveMerchant();
    const auditor = await adminAgent(t, owner, 'auditor');
    const body = { fee_bps: 150, fee_fixed: '0.3', fee_grace: '5', reason: 'volume discount' };
    expect((await auditor.agent.req('PUT', `${B}/fees`, body, auditor.stepUp())).statusCode).toBe(403);
    expect((await op.agent.req('PUT', `${B}/fees`, body)).statusCode).toBe(403);
    for (const bad of [{ fee_fixed: '1001' }, { fee_fixed: '0.1234567' }, { fee_grace: '-1' }, { fee_grace: '100001' }, { fee_bps: 10_001 }]) {
      expect((await setFees(bad)).statusCode).toBe(400);
    }
    const r = await op.agent.req('PUT', `${B}/fees`, body, op.stepUp());
    expect(r.json()).toMatchObject({ fee_bps: 150, fee_fixed: '0.3', fee_grace: '5' });
    expect((await op.agent.req('GET', B)).json()).toMatchObject({ fee_bps: 150, fee_fixed: '0.3', fee_grace: '5' });
    const a = await owner.query<{ before: unknown; after: unknown }>("select before, after from audit_logs where action = 'admin.merchant_fees_changed' and merchant_id = $1 order by seq desc limit 1", [m.merchantId]);
    expect(a.rows[0]).toEqual({ before: { fee_bps: 100, fee_fixed: '0', fee_grace: '0' }, after: { fee_bps: 150, fee_fixed: '0.3', fee_grace: '5', reason: 'volume discount' } });
  });

  it('top-ups: token must match the mode, amount must be positive; merchants see only their own', async () => {
    const { m, op, B, topUp } = await liveMerchant();
    const post = (b: Record<string, unknown>) => op.agent.req('POST', `${B}/fee-topups`, { livemode: true, token: LIVE, amount: '1', reference: '0xabc', reason: 'prepaid fees', ...b }, op.stepUp());
    expect((await post({ token: 'evm-local:usdt' })).json().error.details).toEqual({ field: 'token' }); // testnet token for live
    expect((await post({ token: 'nope:usdt' })).statusCode).toBe(400);
    expect((await post({ amount: '0' })).json().error.code).toBe('invalid_amount');
    expect((await post({ amount: '1.0000001' })).json().error.code).toBe('invalid_amount');
    expect((await op.agent.req('POST', `${B}/fee-topups`, { livemode: true, token: LIVE, amount: '1', reference: '0xabc', reason: 'prepaid fees' })).statusCode).toBe(403);
    await topUp('3');

    const admin = (await op.agent.req('GET', `${B}/fee-topups`)).json<{ data: { amount: string; reference: string }[] }>().data;
    expect(admin).toEqual([expect.objectContaining({ token: LIVE, amount: '3', reference: '0x3', livemode: true })]);
    expect((await m.agent.req('GET', '/v1/dashboard/fee-topups/?livemode=true')).json<{ data: unknown[] }>().data).toHaveLength(1);
    expect((await m.agent.req('GET', '/v1/dashboard/fee-topups/?livemode=false')).json<{ data: unknown[] }>().data).toHaveLength(0);
    const other = await merchantWithKey(app, clock, owner);
    expect((await other.agent.req('GET', '/v1/dashboard/fee-topups/?livemode=true')).json<{ data: unknown[] }>().data).toHaveLength(0);
    const audit = await owner.query("select after from audit_logs where action = 'admin.fee_topup_recorded' and merchant_id = $1", [m.merchantId]);
    expect(audit.rows).toEqual([{ after: { livemode: true, asset: LIVE, amount: '3', reference: '0x3', reason: 'prepaid fees received' } }]);
  });
});

describe('fee balance notices', () => {
  const notices = async (merchantId: string) =>
    (await owner.query<{ kind: string }>("select kind from email_outbox where merchant_id = $1 and kind like 'fee_balance_%' order by created_at", [merchantId])).rows.map(
      (r) => r.kind,
    );
  // noticeFeeBalance runs right after settlement booked `fee`: the ledger already holds the new balance.
  const notice = (merchantId: string, fee: bigint) => withSystem(deps.db, (tx) => noticeFeeBalance(deps, tx, merchantId, LIVE, fee));

  it('owners are emailed when a fee moves the live balance into low, once per crossing', async () => {
    const { m, topUp } = await liveMerchant();
    await topUp('8'); // prepaid 8: low
    await notice(m.merchantId, 5_000_000n); // from 13 (ok) to 8 (low): crossing
    await notice(m.merchantId, 1_000_000n); // from 9 (low) to 8 (low): no crossing
    expect(await notices(m.merchantId)).toEqual(['fee_balance_low']);
  });

  it('and into blocked', async () => {
    const { m } = await liveMerchant(); // prepaid 0: blocked
    await notice(m.merchantId, 5_000_000n); // from 5 (low) to 0 (blocked)
    expect(await notices(m.merchantId)).toEqual(['fee_balance_blocked']);
  });
});
