// Payouts to a merchant's users and the merchant's own withdrawal limits (D-100): custody on, any user wallet,
// automatic within the merchant's limits (live needs them), flat payout fee held with the amount and booked to the
// platform on confirmation; never to a gateway or blocked address. The app, the database guard and the signer each
// enforce the rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { advanceWithdrawals } from '../../src/modules/custody/payouts.js';
import type { SweeperEnv } from '../../src/modules/custody/sweeper.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import { FakeChain, custodyEnv, fundCustodialMerchant, signerPool } from './custody-sim.js';
import { LOCAL_USDT, adminAgent, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, ensurePlatformCustody, ownerPool, totpNow } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
const PAYOUT = '0x00000000000000000000000000000000000beef1';
const USER = '0x00000000000000000000000000000000000CaFE1';
// Own chains and tokens: the signer's 24-hour totals per token are shared by every test file.
const CHAIN = 'evm-payout';
const LIVE_CHAIN = 'evm-payoutlive';
let pool: pg.Pool;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;
let chain: FakeChain;
let env: SweeperEnv;

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  await ensureLiveSimRegistry(owner);
  for (const [id, evmId, testnet] of [[CHAIN, 31341, true], [LIVE_CHAIN, 31342, false]] as const) {
    await owner.query(
      `insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations, reorg_depth, finality, testnet, enabled)
       values ($1, 'evm', 'Payouts test chain', $2, $3, 'ETH', 18, 1000, 2, 16, 'tag', $4, true) on conflict do nothing`,
      [id, evmId, ['http://127.0.0.1:1'], testnet],
    );
    await owner.query(
      `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
       values ($1, $2, 'USDT', 'Payouts USDT', $3, 18, 2, 10000000000000000, true) on conflict do nothing`,
      [`${id}:usdt`, id, LOCAL_USDT],
    );
  }
  custody = await ensurePlatformCustody(owner);
  pool = await signerPool(owner);
  chain = new FakeChain();
  env = custodyEnv(pool, chain, { SIGNER_LIMITS: JSON.stringify({ [`${CHAIN}:usdt`]: { per_tx: '1000', per_day: '5000' }, [`${LIVE_CHAIN}:usdt`]: { per_tx: '1000', per_day: '5000' } }) });
  chain.token.set(custody.hot.toLowerCase(), 10_000n * E18);
  chain.native.set(custody.hot.toLowerCase(), E18);
});
afterAll(async () => {
  await pool.end();
  await t.close();
  await owner.end();
});

type M = Awaited<ReturnType<typeof fundCustodialMerchant>>;
type View = { id: string; object: string; kind: string; status: string; amount: string; fee: string; customer_ref: string | null; to_address: string };
const tokenOf = (livemode: boolean) => `${livemode ? LIVE_CHAIN : CHAIN}:usdt`;
const funded = (amount: bigint, livemode = false) => fundCustodialMerchant({ app, clock, deps, owner, custody }, amount, livemode, livemode ? LIVE_CHAIN : CHAIN);
const code = (m: M) => {
  clock.advance(30_000);
  return { 'x-totp-code': totpNow(m.secret, clock()) };
};
const setLimits = (m: M, perTx: string | null, perDay: string | null, livemode = false) =>
  m.agent.req('PUT', '/v1/dashboard/withdrawals/limits', { livemode, token: tokenOf(livemode), per_tx: perTx, per_day: perDay }, code(m));
const bal = async (m: M, livemode = false) =>
  (await m.agent.req('GET', `/v1/dashboard/balances/?livemode=${String(livemode)}`)).json<{ data: { token: string; available: string; withdrawing: string }[] }>().data.find((b) => b.token === tokenOf(livemode));
const tick = (m: M) => {
  clock.advance(31 * 60_000);
  return advanceWithdrawals(deps, env, { merchantId: m.merchantId });
};
async function sendThrough(m: M) {
  expect(await tick(m)).toEqual({ sent: 1 });
  await chain.mine();
  await chain.mine();
  expect(await tick(m)).toEqual({ confirmed: 1 });
}
const payoutKey = (m: M, livemode = false) => m.mintKey(['read', 'payouts:write'], livemode);
const pay = (m: M, key: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  m.api('POST', '/v1/payouts', { customer_ref: 'user-42', to_address: USER, token: tokenOf(false), amount: '10', ...body }, headers, key);
async function setPayoutFee(m: M, fee: string) {
  const admin = await adminAgent(t, owner);
  const r = await admin.agent.req('PUT', `/admin/v1/merchants/${m.merchantId}/fees`, { fee_bps: 0, fee_fixed: '0', fee_grace: '0', payout_fee: fee, reason: 'payout fee agreed' }, admin.stepUp());
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ payout_fee: fee });
}

describe('merchant withdrawal limits (D-100)', () => {
  it('the owner sets one-time and daily limits (2FA, audited); they cap the merchant own withdrawals; empty clears', async () => {
    const m = await funded(30n * E18);
    await owner.query(
      `insert into payout_addresses (id, merchant_id, livemode, family, address, created_by, activates_at) values (gen_random_uuid(), $1, false, 'evm', $2, $3, now() - interval '1 day')`,
      [m.merchantId, PAYOUT, m.userId],
    );
    expect((await m.agent.req('PUT', '/v1/dashboard/withdrawals/limits', { livemode: false, token: tokenOf(false), per_tx: '5', per_day: '8' })).statusCode).toBe(403); // no 2FA
    expect((await setLimits(m, '9', '8')).json().error.details.field).toBe('per_tx'); // one-time above daily
    expect((await setLimits(m, '0', null)).statusCode).toBe(400);
    const r = await setLimits(m, '5', '8');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ token: tokenOf(false), per_tx: '5', per_day: '8', used_24h: '0' });

    const withdraw = (amount: string) => m.agent.req('POST', '/v1/dashboard/withdrawals/', { livemode: false, token: tokenOf(false), amount }, code(m));
    expect((await withdraw('6')).json().error.details.reason).toBe('over_tx_limit');
    expect((await withdraw('5')).statusCode).toBe(201);
    expect((await withdraw('4')).json().error.details.reason).toBe('over_day_limit'); // 5 + 4 > 8
    expect((await withdraw('3')).statusCode).toBe(201);
    expect((await m.agent.req('GET', '/v1/dashboard/withdrawals/limits?livemode=false')).json()).toMatchObject({ data: [{ per_tx: '5', per_day: '8', used_24h: '8' }] });

    expect((await setLimits(m, null, null)).json()).toMatchObject({ per_tx: null, per_day: null });
    expect((await withdraw('10')).statusCode).toBe(201);
    const logs = await owner.query<{ after: unknown }>("select after from audit_logs where action = 'withdrawal_limits.changed' and merchant_id = $1 order by seq", [m.merchantId]);
    expect(logs.rows.map((l) => l.after)).toEqual([
      { asset: tokenOf(false), livemode: false, per_tx: '5', per_day: '8' },
      { asset: tokenOf(false), livemode: false, per_tx: null, per_day: null },
    ]);
  });
});

describe('payouts to users (D-100)', () => {
  it('sent automatically with the payout fee; payout.* events; the fee is booked to the platform on confirmation', async () => {
    const m = await funded(30n * E18);
    await setPayoutFee(m, '0.5');
    const key = await payoutKey(m);
    const h = { 'idempotency-key': 'po-1' };
    const r = await pay(m, key, {}, h);
    expect(r.statusCode).toBe(201);
    const p = r.json<View>();
    expect(p).toMatchObject({ object: 'payout', kind: 'customer', status: 'approved', amount: '10', fee: '0.5', customer_ref: 'user-42', to_address: USER });
    expect((await pay(m, key, {}, h)).json<View>().id).toBe(p.id); // idempotent
    expect(await bal(m)).toMatchObject({ available: '19.5', withdrawing: '10.5' });

    await sendThrough(m);
    expect(chain.token.get(USER.toLowerCase())).toBe(10n * E18);
    expect(await bal(m)).toMatchObject({ available: '19.5', withdrawing: '0' });
    const lines = await owner.query<{ kind: string; amount: string }>(
      `select a.kind::text kind, e.amount::text amount from ledger_journals j join ledger_entries e on e.journal_id = j.id
       join ledger_accounts a on a.id = e.account_id where j.withdrawal_id = $1 and j.kind = 'withdrawal' order by e.id`,
      [p.id],
    );
    expect(lines.rows).toEqual([
      { kind: 'merchant_withdrawing', amount: String(105n * 10n ** 17n) },
      { kind: 'custody_hot', amount: String(-10n * E18) },
      { kind: 'platform_fee_revenue', amount: String(-5n * 10n ** 17n) },
    ]);
    const events = await owner.query<{ type: string }>("select type from outbox_events where merchant_id = $1 and (type like 'payout.%' or type like 'withdrawal.%') order by seq", [m.merchantId]);
    expect(events.rows.map((e) => e.type)).toEqual(['payout.approved', 'payout.sent', 'payout.confirmed']);

    // Listed as payouts (filterable by user), not as the merchant's own withdrawals.
    expect((await m.api('GET', '/v1/payouts?customer_ref=user-42')).json<{ data: View[] }>().data.map((x) => x.id)).toEqual([p.id]);
    expect((await m.api('GET', '/v1/payouts?customer_ref=someone-else')).json<{ data: View[] }>().data).toEqual([]);
    expect((await m.api('GET', `/v1/payouts/${p.id}`)).json()).toMatchObject({ status: 'confirmed' });
    expect((await m.api('GET', `/v1/withdrawals/${p.id}`)).statusCode).toBe(404);
    expect((await m.api('GET', '/v1/withdrawals')).json<{ data: View[] }>().data).toEqual([]);
    expect((await m.agent.req('GET', '/v1/dashboard/withdrawals/?livemode=false&kind=customer')).json<{ data: View[] }>().data).toHaveLength(1);
    // No owner emails for automatic payouts (webhooks only).
    const mails = await owner.query("select 1 from email_outbox where merchant_id = $1 and kind like 'withdrawal%'", [m.merchantId]);
    expect(mails.rowCount).toBe(0);
  });

  it('refused: gateway or blocked destination, a checksum typo, amount plus fee above the balance, a key without the scope', async () => {
    const m = await funded(20n * E18);
    await setPayoutFee(m, '1');
    const key = await payoutKey(m);
    const bad = async (to: string) => (await pay(m, key, { to_address: to })).json<{ error: { details: Record<string, unknown> } }>().error.details;
    expect(await bad(custody.hot)).toMatchObject({ reason: 'bad_destination' });
    const dep = await owner.query<{ address: string }>('select address from deposit_addresses where merchant_id = $1 limit 1', [m.merchantId]);
    expect(await bad(dep.rows[0]?.address ?? '')).toMatchObject({ reason: 'bad_destination' });
    const admin = await adminAgent(t, owner);
    const blocked = '0x00000000000000000000000000000000000bad01';
    await owner.query("insert into risk_blocked_addresses (id, family, address, reason, created_by) values (gen_random_uuid(), 'evm', $1, 'test', $2)", [blocked, admin.id]);
    expect(await bad(blocked)).toMatchObject({ reason: 'bad_destination' });
    expect(await bad('0x00000000000000000000000000000000000cAFE1')).toMatchObject({ field: 'to_address' }); // checksum typo
    expect((await pay(m, key, { amount: '19.5' })).json().error.details.reason).toBe('insufficient_balance'); // 19.5 + 1 > 20
    expect((await pay(m, key, { amount: '0' })).statusCode).toBe(400);
    expect((await pay(m, await m.mintKey(['read', 'withdrawals:write']))).statusCode).toBe(403);
    expect(await bal(m)).toMatchObject({ available: '20', withdrawing: '0' });
  });

  it('live: refused until both limits are set; then automatic within them, refused above', async () => {
    const m = await funded(100n * E18, true);
    const key = await payoutKey(m, true);
    const live = (amount: string) => m.api('POST', '/v1/payouts', { customer_ref: 'player-7', to_address: USER, token: tokenOf(true), amount }, {}, key);
    expect((await live('5')).json().error.details.reason).toBe('limits_required');
    expect((await setLimits(m, '20', null, true)).statusCode).toBe(200);
    expect((await live('5')).json().error.details.reason).toBe('limits_required'); // the daily one too
    expect((await setLimits(m, '20', '30', true)).statusCode).toBe(200);
    const ok = (await live('15')).json<View & { approvals_required: number }>();
    expect(ok).toMatchObject({ status: 'approved', approvals_required: 0, kind: 'customer' });
    expect((await live('21')).json().error.details.reason).toBe('over_tx_limit');
    expect((await live('16')).json().error.details.reason).toBe('over_day_limit'); // 15 + 16 > 30
  });

  it('the signer re-checks: a lowered limit or a newly blocked destination stops a queued payout, which fails and is released', async () => {
    const m = await funded(50n * E18);
    await setPayoutFee(m, '0.5');
    const key = await payoutKey(m);
    const a = (await pay(m, key, { amount: '10' })).json<View>();
    expect((await setLimits(m, '5', null)).statusCode).toBe(200);
    expect(await tick(m)).toEqual({ failed: 1 });
    expect((await owner.query('select status, last_error from withdrawals where id = $1', [a.id])).rows[0]).toEqual({ status: 'failed', last_error: 'merchant_limit' });
    expect(await bal(m)).toMatchObject({ available: '50', withdrawing: '0' }); // amount and fee released
    expect((await m.api('GET', `/v1/payouts/${a.id}`)).json()).toMatchObject({ status: 'failed' });

    expect((await setLimits(m, null, null)).statusCode).toBe(200);
    const to = '0x00000000000000000000000000000000000bad02';
    const b = (await pay(m, key, { amount: '4', to_address: to })).json<View>();
    const admin = await adminAgent(t, owner);
    await owner.query("insert into risk_blocked_addresses (id, family, address, reason, created_by) values (gen_random_uuid(), 'evm', $1, 'test', $2)", [to, admin.id]);
    expect(await tick(m)).toEqual({ failed: 1 });
    expect((await owner.query('select last_error from withdrawals where id = $1', [b.id])).rows[0]).toEqual({ last_error: 'bad_destination' });
    expect(await bal(m)).toMatchObject({ available: '50', withdrawing: '0' });
  });

  it('database guards: a user payout is auto-approved, carries the merchant fee, respects the limits; identity is immutable', async () => {
    const m = await funded(30n * E18);
    await setPayoutFee(m, '0.5');
    const key = await payoutKey(m);
    const p = (await pay(m, key, { amount: '2' })).json<View>();
    const insert = (over: string) =>
      owner.query(
        `insert into withdrawals (id, merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, fee, status, approvals_required, requested_by)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, fee, status, approvals_required, 'x' from withdrawals where id = $1 ${over}`,
        [p.id],
      );
    await expect(owner.query("update withdrawals set fee = 0 where id = $1", [p.id])).rejects.toThrow(/immutable/);
    await expect(owner.query("update withdrawals set customer_ref = 'other' where id = $1", [p.id])).rejects.toThrow(/immutable/);
    await expect(
      owner.query(
        `insert into withdrawals (id, merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, fee, status, approvals_required, requested_by)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, 0, status, approvals_required, 'x' from withdrawals where id = $1`,
        [p.id],
      ),
    ).rejects.toThrow(/payout to a user/); // wrong fee
    await expect(
      owner.query(
        `insert into withdrawals (id, merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, fee, status, approvals_required, requested_by)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, fee, 'pending_approval', 1, 'x' from withdrawals where id = $1`,
        [p.id],
      ),
    ).rejects.toThrow(/payout to a user/); // needs approval: not a user payout
    await expect(
      owner.query(
        `insert into withdrawals (id, merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, to_address, fee, status, approvals_required, requested_by)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, $2, fee, status, approvals_required, 'x' from withdrawals where id = $1`,
        [p.id, custody.hot],
      ),
    ).rejects.toThrow(/payout to a user/); // to the hot wallet
    expect((await setLimits(m, '1', null)).statusCode).toBe(200);
    await expect(insert('')).rejects.toThrow(/one-time limit/);
    expect((await setLimits(m, null, '3')).statusCode).toBe(200);
    await expect(insert('')).rejects.toThrow(/daily limit/); // 2 + 2 > 3
    await expect(
      owner.query(
        `insert into withdrawals (id, merchant_id, livemode, chain_id, token_id, amount, kind, customer_ref, payout_address_id, to_address, fee, status, approvals_required, requested_by)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, 1, 'customer', 'u', (select id from payout_addresses limit 1), to_address, fee, status, 0, 'x' from withdrawals where id = $1`,
        [p.id],
      ),
    ).rejects.toThrow(/withdrawals_kind/);
  });

  it('reconciliation stays clean', async () => {
    const issues = await reconcileLedger(deps);
    expect(issues.filter((i) => ['negative_merchant_balance', 'negative_custody', 'ledger_unbalanced', 'withdrawal_journal'].includes(i.check))).toEqual([]);
  });
});
