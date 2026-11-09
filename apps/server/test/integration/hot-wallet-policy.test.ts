// Hot wallet policy (D-105): admin-set cap and low mark per mode and token. Above the cap the excess moves to cold storage
// automatically (no approvers; signer opt-in SIGNER_AUTO_TO_COLD; DB guard caps it at the excess); below the low mark
// the treasury admins are emailed, again every 24 h, re-armed when the balance recovers.
// Test files share the database: treasury steps are limited to this file's chain, and assertions stay on its rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { runHotWalletPolicies } from '../../src/modules/custody/hot-wallet-policy.js';
import { advanceTreasury } from '../../src/modules/custody/treasury.js';
import type { SweeperEnv } from '../../src/modules/custody/sweeper.js';
import { FakeChain, custodyEnv, fundCustodialMerchant, signerPool } from './custody-sim.js';
import { LOCAL_USDT, TEST_COLD, adminAgent, buildTestApp, ensurePlatformCustody, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
// Own chain and token: the ledger's custody_hot total per token must not mix with other test files.
const CHAIN = 'evm-hotpol';
const TOKEN = `${CHAIN}:usdt`;
const P = '/admin/v1/custody/hot-wallet-policies';
let pool: pg.Pool;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;
let chain: FakeChain;
let on: SweeperEnv;
let off: SweeperEnv;
let admin: Awaited<ReturnType<typeof adminAgent>>;

beforeAll(async () => {
  await app.ready();
  await owner.query(
    `insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations, reorg_depth, finality, testnet, enabled)
     values ($1, 'evm', 'Hot wallet policy test chain', 31343, $2, 'ETH', 18, 1000, 2, 16, 'tag', true, true) on conflict do nothing`,
    [CHAIN, ['http://127.0.0.1:1']],
  );
  await owner.query(
    `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
     values ($1, $2, 'USDT', 'Policy test USDT', $3, 18, 2, 10000000000000000, true) on conflict do nothing`,
    [TOKEN, CHAIN, LOCAL_USDT],
  );
  custody = await ensurePlatformCustody(owner);
  pool = await signerPool(owner);
  chain = new FakeChain();
  on = custodyEnv(pool, chain, { SIGNER_COLD_ADDRESSES: TEST_COLD, SIGNER_AUTO_TO_COLD: 'true' });
  off = custodyEnv(pool, chain, { SIGNER_COLD_ADDRESSES: TEST_COLD });
  chain.native.set(custody.hot.toLowerCase(), E18);
  admin = await adminAgent(t, owner, 'operator');
});
afterAll(async () => {
  await pool.end();
  await t.close();
  await owner.end();
});

const setPolicy = (body: Record<string, unknown>, a = admin) => a.agent.req('PUT', P, { livemode: false, token: TOKEN, reason: 'treasury policy', ...body }, a.stepUp());
const hotOnChain = (units: bigint) => chain.token.set(custody.hot.toLowerCase(), units * E18);
const autoRows = async () =>
  (
    await owner.query<{ id: string; status: string; amount: string; requested_by: string; approved_by: string | null; last_error: string | null }>(
      "select id, status, amount::text, requested_by, approved_by, last_error from treasury_transfers where token_id = $1 and auto order by created_at",
      [TOKEN],
    )
  ).rows;
const lowEmails = async () => Number((await owner.query<{ n: string }>("select count(*)::text as n from email_outbox where kind = 'hot_wallet_low'")).rows[0]?.n ?? '0');
const tick = () => {
  clock.advance(31 * 60_000);
  return advanceTreasury(deps, on, { chainIds: [CHAIN] });
};

describe('hot wallet policy (D-105)', () => {
  it('set by an admin with treasury:manage and 2FA; validated; audited; listed', async () => {
    const auditor = await adminAgent(t, owner, 'auditor');
    expect((await setPolicy({ max_balance: '1500', low_balance: '500' }, auditor)).statusCode).toBe(403);
    expect((await admin.agent.req('PUT', P, { livemode: false, token: TOKEN, max_balance: '1500', low_balance: '500', reason: 'no code' })).statusCode).toBe(403); // step-up
    const bad = await setPolicy({ max_balance: '500', low_balance: '500' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details).toMatchObject({ field: 'low_balance' });
    expect((await setPolicy({ max_balance: '0', low_balance: null })).statusCode).toBe(400);
    expect((await setPolicy({ max_balance: '1500', low_balance: null, token: 'evm-mainsim:usdt' })).statusCode).toBeGreaterThanOrEqual(400); // live-only token in test mode

    const r = await setPolicy({ max_balance: '1500', low_balance: '500' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ livemode: false, token: TOKEN, max_balance: '1500', low_balance: '500', hot_address: custody.hot, updated_by: admin.id });
    const list = (await admin.agent.req('GET', P)).json<{ data: { token: string; max_balance: string }[] }>().data;
    expect(list.find((p) => p.token === TOKEN)).toMatchObject({ max_balance: '1500' });
    const a = await owner.query("select actor_id, after->>'max_balance' as max from audit_logs where action = 'custody.hot_wallet_policy_updated' and actor_id = $1", [admin.id]);
    expect(a.rows.at(-1)).toMatchObject({ actor_id: admin.id, max: '1500' });
  });

  it('above the cap: the excess goes to cold automatically, signed without approvers, booked on confirmation', async () => {
    await fundCustodialMerchant({ app, clock, deps, owner, custody }, 2000n * E18, false, CHAIN);
    hotOnChain(2000n);
    expect(await runHotWalletPolicies(deps, on)).toMatchObject({ to_cold: 1 });
    const [x] = await autoRows();
    expect(x).toMatchObject({ status: 'approved', amount: (500n * E18).toString(), requested_by: admin.id, approved_by: null });
    // One in flight at a time.
    expect((await runHotWalletPolicies(deps, on)).to_cold).toBe(0);
    expect(await autoRows()).toHaveLength(1);

    for (let i = 0; i < 6 && (await autoRows())[0]?.status !== 'confirmed'; i++) {
      await tick();
      await chain.mine(3);
    }
    expect((await autoRows())[0]?.status).toBe('confirmed');
    const signed = await owner.query("select to_address, amount::text from signer_signatures where intent_kind = 'treasury' and intent_id = $1", [x?.id]);
    expect(signed.rows[0]).toMatchObject({ to_address: TEST_COLD, amount: (500n * E18).toString() });
    const lines = await owner.query(
      `select a.kind, e.amount::text from ledger_journals j join ledger_entries e on e.journal_id = j.id join ledger_accounts a on a.id = e.account_id
       where j.treasury_id = $1 order by e.id`,
      [x?.id],
    );
    expect(lines.rows).toEqual([
      { kind: 'custody_cold', amount: (500n * E18).toString() },
      { kind: 'custody_hot', amount: (-500n * E18).toString() },
    ]);
    // At the cap now: nothing more to move.
    hotOnChain(1500n);
    expect((await runHotWalletPolicies(deps, on)).to_cold).toBe(0);
    const audit = await owner.query("select actor_type from audit_logs where action = 'custody.treasury_to_cold_auto' and target_id = $1", [x?.id]);
    expect(audit.rows).toEqual([{ actor_type: 'system' }]);
  });

  it('a signer without SIGNER_AUTO_TO_COLD refuses (the transfer waits); no new transfer for 30 minutes after a failure', async () => {
    await fundCustodialMerchant({ app, clock, deps, owner, custody }, 300n * E18, false, CHAIN);
    hotOnChain(1800n);
    expect((await runHotWalletPolicies(deps, off)).to_cold).toBe(1);
    const x = (await autoRows()).at(-1);
    expect(x).toMatchObject({ status: 'approved', amount: (300n * E18).toString() });
    expect(await off.signer.sign('treasury', x?.id ?? '')).toMatchObject({ ok: false, code: 'auto_disabled' });
    // A failed automatic transfer (say, reverted on chain) is not replaced at once, only after 30 minutes.
    await owner.query("update treasury_transfers set status = 'failed', last_error = 'reverted' where id = $1 and status = 'approved'", [x?.id]);
    expect((await runHotWalletPolicies(deps, on)).to_cold).toBe(0);
    clock.advance(31 * 60_000);
    expect((await runHotWalletPolicies(deps, on)).to_cold).toBe(1);
  });

  it('database guards: auto transfers only hot -> cold, only the excess, only for the policy admin', async () => {
    const [w] = (await owner.query<{ hot: string; cold: string }>(
      "select (select address from platform_wallets where kind = 'hot' and family = 'evm' and not livemode and retired_at is null) as hot, (select address from platform_wallets where kind = 'cold' and family = 'evm' and not livemode and retired_at is null) as cold",
    )).rows;
    const insert = (o: { amount: bigint; direction?: string; status?: string; by?: string }) =>
      owner.query(
        `insert into treasury_transfers (id, livemode, chain_id, token_id, direction, amount, cold_address, hot_address, status, requested_by, reason, auto, tx_hash)
         values (gen_random_uuid(), false, $1, $2, $3, $4, $5, $6, $7, $8, 'test', true, $9)`,
        [CHAIN, TOKEN, o.direction ?? 'to_cold', o.amount.toString(), w?.cold, w?.hot, o.status ?? 'approved', o.by ?? admin.id, o.direction === 'to_hot' ? `0x${'ab'.repeat(32)}` : null],
      );
    // Excess is now 300 (1800 in the ledger, cap 1500) and one auto transfer is in flight: settle it first.
    await owner.query("update treasury_transfers set status = 'failed' where token_id = $1 and auto and status = 'approved'", [TOKEN]);
    await expect(insert({ amount: 301n * E18 })).rejects.toThrow(/above the policy cap/);
    await expect(insert({ amount: 1n * E18, direction: 'to_hot', status: 'sent' })).rejects.toThrow();
    await expect(insert({ amount: 1n * E18, status: 'pending_approval' })).rejects.toThrow();
    const other = await adminAgent(t, owner, 'superadmin');
    await expect(insert({ amount: 1n * E18, by: other.id })).rejects.toThrow(/above the policy cap/);
    await insert({ amount: 300n * E18 });
    await expect(insert({ amount: 1n * E18 })).rejects.toThrow(/treasury_transfers_auto_open_uq/);
  });

  it('below the low mark: treasury admins are emailed once, again after 24 h, and again after a recovery', async () => {
    hotOnChain(400n);
    const before = await lowEmails();
    expect((await runHotWalletPolicies(deps, on)).low_alerts).toBe(1);
    const sent = (await lowEmails()) - before;
    expect(sent).toBeGreaterThanOrEqual(1); // every active superadmin and operator
    const policy = async () => (await owner.query<{ low_alert_at: Date | null; last_balance: string }>('select low_alert_at, last_balance::text from hot_wallet_policies where token_id = $1 and not livemode', [TOKEN])).rows[0];
    expect((await policy())?.low_alert_at).not.toBeNull();
    expect((await policy())?.last_balance).toBe((400n * E18).toString());

    const n1 = await lowEmails();
    clock.advance(60 * 60_000);
    expect((await runHotWalletPolicies(deps, on)).low_alerts).toBe(0); // not again within 24 h
    expect(await lowEmails()).toBe(n1);
    clock.advance(24 * 3600_000);
    expect((await runHotWalletPolicies(deps, on)).low_alerts).toBe(1); // still low a day later

    hotOnChain(1000n);
    await runHotWalletPolicies(deps, on);
    expect((await policy())?.low_alert_at).toBeNull(); // recovered: re-armed
    hotOnChain(100n);
    expect((await runHotWalletPolicies(deps, on)).low_alerts).toBe(1);
  });

  it('no dust transfers, RPC failures are skipped until the next run, and a policy with both limits off does nothing', async () => {
    await owner.query("update treasury_transfers set status = 'failed' where token_id = $1 and auto and status = 'approved'", [TOKEN]);
    clock.advance(31 * 60_000);
    // The ledger holds 1800 (cap 1500): an excess below the token minimum (0.01) is left alone.
    chain.token.set(custody.hot.toLowerCase(), 1500n * E18 + 5n * 10n ** 15n);
    expect(await runHotWalletPolicies(deps, on)).toMatchObject({ checked: 1, to_cold: 0 });
    const down: SweeperEnv = { ...on, chainTx: () => ({ ...chain.tx, tokenBalance: () => Promise.reject(new Error('rpc down')) }) };
    expect(await runHotWalletPolicies(deps, down)).toMatchObject({ checked: 0, to_cold: 0, low_alerts: 0 });
    expect((await setPolicy({ max_balance: null, low_balance: null })).json()).toMatchObject({ max_balance: null, low_balance: null });
    hotOnChain(5000n);
    expect(await runHotWalletPolicies(deps, on)).toMatchObject({ checked: 0, to_cold: 0, low_alerts: 0 });
  });
});
