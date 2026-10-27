import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { eq } from 'drizzle-orm';
import { withSystem } from '../../src/common/db.js';
import { payments, sweeps } from '../../src/db/schema.js';
import { advanceWithdrawals } from '../../src/modules/custody/payouts.js';
import type { SweeperEnv } from '../../src/modules/custody/sweeper.js';
import { transitionInvoice } from '../../src/modules/invoices/invoices.js';
import { postPayment, postSweep, settleIfSwept } from '../../src/modules/ledger/ledger.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import { FakeChain, custodyEnv, signerPool } from './custody-sim.js';
import { adminAgent, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool, totpNow } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true', WITHDRAWAL_TWO_PERSON_MIN: '100' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
const PAYOUT = '0x00000000000000000000000000000000000beef1';
const OTHER = '0x00000000000000000000000000000000000beef2';
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
  env = custodyEnv(pool, chain, { SIGNER_LIMITS: JSON.stringify({ 'evm-local:usdt': { per_tx: '50', per_day: '60' } }) });
});
afterAll(async () => {
  await pool.end();
  await t.close();
  await owner.end();
});

type M = Awaited<ReturnType<typeof merchantWithKey>>;
const tokenOf = (livemode: boolean) => (livemode ? 'evm-mainsim:usdt' : 'evm-local:usdt');
const chainOf = (livemode: boolean) => (livemode ? 'evm-mainsim' : 'evm-local');

let logIndex = 0;
/** Custodial merchant (no fee) whose mode-balance holds `amount` available (test shortcut: settled without a sweep). */
async function funded(amount: bigint, livemode = false): Promise<M> {
  const m = await merchantWithKey(app, clock, owner, { livemode, scopes: ['read', 'invoices:write', 'withdrawals:write'] });
  await owner.query("update merchants set custody_mode = 'custodial', fee_bps = 0 where id = $1", [m.merchantId]);
  const inv = (await m.api('POST', '/v1/invoices', { amount: '1', token: tokenOf(livemode) })).json<{ id: string; deposit_address: string }>();
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, '0xabcd', $8, '0x0000000000000000000000000000000000000001', $6, $7, 7, '0x01', now(), 2) returning id`,
    [m.merchantId, livemode, inv.id, chainOf(livemode), tokenOf(livemode), inv.deposit_address, amount.toString(), 3000 + logIndex++],
  );
  await withSystem(deps.db, async (tx) => {
    const [p] = await tx.update(payments).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(payments.id, r.rows[0]?.id ?? '')).returning();
    if (!p) throw new Error('payment missing');
    await postPayment(tx, p);
    await tx.execute(`update invoices set amount_received = ${amount.toString()} where id = '${inv.id}'`);
    for (const s of ['detected', 'confirming', amount >= E18 ? 'overpaid' : 'underpaid'] as const) await transitionInvoice(deps, tx, inv.id, s, 'test');
    if (amount < E18) await transitionInvoice(deps, tx, inv.id, 'paid', 'test');
    // Swept into the hot wallet the way the worker does it (the sweep path itself is covered in sweeps.test.ts).
    const [d] = (await tx.execute<{ id: string }>(`select deposit_address_id as id from invoices where id = '${inv.id}'`)).rows;
    const [s] = await tx
      .insert(sweeps)
      .values({ merchantId: m.merchantId, livemode, chainId: chainOf(livemode), tokenId: tokenOf(livemode), depositAddressId: d?.id ?? '', invoiceId: inv.id, fromAddress: inv.deposit_address, toAddress: livemode ? custody.liveHot : custody.hot, amount })
      .returning();
    await tx.update(sweeps).set({ status: 'sweep_sent', txHash: '0x01' }).where(eq(sweeps.id, s?.id ?? ''));
    const [done] = await tx.update(sweeps).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(sweeps.id, s?.id ?? '')).returning();
    if (!done) throw new Error('sweep missing');
    await postSweep(tx, done);
    expect(await settleIfSwept(deps, tx, inv.id)).toBe(true);
  });
  return m;
}

const step = () => {
  clock.advance(30_000);
  return {};
};
const code = (m: M) => ({ 'x-totp-code': totpNow(m.secret, clock()) });
async function payout(m: M, livemode: boolean, address = PAYOUT) {
  step();
  return m.agent.req('POST', '/v1/dashboard/withdrawals/payout-addresses', { livemode, address, label: 'treasury' }, code(m));
}
async function withdraw(m: M, livemode: boolean, amount: string) {
  step();
  return m.agent.req('POST', '/v1/dashboard/withdrawals/', { livemode, token: tokenOf(livemode), amount }, code(m));
}
const bal = async (m: M, livemode = false) =>
  (await m.agent.req('GET', `/v1/dashboard/balances/?livemode=${String(livemode)}`)).json<{ data: { token: string; available: string; withdrawing: string }[] }>().data.find((b) => b.token === tokenOf(livemode));
const tick = (m: M) => {
  clock.advance(31 * 60_000);
  return advanceWithdrawals(deps, env, { merchantId: m.merchantId });
};
const events = async (m: M) =>
  (await owner.query<{ type: string }>("select type from outbox_events where merchant_id = $1 and type like 'withdrawal.%' order by seq", [m.merchantId])).rows.map((r) => r.type);

describe('withdrawals: test mode end to end', () => {
  it('payout address, request (held at once), signer, broadcast, confirmations, done; balances and events follow', async () => {
    const m = await funded(30n * E18);
    expect((await withdraw(m, false, '5')).json().error.details.reason).toBe('no_payout_address');
    // A mixed-case address with a wrong checksum (a typo) is refused; the stored form is checksummed.
    expect((await payout(m, false, '0x00000000000000000000000000000000000bEEF1')).json().error.details).toMatchObject({ field: 'address' });
    expect((await payout(m, false)).json()).toMatchObject({ status: 'current', address: '0x00000000000000000000000000000000000bEEf1' });
    expect((await withdraw(m, false, '31')).json().error.details.reason).toBe('insufficient_balance');
    expect((await m.agent.req('POST', '/v1/dashboard/withdrawals/', { livemode: false, token: 'evm-local:usdt', amount: '5' })).statusCode).toBe(403); // no TOTP

    const r = await withdraw(m, false, '12.5');
    expect(r.statusCode).toBe(201);
    const w = r.json<{ id: string; status: string; approvals_required: number }>();
    expect(w).toMatchObject({ status: 'approved', approvals_required: 0 });
    expect(await bal(m)).toMatchObject({ available: '17.5', withdrawing: '12.5' });

    chain.token.set(custody.hot.toLowerCase(), 100n * E18);
    chain.native.set(custody.hot.toLowerCase(), E18);
    expect(await tick(m)).toEqual({ sent: 1 });
    await chain.mine();
    expect(await tick(m)).toEqual({ sent: 1 }); // 1 of 2 confirmations
    await chain.mine();
    expect(await tick(m)).toEqual({ confirmed: 1 });
    expect(chain.token.get(PAYOUT.toLowerCase())).toBe(125n * 10n ** 17n);
    expect(await bal(m)).toMatchObject({ available: '17.5', withdrawing: '0' });
    expect((await m.api('GET', `/v1/withdrawals/${w.id}`)).json()).toMatchObject({ status: 'confirmed', tx_hash: expect.stringMatching(/^0x/) as unknown });
    expect(await events(m)).toEqual(['withdrawal.approved', 'withdrawal.sent', 'withdrawal.confirmed']);
    const ev = (await m.api('GET', '/v1/events?type=withdrawal.confirmed')).json<{ data: { data: { amount: string } }[] }>();
    expect(ev.data[0]?.data.amount).toBe('12.5');
  });

  it('API key withdrawals are idempotent; signer limits make big ones wait, a paused signer too', async () => {
    const m = await funded(100n * E18);
    await payout(m, false);
    const k = { 'idempotency-key': 'payout-1' };
    const a = await m.api('POST', '/v1/withdrawals', { token: 'evm-local:usdt', amount: '55' }, k);
    expect(a.statusCode).toBe(201);
    const again = await m.api('POST', '/v1/withdrawals', { token: 'evm-local:usdt', amount: '55' }, k);
    expect(again.json<{ id: string }>().id).toBe(a.json<{ id: string }>().id);
    expect(await bal(m)).toMatchObject({ available: '45', withdrawing: '55' });
    chain.token.set(custody.hot.toLowerCase(), 1000n * E18);
    chain.native.set(custody.hot.toLowerCase(), E18);
    expect(await tick(m)).toEqual({ approved: 1 }); // 55 > per_tx 50: waits, not failed
    const row = await owner.query<{ status: string; last_error: string }>('select status, last_error from withdrawals where id = $1', [a.json<{ id: string }>().id]);
    expect(row.rows[0]).toEqual({ status: 'approved', last_error: 'over_limit' });

    // SIGNER_PAUSED (this signer only), not the global admin switch other test files would see.
    const b = await m.api('POST', '/v1/withdrawals', { token: 'evm-local:usdt', amount: '1' });
    expect(b.statusCode).toBe(201);
    clock.advance(31 * 60_000);
    await advanceWithdrawals(deps, custodyEnv(pool, chain, { SIGNER_PAUSED: 'true' }), { merchantId: m.merchantId });
    expect((await owner.query('select last_error from withdrawals where id = $1', [b.json<{ id: string }>().id])).rows[0]).toEqual({ last_error: 'paused' });
    // read-only keys cannot withdraw
    const ro = await m.mintKey(['read']);
    expect((await m.api('POST', '/v1/withdrawals', { token: 'evm-local:usdt', amount: '1' }, {}, ro)).statusCode).toBe(403);
  });

  it('a payout address changed after the request: the signer refuses, the withdrawal fails and the hold is released', async () => {
    const m = await funded(10n * E18);
    await payout(m, false);
    const w = (await withdraw(m, false, '4')).json<{ id: string }>();
    await payout(m, false, OTHER); // test mode: active at once, supersedes the first
    chain.token.set(custody.hot.toLowerCase(), 1000n * E18);
    expect(await tick(m)).toEqual({ failed: 1 });
    expect((await owner.query('select status, last_error from withdrawals where id = $1', [w.id])).rows[0]).toEqual({ status: 'failed', last_error: 'payout_address_changed' });
    expect(await bal(m)).toMatchObject({ available: '10', withdrawing: '0' });
  });

  it('a reverted payout fails and is released', async () => {
    const m = await funded(10n * E18);
    await payout(m, false);
    await withdraw(m, false, '3');
    chain.token.set(custody.hot.toLowerCase(), 1000n * E18);
    await tick(m);
    chain.revertNextSweep = true; // the next token transfer reverts
    await chain.mine();
    expect(await tick(m)).toEqual({ failed: 1 });
    expect(await bal(m)).toMatchObject({ available: '10', withdrawing: '0' });
  });
});

describe('withdrawals: live mode controls', () => {
  it('a new live payout address waits 24 h (owners emailed) and can be cancelled meanwhile', async () => {
    const m = await funded(5n * E18, true);
    const a = await payout(m, true);
    expect(a.json()).toMatchObject({ status: 'pending' });
    expect((await withdraw(m, true, '1')).json().error.details.reason).toBe('no_payout_address');
    const mail = await owner.query("select count(*)::int as n from email_outbox where merchant_id = $1 and kind = 'payout_address_added'", [m.merchantId]);
    expect(mail.rows[0]).toEqual({ n: 1 });
    expect((await m.agent.req('POST', `/v1/dashboard/withdrawals/payout-addresses/${a.json<{ id: string }>().id}/cancel`)).json()).toMatchObject({ status: 'cancelled' });
  });

  /** Live merchant with an active payout address (backdated: the 24 h wait is covered above). */
  async function liveReady(amount: bigint) {
    const m = await funded(amount, true);
    await owner.query(
      `insert into payout_addresses (id, merchant_id, livemode, family, address, created_by, activates_at) values (gen_random_uuid(), $1, true, 'evm', $2, $3, now() - interval '1 day')`,
      [m.merchantId, PAYOUT, m.userId],
    );
    return m;
  }

  it('one admin approves below the threshold; at or above it two different admins must', async () => {
    const m = await liveReady(500n * E18);
    const small = (await withdraw(m, true, '50')).json<{ id: string; status: string; approvals_required: number }>();
    expect(small).toMatchObject({ status: 'pending_approval', approvals_required: 1 });
    const big = (await withdraw(m, true, '100')).json<{ id: string; approvals_required: number }>();
    expect(big.approvals_required).toBe(2);
    expect(await bal(m, true)).toMatchObject({ available: '350', withdrawing: '150' });

    const a1 = await adminAgent(t, owner, 'operator');
    const a2 = await adminAgent(t, owner, 'superadmin');
    const auditor = await adminAgent(t, owner, 'auditor');
    const B = '/admin/v1/withdrawals';
    expect((await a1.agent.req('GET', `${B}/?merchant_id=${m.merchantId}`)).json<{ data: unknown[] }>().data).toHaveLength(2);
    expect((await auditor.agent.req('POST', `${B}/${small.id}/approve`, { reason: 'looks fine' }, auditor.stepUp())).statusCode).toBe(403);
    expect((await a1.agent.req('POST', `${B}/${small.id}/approve`, { reason: 'looks fine' })).statusCode).toBe(403); // step-up
    expect((await a1.agent.req('POST', `${B}/${small.id}/approve`, { reason: 'looks fine' }, a1.stepUp())).json()).toMatchObject({ status: 'approved' });

    expect((await a1.agent.req('POST', `${B}/${big.id}/approve`, { reason: 'first check' }, a1.stepUp())).json()).toMatchObject({ status: 'pending_approval', approvals: 1 });
    const same = await a1.agent.req('POST', `${B}/${big.id}/approve`, { reason: 'again' }, a1.stepUp());
    expect(same.json().error.details.reason).toBe('second_approver_required');
    expect((await a2.agent.req('POST', `${B}/${big.id}/approve`, { reason: 'second check' }, a2.stepUp())).json()).toMatchObject({ status: 'approved', approvals: 2 });
    const audit = await owner.query("select count(*)::int as n from audit_logs where target_id = $1 and action = 'withdrawal.approved'", [big.id]);
    expect(audit.rows[0]).toEqual({ n: 2 });
  });

  it('rejecting or cancelling releases the hold; frozen or non-custodial accounts cannot withdraw', async () => {
    const m = await liveReady(20n * E18);
    const a = (await withdraw(m, true, '5')).json<{ id: string }>();
    const b = (await withdraw(m, true, '6')).json<{ id: string }>();
    const op = await adminAgent(t, owner, 'operator');
    expect((await op.agent.req('POST', `/admin/v1/withdrawals/${a.id}/reject`, { reason: 'unusual destination' })).json()).toMatchObject({ status: 'rejected', reason: 'unusual destination' });
    expect((await m.agent.req('POST', `/v1/dashboard/withdrawals/${b.id}/cancel`)).json()).toMatchObject({ status: 'cancelled' });
    expect((await m.agent.req('POST', `/v1/dashboard/withdrawals/${b.id}/cancel`)).statusCode).toBe(409);
    expect(await bal(m, true)).toMatchObject({ available: '20', withdrawing: '0' });

    await owner.query("update merchants set risk_flags = '{payouts_frozen}' where id = $1", [m.merchantId]);
    expect((await withdraw(m, true, '1')).json().error.details.reason).toBe('payouts_frozen');
    const nc = await merchantWithKey(app, clock, owner);
    step();
    expect((await nc.agent.req('POST', '/v1/dashboard/withdrawals/', { livemode: false, token: 'evm-local:usdt', amount: '1' }, { 'x-totp-code': totpNow(nc.secret, clock()) })).statusCode).toBe(403);
  });

  it('database guards: only to the current address, approvals only grow once per admin, final states are final', async () => {
    const m = await liveReady(10n * E18);
    const w = (await withdraw(m, true, '2')).json<{ id: string }>();
    await expect(owner.query("update withdrawals set to_address = $2 where id = $1", [w.id, OTHER])).rejects.toThrow(/immutable/);
    await expect(owner.query("update withdrawals set status = 'approved' where id = $1", [w.id])).rejects.toThrow(/illegal withdrawal transition/);
    const id = '00000000-0000-7000-8000-00000000abcd';
    await expect(owner.query('update withdrawals set approved_by = array[$2::uuid, $2::uuid] where id = $1', [w.id, id])).rejects.toThrow(/approval|withdrawals_approvals/);
    await expect(
      owner.query(
        `insert into withdrawals (id, merchant_id, livemode, chain_id, token_id, amount, payout_address_id, to_address, status, approvals_required, requested_by)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, 1, payout_address_id, $2, 'pending_approval', 1, 'x' from withdrawals where id = $1`,
        [w.id, OTHER],
      ),
    ).rejects.toThrow(/current payout address/);
  });

  it('reconciliation stays clean', async () => {
    const issues = await reconcileLedger(deps);
    expect(issues.filter((i) => ['negative_merchant_balance', 'negative_custody', 'ledger_unbalanced', 'withdrawal_journal'].includes(i.check))).toEqual([]);
  });
});

describe('withdrawals: refusals and recovery', () => {
  it('payout addresses: listed with their status; an active one cannot be cancelled', async () => {
    const m = await funded(1n * E18);
    const a = (await payout(m, false)).json<{ id: string }>();
    await payout(m, false, OTHER);
    const list = (await m.agent.req('GET', '/v1/dashboard/withdrawals/payout-addresses?livemode=false')).json<{ data: { id: string; status: string }[] }>().data;
    expect(list.map((x) => x.status)).toEqual(['current', 'superseded']);
    expect((await m.agent.req('POST', `/v1/dashboard/withdrawals/payout-addresses/${a.id}/cancel`)).statusCode).toBe(409);
    expect((await m.agent.req('GET', '/v1/dashboard/withdrawals/?livemode=false')).json()).toMatchObject({ data: [], has_more: false });
  });

  it('requests: a suspended account or a zero amount is refused', async () => {
    const m = await funded(5n * E18);
    await payout(m, false);
    expect((await withdraw(m, false, '0')).json().error.code).toBe('invalid_amount');
    await owner.query("update merchants set status = 'suspended' where id = $1", [m.merchantId]);
    expect((await withdraw(m, false, '1')).statusCode).toBe(403);
  });

  it('admin decisions only on pending withdrawals', async () => {
    const m = await funded(5n * E18, true);
    await owner.query(
      `insert into payout_addresses (id, merchant_id, livemode, family, address, created_by, activates_at) values (gen_random_uuid(), $1, true, 'evm', $2, $3, now() - interval '1 day')`,
      [m.merchantId, PAYOUT, m.userId],
    );
    const w = (await withdraw(m, true, '1')).json<{ id: string }>();
    const op = await adminAgent(t, owner, 'operator');
    const B = '/admin/v1/withdrawals';
    expect((await op.agent.req('POST', `${B}/00000000-0000-7000-8000-000000000000/approve`, { reason: 'checked' }, op.stepUp())).statusCode).toBe(404);
    expect((await op.agent.req('POST', `${B}/${w.id}/approve`, { reason: 'checked' }, op.stepUp())).json()).toMatchObject({ status: 'approved' });
    expect((await op.agent.req('POST', `${B}/${w.id}/approve`, { reason: 'again' }, op.stepUp())).statusCode).toBe(409);
    expect((await op.agent.req('POST', `${B}/${w.id}/reject`, { reason: 'too late' })).statusCode).toBe(409);
    expect((await m.agent.req('POST', `/v1/dashboard/withdrawals/${w.id}/cancel`)).statusCode).toBe(409);
    // The signer refuses a withdrawal that is not approved (or does not exist).
    const p = (await withdraw(m, true, '1')).json<{ id: string }>();
    expect(await env.signer.sign('withdrawal', p.id)).toMatchObject({ ok: false, code: 'wrong_status' });
    expect(await env.signer.sign('withdrawal', '00000000-0000-7000-8000-000000000000')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('suspended or frozen after the request: the signer refuses, the withdrawal fails and is released', async () => {
    chain.token.set(custody.hot.toLowerCase(), 1000n * E18);
    chain.native.set(custody.hot.toLowerCase(), E18);
    for (const [change, code] of [
      ["update merchants set status = 'suspended' where id = $1", 'merchant_inactive'],
      ["update merchants set risk_flags = '{payouts_frozen}' where id = $1", 'payouts_frozen'],
    ] as const) {
      const m = await funded(5n * E18);
      await payout(m, false);
      await withdraw(m, false, '2');
      await owner.query(change, [m.merchantId]);
      expect(await tick(m)).toEqual({ failed: 1 });
      expect((await owner.query('select status, last_error from withdrawals where merchant_id = $1', [m.merchantId])).rows[0]).toEqual({ status: 'failed', last_error: code });
      expect(await bal(m)).toMatchObject({ available: '5', withdrawing: '0' });
    }
  });

  it('waits (never fails) while the hot wallet is short of tokens or gas, without limits, or over the daily limit', async () => {
    const m = await funded(100n * E18);
    await payout(m, false);
    const last = async () => (await owner.query<{ last_error: string }>('select last_error from withdrawals where merchant_id = $1 order by created_at desc limit 1', [m.merchantId])).rows[0]?.last_error;
    await withdraw(m, false, '40');
    chain.token.set(custody.hot.toLowerCase(), 1n * E18);
    expect(await tick(m)).toEqual({ approved: 1 });
    expect(await last()).toBe('insufficient_funds');
    chain.token.set(custody.hot.toLowerCase(), 1000n * E18);
    chain.native.set(custody.hot.toLowerCase(), 0n);
    expect(await tick(m)).toEqual({ approved: 1 });
    expect(await last()).toBe('needs_gas');
    chain.native.set(custody.hot.toLowerCase(), E18);
    clock.advance(31 * 60_000);
    expect(await advanceWithdrawals(deps, custodyEnv(pool, chain), { merchantId: m.merchantId })).toEqual({ approved: 1 }); // no SIGNER_LIMITS
    expect(await last()).toBe('no_limits');
    // 40 goes out; the next 30 would pass the per-transaction limit but not the 24 h one (60) together with the
    // 40 and any earlier payouts of this token in this file.
    expect(await tick(m)).toEqual({ sent: 1 });
    await withdraw(m, false, '30');
    expect(await tick(m)).toEqual({ approved: 1, sent: 1 });
    expect(await last()).toBe('over_limit');
  });

  it('rebroadcasts an unmined payout; a broadcast error keeps it approved and retries', async () => {
    const m = await funded(10n * E18);
    await payout(m, false);
    await withdraw(m, false, '1');
    chain.failNextSend = true;
    expect(await tick(m)).toEqual({ error: 1 });
    const id = (await owner.query<{ id: string }>('select id from withdrawals where merchant_id = $1', [m.merchantId])).rows[0]?.id ?? '';
    // The signature exists (asking again returns it), so the retry broadcasts the same transaction.
    const r = await tick(m);
    expect(r.sent ?? 0).toBe(1);
    const before = chain.broadcasts;
    expect(await tick(m)).toEqual({ sent: 1 }); // not mined yet: same bytes again
    expect(chain.broadcasts).toBe(before + 1);
    expect((await owner.query('select status from withdrawals where id = $1', [id])).rows[0]).toEqual({ status: 'sent' });
  });

  it('the unscoped worker run (production path) works', async () => {
    clock.advance(31 * 60_000);
    const r = await advanceWithdrawals(deps, env);
    expect(r.error ?? 0).toBe(0);
  });
});
