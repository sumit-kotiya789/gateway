import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { advanceTreasury } from '../../src/modules/custody/treasury.js';
import type { SweeperEnv } from '../../src/modules/custody/sweeper.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import { FakeChain, custodyEnv, fundCustodialMerchant, signerPool } from './custody-sim.js';
import { LOCAL_USDT, TEST_COLD, adminAgent, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, ensurePlatformCustody, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
const B = '/admin/v1/custody/treasury';
let pool: pg.Pool;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;
let chain: FakeChain;
let env: SweeperEnv;

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  await ensureLiveSimRegistry(owner);
  custody = await ensurePlatformCustody(owner);
  pool = await signerPool(owner);
  chain = new FakeChain();
  env = custodyEnv(pool, chain, { SIGNER_COLD_ADDRESSES: TEST_COLD });
});
afterAll(async () => {
  await pool.end();
  await t.close();
  await owner.end();
});

const tick = () => {
  clock.advance(31 * 60_000);
  return advanceTreasury(deps, env);
};
const lines = async (id: string) =>
  (
    await owner.query<{ account: string; amount: string }>(
      `select a.kind as account, e.amount::text from ledger_journals j join ledger_entries e on e.journal_id = j.id join ledger_accounts a on a.id = e.account_id
       where j.treasury_id = $1 and j.kind = 'treasury' order by e.id`,
      [id],
    )
  ).rows;

describe('treasury', () => {
  it('hot -> cold: proposed by one admin, approved by another, signed to the allowlisted cold address, booked on confirmation', async () => {
    await fundCustodialMerchant({ app, clock, deps, owner, custody }, 50n * E18);
    const a1 = await adminAgent(t, owner, 'operator');
    const a2 = await adminAgent(t, owner, 'superadmin');
    const body = { livemode: false, token: 'evm-local:usdt', direction: 'to_cold', amount: '20', reason: 'hot wallet above cap' };
    expect((await a1.agent.req('POST', B, body)).statusCode).toBe(403); // step-up
    const r = await a1.agent.req('POST', B, body, a1.stepUp());
    expect(r.statusCode).toBe(201);
    const x = r.json<{ id: string; status: string; cold_address: string }>();
    expect(x).toMatchObject({ status: 'pending_approval', cold_address: TEST_COLD });
    expect((await a1.agent.req('POST', `${B}/${x.id}/approve`, { reason: 'mine' }, a1.stepUp())).json().error.details.reason).toBe('second_approver_required');
    expect((await a2.agent.req('POST', `${B}/${x.id}/approve`, { reason: 'checked' }, a2.stepUp())).json()).toMatchObject({ status: 'approved' });

    chain.token.set(custody.hot.toLowerCase(), 1000n * E18);
    chain.native.set(custody.hot.toLowerCase(), E18);
    expect(await tick()).toMatchObject({ sent: 1 });
    await chain.mine(3);
    expect(await tick()).toMatchObject({ confirmed: 1 });
    expect(chain.token.get(TEST_COLD)).toBe(20n * E18);
    expect(await lines(x.id)).toEqual([
      { account: 'custody_cold', amount: (20n * E18).toString() },
      { account: 'custody_hot', amount: (-20n * E18).toString() },
    ]);
    expect((await a1.agent.req('GET', B)).json<{ data: { id: string; status: string }[] }>().data.find((d) => d.id === x.id)?.status).toBe('confirmed');
  });

  it('cold -> hot: a recorded refill is booked only after the chain shows exactly that transfer', async () => {
    const op = await adminAgent(t, owner, 'operator');
    const hash = chain.external(LOCAL_USDT, TEST_COLD, custody.hot, 7n * E18);
    const ok = (await op.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_hot', amount: '7', tx_hash: hash, reason: 'refill for payouts' }, op.stepUp())).json<{ id: string; status: string }>();
    expect(ok.status).toBe('sent');
    expect(await tick()).toMatchObject({ sent: 1 }); // 1 confirmation of 2
    await chain.mine();
    expect(await tick()).toMatchObject({ confirmed: 1 });
    expect(await lines(ok.id)).toEqual([
      { account: 'custody_hot', amount: (7n * E18).toString() },
      { account: 'custody_cold', amount: (-7n * E18).toString() },
    ]);
    // The same transaction cannot be recorded twice; a wrong amount is refused once checked on chain.
    expect((await op.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_hot', amount: '7', tx_hash: hash, reason: 'again' }, op.stepUp())).statusCode).toBe(409);
    const other = chain.external(LOCAL_USDT, TEST_COLD, custody.hot, 3n * E18);
    const wrong = (await op.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_hot', amount: '4', tx_hash: other, reason: 'typo' }, op.stepUp())).json<{ id: string }>();
    expect(await tick()).toMatchObject({ failed: 1 });
    expect((await owner.query('select status, last_error from treasury_transfers where id = $1', [wrong.id])).rows[0]).toEqual({ status: 'failed', last_error: 'not_a_matching_transfer' });
    // More than cold holds in the ledger is refused up front.
    expect((await op.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_hot', amount: '1000000', tx_hash: `0x${'1'.repeat(64)}`, reason: 'too much' }, op.stepUp())).statusCode).toBe(409);
  });

  it('refusals: more than the hot wallet holds, a cold address the signer does not allowlist, rejection, bad input', async () => {
    const a1 = await adminAgent(t, owner, 'operator');
    const a2 = await adminAgent(t, owner, 'operator');
    const big = await a1.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_cold', amount: '100000000000', reason: 'too much' }, a1.stepUp());
    expect(big.json().error.details.reason).toBe('insufficient_balance');
    expect((await a1.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_cold', amount: '0', reason: 'zero' }, a1.stepUp())).statusCode).toBe(400);
    expect((await a1.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_hot', amount: '1', reason: 'no hash' }, a1.stepUp())).statusCode).toBe(400);
    expect((await a1.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_cold', amount: '1', tx_hash: `0x${'2'.repeat(64)}`, reason: 'hash' }, a1.stepUp())).statusCode).toBe(400);

    const x = (await a1.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_cold', amount: '1', reason: 'small' }, a1.stepUp())).json<{ id: string }>();
    expect((await a2.agent.req('POST', `${B}/${x.id}/approve`, { reason: 'looks right' }, a2.stepUp())).json()).toMatchObject({ status: 'approved' });
    const strict = custodyEnv(pool, chain); // no SIGNER_COLD_ADDRESSES
    clock.advance(31 * 60_000);
    expect(await advanceTreasury(deps, strict)).toMatchObject({ failed: 1 });
    expect((await owner.query('select last_error from treasury_transfers where id = $1', [x.id])).rows[0]).toEqual({ last_error: 'cold_not_allowlisted' });

    const y = (await a1.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_cold', amount: '1', reason: 'not now' }, a1.stepUp())).json<{ id: string }>();
    expect((await a2.agent.req('POST', `${B}/${y.id}/reject`, { reason: 'no need' })).json()).toMatchObject({ status: 'rejected' });
    expect((await a2.agent.req('POST', `${B}/${y.id}/approve`, { reason: 'late' }, a2.stepUp())).statusCode).toBe(409);
    expect((await a2.agent.req('POST', `${B}/00000000-0000-7000-8000-000000000000/reject`, { reason: 'gone' })).statusCode).toBe(404);
    const auditor = await adminAgent(t, owner, 'auditor');
    expect((await auditor.agent.req('POST', B, { livemode: false, token: 'evm-local:usdt', direction: 'to_cold', amount: '1', reason: 'auditor tries' }, auditor.stepUp())).statusCode).toBe(403);
  });

  it('database guard: only between the active hot wallet and the registered cold wallet', async () => {
    const [admin] = (await owner.query<{ id: string }>('select id from admin_users limit 1')).rows;
    await expect(
      owner.query(
        `insert into treasury_transfers (id, livemode, chain_id, token_id, direction, amount, cold_address, hot_address, status, requested_by, reason)
         values (gen_random_uuid(), false, 'evm-local', 'evm-local:usdt', 'to_cold', 1, '0x000000000000000000000000000000000000dEaD', $1, 'pending_approval', $2, 'x')`,
        [custody.hot, admin?.id],
      ),
    ).rejects.toThrow(/registered cold wallet/);
  });

  it('hourly reconciliation compares the hot wallets on chain with the ledger', async () => {
    const hot = (issues: { check: string }[]) => issues.filter((i) => i.check.startsWith('hot_wallet')).map((i) => i.check);
    expect(hot(await reconcileLedger(deps, { chainTx: () => ({ ...chain.tx, tokenBalance: async () => 10n ** 40n }) }))).toEqual([]);
    expect(hot(await reconcileLedger(deps, { chainTx: () => ({ ...chain.tx, tokenBalance: async () => 0n }) }))).toEqual(['hot_wallet_shortfall']);
    const down = { ...chain.tx, tokenBalance: async (): Promise<bigint> => Promise.reject(new Error('rpc down')) };
    expect(hot(await reconcileLedger(deps, { chainTx: () => down }))).toEqual(['hot_wallet_unchecked']);
  });

  it('reconciliation stays clean', async () => {
    const issues = await reconcileLedger(deps);
    expect(issues.filter((i) => ['negative_custody', 'ledger_unbalanced'].includes(i.check))).toEqual([]);
  });
});
