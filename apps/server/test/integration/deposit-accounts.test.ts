// Permanent deposit addresses per user (D-101), on Anvil with the real scanner and the real forwarder contract: one
// address per user and token; every transfer to it is a deposit invoice; xpub deposits settle with their fee,
// custodial ones once swept (one sweep per address, allocated oldest first), forwarder ones once an uncapped forwarder
// flushed them (one flush per address, oldest first). The project credits its user from `invoice.settled`.
import type { TokenConfig } from '@gw/core';
import { FORWARDER_FACTORY_ABI, FORWARDER_FACTORY_BYTECODE, createEvmAdapter } from '@gw/chains';
import { eq } from 'drizzle-orm';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { viemRpc } from '../../../signer/src/chain.js';
import { loadSignerConfig } from '../../../signer/src/config.js';
import { Keyring } from '../../../signer/src/keys.js';
import { Refusal, createSigner } from '../../../signer/src/signer.js';
import { MOCK_ABI, anvilAccount, anvilClients, deploy, localChain, mineBlocks } from '../../../../packages/chains/test/support/anvil.js';
import { withSystem } from '../../src/common/db.js';
import { sweeps } from '../../src/db/schema.js';
import { viemChainTx } from '../../src/modules/custody/chain-tx.js';
import { advanceForwards, planForwards, type ForwarderEnv } from '../../src/modules/custody/forwarder.js';
import type { SignerClient } from '../../src/modules/custody/signer-client.js';
import { planSweeps } from '../../src/modules/custody/sweeper.js';
import { postSweep, settleIfSwept } from '../../src/modules/ledger/ledger.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import { becomeLeader, scanTick } from '../../src/modules/watcher/scanner.js';
import { signerPool, withSwitchLock } from './custody-sim.js';
import { TEST_MNEMONIC, buildTestApp, ensurePlatformCustody, merchantWithKey, ownerPool, totpNow } from './helpers.js';

const anvilUrl = inject('anvilUrl');
const t = buildTestApp({ FEATURE_CUSTODIAL: 'true', FEATURE_FORWARDER: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
// Own Anvil account (beyond the 10 funded ones others use; funded in beforeAll) and chain: test files run in parallel
// against one node.
const payer = anvilAccount(11);
const { pub, wallet } = anvilClients(anvilUrl, payer);
const CHAIN = 'evm-dep';
const TOKEN = 'evm-dep:susdt';
const WALLET_A = '0x00000000000000000000000000000000000BeEA1';
const WALLET_B = '0x00000000000000000000000000000000000BEEb2';
const E18 = 10n ** 18n;
const UNCAPPED = 2n ** 256n - 1n;

type M = Awaited<ReturnType<typeof merchantWithKey>>;
type Account = { id: string; object: string; address: string; custody_mode: string; customer_ref: string; received: string; retired_at: string | null };
type Inv = { id: string; status: string; kind: string; customer_ref: string; amount: string; deposit_account_id: string };

let token: Address;
let tokenCfg: TokenConfig;
let signerDb: Awaited<ReturnType<typeof signerPool>>;
let env: ForwarderEnv;
let scan: () => Promise<unknown>;

const balance = (who: string) => pub.readContract({ address: token, abi: MOCK_ABI, functionName: 'balanceOf', args: [who as Address] }) as Promise<bigint>;
const pay = async (to: string, amount: bigint) =>
  pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'transfer', args: [to as Address, amount] }) });
async function confirmPayments() {
  await scan();
  await mineBlocks(anvilUrl, 3);
  await scan();
}
const code = (m: M) => {
  clock.advance(30_000);
  return { 'x-totp-code': totpNow(m.secret, clock()) };
};
const open = (m: M, customerRef: string, key?: string) => m.api('POST', '/v1/deposit-accounts', { customer_ref: customerRef, token: TOKEN }, {}, key);
const deposits = async (accountId: string) =>
  (await owner.query<{ id: string; status: string; amount: string; fee: string | null }>(
    `select id, status::text status, amount_expected::text amount, fee_amount::text fee from invoices where deposit_account_id = $1 order by created_at, id`,
    [accountId],
  )).rows;

function signerClient(): SignerClient {
  const config = loadSignerConfig({ SIGNER_DATABASE_URL: 'postgres://unused@localhost/db', SIGNER_HMAC_SECRET: 'h'.repeat(32), SIGNER_SEED_FILE: '/unused', SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64') });
  const signer = createSigner({ pool: signerDb, keyring: Keyring.fromMnemonic(TEST_MNEMONIC), config, rpcFor: () => viemRpc([anvilUrl]) });
  return {
    sign: async (kind, id) => {
      try {
        return { ok: true, tx: await withSwitchLock(signerDb, 'shared', () => signer.sign({ kind, id })) };
      } catch (err) {
        if (err instanceof Refusal) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    },
  };
}

async function forwardAll(merchantId: string) {
  await planForwards(deps, env, { merchantId });
  for (let i = 0; i < 6; i++) {
    await advanceForwards(deps, env, { merchantId });
    const openF = await owner.query(`select 1 from forwards where merchant_id = $1 and status in ('pending', 'sent')`, [merchantId]);
    if (openF.rowCount === 0) break;
    await mineBlocks(anvilUrl, 2);
    await owner.query(`update forwards set next_attempt_at = now() - interval '1 second' where merchant_id = $1 and status in ('pending', 'sent')`, [merchantId]);
  }
}

/** A sweep of `amount` from the account's address, confirmed and booked the way the custody worker does it. */
async function sweptConfirmed(sweepId: string) {
  await withSystem(deps.db, async (tx) => {
    await tx.update(sweeps).set({ status: 'sweep_sent', txHash: '0x01' }).where(eq(sweeps.id, sweepId));
    const [done] = await tx.update(sweeps).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(sweeps.id, sweepId)).returning();
    if (!done) throw new Error('sweep missing');
    await postSweep(tx, done);
    await settleIfSwept(deps, tx, done.invoiceId);
  });
}

beforeAll(async () => {
  await app.ready();
  await ensurePlatformCustody(owner);
  signerDb = await signerPool(owner);
  await pub.request({ method: 'anvil_setBalance' as never, params: [payer.address, `0x${(100n * E18).toString(16)}`] as never });
  const h = await wallet.deployContract({ abi: FORWARDER_FACTORY_ABI, bytecode: FORWARDER_FACTORY_BYTECODE, args: [] });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (!r.contractAddress) throw new Error('factory deploy failed');
  const factory = r.contractAddress;
  token = await deploy(anvilUrl, 'MockERC20', ['sastaUSDT', 'sastaUSDT', 18], payer);
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'mint', args: [payer.address, 1_000_000n * E18] }) });
  await owner.query(
    `insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations, reorg_depth, finality, testnet, enabled, forwarder_factory)
     values ($1, 'evm', 'Anvil deposits', 31337, '{}', 'ETH', 18, 1000, 2, 16, 'confirmations', true, true, $2)`,
    [CHAIN, factory],
  );
  await owner.query(
    `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
     values ($1, $2, 'sastaUSDT', 'sastaUSDT', $3, 18, 2, 10000000000000000, true)`,
    [TOKEN, CHAIN, token],
  );
  const gas = Keyring.fromMnemonic(TEST_MNEMONIC).address("m/44'/60'/21'/0/0");
  await pub.request({ method: 'anvil_setBalance' as never, params: [gas, `0x${(10n * E18).toString(16)}`] as never });
  const cfg = localChain(anvilUrl, { id: CHAIN, reorgDepth: 16, finality: 'confirmations', forwarderFactory: factory });
  tokenCfg = { id: TOKEN, chainId: CHAIN, symbol: 'sastaUSDT', name: 'sastaUSDT', contractAddress: token, decimals: 18, minConfirmations: 2, confirmationTiers: [], minAmount: 10n ** 16n, enabled: true };
  const adapter = createEvmAdapter(cfg, [anvilUrl]);
  const epoch = await becomeLeader(deps, adapter, cfg);
  scan = () => scanTick({ deps, adapter, chain: cfg, tokens: [tokenCfg], epoch });
  env = { signer: signerClient(), chainTx: () => viemChainTx([anvilUrl]) };
});

afterAll(async () => {
  await t.close();
  await signerDb.end();
  await owner.end();
});

describe('deposit accounts (D-101)', () => {
  it('one permanent address per user and token, the same on every call; listed; scoped keys; database guards', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const a = await open(m, 'user-1');
    expect(a.statusCode).toBe(201);
    const acc = a.json<Account>();
    expect(acc).toMatchObject({ object: 'deposit_account', customer_ref: 'user-1', custody_mode: 'non_custodial_xpub', received: '0', retired_at: null });
    const again = await open(m, 'user-1');
    expect(again.statusCode).toBe(200);
    expect(again.json<Account>()).toMatchObject({ id: acc.id, address: acc.address });
    const other = (await open(m, 'user-2')).json<Account>();
    expect(other.address).not.toBe(acc.address);
    expect((await m.api('GET', '/v1/deposit-accounts?customer_ref=user-1')).json<{ data: Account[] }>().data.map((x) => x.id)).toEqual([acc.id]);
    expect((await m.api('GET', `/v1/deposit-accounts/${acc.id}`)).json()).toMatchObject({ id: acc.id, deposits: [] });
    expect((await m.agent.req('GET', '/v1/dashboard/deposit-accounts/?livemode=false')).json<{ data: Account[] }>().data).toHaveLength(2);
    expect((await m.api('POST', '/v1/deposit-accounts', { customer_ref: 'u', token: 'evm-dep:nope' })).statusCode).toBe(400);
    expect((await open(m, 'user-3', await m.mintKey(['read']))).statusCode).toBe(403);
    const audit = await owner.query("select 1 from audit_logs where action = 'deposit_account.created' and merchant_id = $1", [m.merchantId]);
    expect(audit.rowCount).toBe(2);

    await expect(owner.query("update deposit_accounts set customer_ref = 'x' where id = $1", [acc.id])).rejects.toThrow(/immutable/);
    // An account's address takes deposits only: no ordinary invoice may use it.
    await expect(
      owner.query(
        `insert into invoices (id, merchant_id, livemode, chain_id, token_id, amount_expected, deposit_address_id, deposit_address, custody_mode, underpay_tolerance_bps, expires_at)
         select gen_random_uuid(), merchant_id, livemode, chain_id, token_id, 1, deposit_address_id, $2, custody_mode, 0, now() + interval '1 hour' from deposit_accounts where id = $1`,
        [acc.id, acc.address],
      ),
    ).rejects.toThrow(/takes deposits only/);
  });

  it('pages through accounts; unknown ids are 404; a custody-mode change gives the user a new address', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const first = (await open(m, 'page-1')).json<Account>();
    const second = (await open(m, 'page-2')).json<Account>();
    const p1 = (await m.api('GET', '/v1/deposit-accounts?limit=1')).json<{ data: Account[]; has_more: boolean; next_cursor: string }>();
    expect(p1).toMatchObject({ has_more: true, next_cursor: second.id });
    expect(p1.data.map((x) => x.id)).toEqual([second.id]);
    const p2 = (await m.api('GET', `/v1/deposit-accounts?limit=1&starting_after=${p1.next_cursor}`)).json<{ data: Account[]; has_more: boolean; next_cursor: string | null }>();
    expect(p2).toMatchObject({ has_more: false, next_cursor: null });
    expect(p2.data.map((x) => x.id)).toEqual([first.id]);
    expect((await m.api('GET', '/v1/deposit-accounts?customer_ref=nobody')).json()).toEqual({ data: [], has_more: false, next_cursor: null });
    expect((await m.api('GET', '/v1/deposit-accounts/00000000-0000-7000-8000-000000000001')).statusCode).toBe(404);
    // Custody switched on (test mode): the user gets a custodial address; the xpub one is retired (still watched).
    await owner.query("update merchants set custody_mode = 'custodial' where id = $1", [m.merchantId]);
    const moved = await open(m, 'page-1');
    expect(moved.statusCode).toBe(201);
    expect(moved.json<Account>()).toMatchObject({ custody_mode: 'custodial', retired_at: null });
    const old = (await m.api('GET', `/v1/deposit-accounts/${first.id}`)).json<Account>();
    expect(old.retired_at).not.toBeNull();
  });

  it('xpub: each transfer is its own deposit invoice, settled with its fee; the events name the user; a rescan adds nothing', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const acc = (await open(m, 'player-9')).json<Account>();
    await pay(acc.address, 10n * E18);
    await pay(acc.address, 5n * E18);
    await confirmPayments();
    const d = await deposits(acc.id);
    expect(d).toEqual([
      { id: expect.any(String) as unknown, status: 'settled', amount: String(10n * E18), fee: String(E18 / 10n) },
      { id: expect.any(String) as unknown, status: 'settled', amount: String(5n * E18), fee: String(E18 / 20n) },
    ]);
    const inv = (await m.api('GET', `/v1/invoices/${d[0]?.id ?? ''}`)).json<Inv & { checkout_url: string | null }>();
    expect(inv).toMatchObject({ kind: 'deposit', customer_ref: 'player-9', deposit_account_id: acc.id, amount: '10', checkout_url: null });
    const ev = await owner.query<{ data: { customer_ref: string; kind: string } }>("select data from outbox_events where invoice_id = $1 and type = 'invoice.settled'", [d[0]?.id]);
    expect(ev.rows[0]?.data).toMatchObject({ customer_ref: 'player-9', kind: 'deposit', deposit_account_id: acc.id });
    await scan(); // the rescan window covers these blocks again
    expect(await deposits(acc.id)).toHaveLength(2);
    expect((await m.api('GET', `/v1/deposit-accounts/${acc.id}`)).json()).toMatchObject({ received: '15', deposits: [{ amount: '5' }, { amount: '10' }] });
  });

  it('custodial: one sweep per address; deposits settle oldest first as sweeps cover them; balance credited minus fees', async () => {
    const m = await merchantWithKey(app, clock, owner);
    await owner.query("update merchants set custody_mode = 'custodial', fee_bps = 100, fee_fixed = 0 where id = $1", [m.merchantId]);
    const acc = (await open(m, 'trader-1')).json<Account>();
    expect(acc.custody_mode).toBe('custodial');
    await pay(acc.address, 10n * E18);
    await pay(acc.address, 5n * E18);
    await confirmPayments();
    expect((await deposits(acc.id)).map((x) => x.status)).toEqual(['paid', 'paid']); // waiting for the sweep
    expect((await m.api('GET', `/v1/deposit-accounts/${acc.id}`)).json()).toMatchObject({ received: '15', deposits: [{ fee: null }, { fee: null }] });
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(1);
    const s = await owner.query<{ id: string; amount: string }>('select id, amount::text from sweeps where merchant_id = $1', [m.merchantId]);
    expect(s.rows.map((r) => r.amount)).toEqual([String(15n * E18)]); // both deposits in one sweep

    // A sweep covering only the first deposit settles only that one (oldest first).
    await owner.query('update sweeps set status = $2 where id = $1', [s.rows[0]?.id, 'failed']);
    const part = await withSystem(deps.db, async (tx) => {
      const [x] = await tx.select().from(sweeps).where(eq(sweeps.id, s.rows[0]?.id ?? ''));
      if (!x) throw new Error('sweep missing');
      const [n] = await tx.insert(sweeps).values({ merchantId: x.merchantId, livemode: false, chainId: CHAIN, tokenId: TOKEN, depositAddressId: x.depositAddressId, invoiceId: x.invoiceId, fromAddress: x.fromAddress, toAddress: x.toAddress, amount: 10n * E18 }).returning();
      if (!n) throw new Error('sweep insert failed');
      return n;
    });
    await sweptConfirmed(part.id);
    expect((await deposits(acc.id)).map((x) => x.status)).toEqual(['settled', 'paid']);
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(1);
    const rest = await owner.query<{ id: string; amount: string }>("select id, amount::text from sweeps where merchant_id = $1 and status = 'pending'", [m.merchantId]);
    expect(rest.rows[0]?.amount).toBe(String(5n * E18));
    await sweptConfirmed(rest.rows[0]?.id ?? '');
    expect((await deposits(acc.id)).map((x) => [x.status, x.fee])).toEqual([['settled', String(E18 / 10n)], ['settled', String(E18 / 20n)]]);
    const bal = (await m.api('GET', '/v1/balances')).json<{ data: { token: string; available: string; pending: string }[] }>().data.find((b) => b.token === TOKEN);
    expect(bal).toMatchObject({ available: '14.85', pending: '0' });
    const issues = (await reconcileLedger(deps)).filter((i) => ['custodial_received', 'custodial_settlement', 'sweep_journal', 'negative_merchant_balance'].includes(i.check));
    expect(issues).toEqual([]);
  });

  it('forwarder: an uncapped permanent forwarder pays the merchant on every deposit; a new payout address gets a new user address', async () => {
    const m = await merchantWithKey(app, clock, owner);
    expect((await m.agent.req('PUT', '/v1/dashboard/settings/receiving-mode', { mode: 'non_custodial_forwarder' }, code(m))).statusCode).toBe(200);
    expect((await m.agent.req('POST', '/v1/dashboard/withdrawals/payout-addresses', { livemode: false, address: WALLET_A }, code(m))).statusCode).toBe(201);
    const acc = (await open(m, 'gamer-3')).json<Account>();
    expect(acc.custody_mode).toBe('non_custodial_forwarder');
    const cap = await owner.query<{ fee_cap: string }>('select fee_cap::text from forwarder_params p join deposit_accounts a on a.deposit_address_id = p.deposit_address_id where a.id = $1', [acc.id]);
    expect(cap.rows[0]?.fee_cap).toBe(UNCAPPED.toString());

    const a0 = await balance(WALLET_A);
    await pay(acc.address, 100n * E18);
    await confirmPayments();
    await forwardAll(m.merchantId);
    expect((await balance(WALLET_A)) - a0).toBe(99n * E18);
    // Two more deposits flushed together: both settle, each with its own 1% (no cap on a permanent address).
    await pay(acc.address, 50n * E18);
    await pay(acc.address, 30n * E18);
    await confirmPayments();
    await forwardAll(m.merchantId);
    expect((await balance(WALLET_A)) - a0).toBe(99n * E18 + 792n * 10n ** 17n);
    expect(await balance(acc.address)).toBe(0n);
    expect((await deposits(acc.id)).map((x) => [x.status, x.fee])).toEqual([
      ['settled', String(E18)],
      ['settled', String(E18 / 2n)],
      ['settled', String((3n * E18) / 10n)],
    ]);
    const issues = (await reconcileLedger(deps)).filter((i) => ['received_balance', 'forward_fee_journal', 'unforwarded'].includes(i.check));
    expect(issues).toEqual([]);

    // The merchant changes its wallet: the user gets a new address paying it; the old one is retired, still watched,
    // and keeps paying the wallet it was made for (the contract cannot change).
    expect((await m.agent.req('POST', '/v1/dashboard/withdrawals/payout-addresses', { livemode: false, address: WALLET_B }, code(m))).statusCode).toBe(201);
    const next = await open(m, 'gamer-3');
    expect(next.statusCode).toBe(201);
    expect(next.json<Account>().address).not.toBe(acc.address);
    expect((await owner.query<{ retired: boolean }>('select retired_at is not null as retired from deposit_accounts where id = $1', [acc.id])).rows[0]?.retired).toBe(true);
    const b0 = await balance(WALLET_B);
    await pay(next.json<Account>().address, 10n * E18);
    await pay(acc.address, 10n * E18);
    await confirmPayments();
    await forwardAll(m.merchantId);
    expect((await balance(WALLET_B)) - b0).toBe(99n * 10n ** 17n);
    expect((await balance(WALLET_A)) - a0).toBe(99n * E18 + 792n * 10n ** 17n + 99n * 10n ** 17n);
  });
});
