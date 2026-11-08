// Forwarder custody mode (D-097) end to end on Anvil: invoice -> CREATE2 deposit address -> real ERC-20 payment ->
// watcher confirms -> worker plans a forward -> the real signer (test seed) signs deployAndFlush from the gas wallet ->
// merchant and fee wallet get the exact split on-chain -> fee booked, invoice settled.
import type { TokenConfig } from '@gw/core';
import { FORWARDER_FACTORY_ABI, FORWARDER_FACTORY_BYTECODE, createEvmAdapter, forwarderAddress, type ForwarderParams } from '@gw/chains';
import { keccak256, stringToHex } from 'viem';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { viemRpc } from '../../../signer/src/chain.js';
import { loadSignerConfig } from '../../../signer/src/config.js';
import { Keyring } from '../../../signer/src/keys.js';
import { Refusal, createSigner } from '../../../signer/src/signer.js';
import { MOCK_ABI, anvilAccount, anvilClients, deploy, localChain, mineBlocks } from '../../../../packages/chains/test/support/anvil.js';
import { viemChainTx } from '../../src/modules/custody/chain-tx.js';
import { advanceForwards, planForwards, type ForwarderEnv } from '../../src/modules/custody/forwarder.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import type { SignerClient } from '../../src/modules/custody/signer-client.js';
import { becomeLeader, scanTick } from '../../src/modules/watcher/scanner.js';
import { signerPool, withSwitchLock } from './custody-sim.js';
import { TEST_FEE_WALLET, TEST_MNEMONIC, adminAgent, buildTestApp, ensurePlatformCustody, merchantWithKey, ownerPool, totpNow } from './helpers.js';

const anvilUrl = inject('anvilUrl');
const t = buildTestApp({ FEATURE_FORWARDER: 'true' });
const off = buildTestApp(); // FEATURE_FORWARDER unset
const { app, deps } = t;
const owner = ownerPool();
// Own Anvil account: test files run in parallel against one node (see packages/chains/test/support/anvil.ts).
const payer = anvilAccount(5);
const { pub, wallet } = anvilClients(anvilUrl, payer);
const CHAIN = 'evm-fwd';
const TOKEN = 'evm-fwd:susdt';
const LIVE_TOKEN = 'evm-fwdlive:susdt';
const MERCHANT_WALLET = '0x00000000000000000000000000000000000beef5';
const E18 = 10n ** 18n;

type Inv = { id: string; status: string; deposit_address: string; amount_received: string };

let factory: Address;
let token: Address;
let tokenCfg: TokenConfig;
let signerDb: Awaited<ReturnType<typeof signerPool>>;
let env: ForwarderEnv;
let scan: () => Promise<unknown>;

const balance = (who: string) => pub.readContract({ address: token, abi: MOCK_ABI, functionName: 'balanceOf', args: [who as Address] }) as Promise<bigint>;
const pay = async (to: string, amount: bigint) =>
  pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'transfer', args: [to as Address, amount] }) });

/** The real signer on Anvil; `rpc` lets a test change what the signer sees on-chain. */
function signerClient(rpcOverride: Partial<ReturnType<typeof viemRpc>> = {}, configOverride: Record<string, string> = {}): SignerClient {
  const config = loadSignerConfig({
    SIGNER_DATABASE_URL: 'postgres://unused@localhost/db',
    SIGNER_HMAC_SECRET: 'h'.repeat(32),
    SIGNER_SEED_FILE: '/unused',
    SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64'),
    ...configOverride,
  });
  const signer = createSigner({ pool: signerDb, keyring: Keyring.fromMnemonic(TEST_MNEMONIC), config, rpcFor: () => ({ ...viemRpc([anvilUrl]), ...rpcOverride }) });
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

/** A forwarder merchant with a test payout address (added through the dashboard API, 2FA). */
async function forwarderMerchant(target: { app: typeof app; clock: typeof t.clock } = t, withPayout = true) {
  const m = await merchantWithKey(target.app, target.clock, owner);
  // Through the dashboard (owner + 2FA); a deployment without the flag only gets there by SQL.
  if (target === t) {
    target.clock.advance(30_000);
    const r = await m.agent.req('PUT', '/v1/dashboard/settings/receiving-mode', { mode: 'non_custodial_forwarder' }, { 'x-totp-code': totpNow(m.secret, target.clock()) });
    expect(r.json()).toEqual({ receiving_mode: 'non_custodial_forwarder' });
  } else {
    await owner.query(`update merchants set custody_mode = 'non_custodial_forwarder' where id = $1`, [m.merchantId]);
  }
  if (withPayout) {
    target.clock.advance(30_000);
    const r = await m.agent.req('POST', '/v1/dashboard/withdrawals/payout-addresses', { livemode: false, address: MERCHANT_WALLET }, { 'x-totp-code': totpNow(m.secret, target.clock()) });
    expect(r.statusCode).toBe(201);
  }
  return m;
}

/** Creates a test invoice through the API; fails with the response body if refused. */
async function invoice(m: Awaited<ReturnType<typeof forwarderMerchant>>, amount: string): Promise<Inv> {
  const r = await m.api('POST', '/v1/invoices', { amount, token: TOKEN });
  if (r.statusCode !== 201) throw new Error(`invoice creation failed: ${String(r.statusCode)} ${r.body}`);
  return r.json<Inv>();
}

/** Plans and advances forwards until none is open (mining a block between rounds for confirmations). */
async function forwardAll(merchantId: string, e: ForwarderEnv = env) {
  const ends: Record<string, number>[] = [];
  await planForwards(deps, e, { merchantId });
  for (let i = 0; i < 6; i++) {
    const r = await advanceForwards(deps, e, { merchantId });
    ends.push(r);
    const open = await owner.query(`select 1 from forwards where merchant_id = $1 and status in ('pending', 'sent')`, [merchantId]);
    if (open.rowCount === 0) break;
    await mineBlocks(anvilUrl, 2);
    await owner.query(`update forwards set next_attempt_at = now() - interval '1 second' where merchant_id = $1 and status in ('pending', 'sent')`, [merchantId]);
  }
  return ends;
}

async function confirmPayments() {
  await scan();
  await mineBlocks(anvilUrl, 3);
  await scan();
}

beforeAll(async () => {
  await Promise.all([app.ready(), off.app.ready()]);
  await ensurePlatformCustody(owner);
  signerDb = await signerPool(owner);

  const h = await wallet.deployContract({ abi: FORWARDER_FACTORY_ABI, bytecode: FORWARDER_FACTORY_BYTECODE, args: [] });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (!r.contractAddress) throw new Error('factory deploy failed');
  factory = r.contractAddress;
  token = await deploy(anvilUrl, 'MockERC20', ['sastaUSDT', 'sastaUSDT', 18], payer);
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'mint', args: [payer.address, 1_000_000n * E18] }) });

  await owner.query(
    `insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations,
       reorg_depth, finality, testnet, enabled, forwarder_factory)
     values ($1, 'evm', 'Anvil forwarder', 31337, '{}', 'ETH', 18, 1000, 2, 16, 'confirmations', true, true, $2)`,
    [CHAIN, factory],
  );
  await owner.query(
    `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
     values ($1, $2, 'sastaUSDT', 'sastaUSDT', $3, 18, 2, 10000000000000000, true)`,
    [TOKEN, CHAIN, token],
  );
  // A mainnet-flagged chain for live-mode refusals only (no payments on it).
  await owner.query(
    `insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations,
       reorg_depth, finality, testnet, enabled, forwarder_factory)
     values ('evm-fwdlive', 'evm', 'Anvil forwarder live', 31337, '{}', 'ETH', 18, 1000, 2, 16, 'confirmations', false, true, $1)`,
    [factory],
  );
  await owner.query(
    `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
     values ($1, 'evm-fwdlive', 'sastaUSDT', 'sastaUSDT', $2, 18, 2, 10000000000000000, true)`,
    [LIVE_TOKEN, token],
  );
  // The gas wallet (test seed) pays for flushes.
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
  await Promise.all([t.close(), off.close()]);
  await signerDb.end();
  await owner.end();
});

describe('forwarder mode on Anvil (D-097)', () => {
  it('pays the merchant wallet minus the fee, books it, settles; a late payment is forwarded fee-free (cap reached)', async () => {
    const m = await forwarderMerchant();
    const inv = await invoice(m, '100');
    expect(inv.status).toBe('pending');

    // The deposit address is exactly the forwarder of the committed parameters (merchant wallet, fee wallet, 1%, cap 1).
    const p = (
      await owner.query<{ salt: `0x${string}`; merchant_address: string; fee_recipient: string; fee_bps: number; fee_cap: string }>(
        `select f.salt, f.merchant_address, f.fee_recipient, f.fee_bps, f.fee_cap::text from forwarder_params f
         join invoices i on i.deposit_address_id = f.deposit_address_id where i.id = $1`,
        [inv.id],
      )
    ).rows[0];
    expect(p).toMatchObject({ merchant_address: '0x00000000000000000000000000000000000BEEf5', fee_bps: 100, fee_cap: String(E18) });
    expect(p?.fee_recipient.toLowerCase()).toBe(TEST_FEE_WALLET);
    const params: ForwarderParams = { merchant: MERCHANT_WALLET, feeRecipient: TEST_FEE_WALLET, token, feeBps: 100, feeCap: E18 };
    expect(inv.deposit_address).toBe(forwarderAddress(factory, p?.salt ?? '0x', params));
    expect(await pub.getCode({ address: inv.deposit_address as Address })).toBeUndefined(); // nothing deployed yet

    const [m0, f0] = [await balance(MERCHANT_WALLET), await balance(TEST_FEE_WALLET)];
    await pay(inv.deposit_address, 100n * E18);
    await confirmPayments();
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json<Inv>().status).toBe('paid'); // not settled until forwarded

    await forwardAll(m.merchantId);
    expect((await balance(MERCHANT_WALLET)) - m0).toBe(99n * E18);
    expect((await balance(TEST_FEE_WALLET)) - f0).toBe(E18);
    expect(await balance(inv.deposit_address)).toBe(0n);
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json<Inv>().status).toBe('settled');
    const fwd = await owner.query<{ status: string; to_merchant: string; fee: string }>(`select status, to_merchant::text, fee::text from forwards where invoice_id = $1`, [inv.id]);
    expect(fwd.rows).toEqual([{ status: 'confirmed', to_merchant: String(99n * E18), fee: String(E18) }]);
    const journals = await owner.query<{ kind: string; account: string; amount: string }>(
      `select j.kind::text kind, a.kind::text account, e.amount::text amount from ledger_journals j
       join ledger_entries e on e.journal_id = j.id join ledger_accounts a on a.id = e.account_id where j.invoice_id = $1 order by j.created_at, e.id`,
      [inv.id],
    );
    expect(journals.rows).toEqual([
      { kind: 'payment', account: 'merchant_received', amount: String(100n * E18) },
      { kind: 'payment', account: 'merchant_sales', amount: String(-100n * E18) },
      { kind: 'forward_fee', account: 'merchant_received', amount: String(-E18) },
      { kind: 'forward_fee', account: 'merchant_sales', amount: String(E18) },
      { kind: 'forward_fee', account: 'platform_fee_wallet', amount: String(E18) },
      { kind: 'forward_fee', account: 'platform_fee_revenue', amount: String(-E18) },
    ]);
    const fee = await owner.query<{ fee: string }>('select fee_amount::text fee from invoices where id = $1', [inv.id]);
    expect(fee.rows[0]?.fee).toBe(String(E18));
    // The API shows what moved; the settings show the mode.
    const detail = (await m.api('GET', `/v1/invoices/${inv.id}`)).json<{ custody_mode: string; forwards: { status: string; to_merchant: string; fee: string; tx_hash: string }[] }>();
    expect(detail.custody_mode).toBe('non_custodial_forwarder');
    expect(detail.forwards).toMatchObject([{ status: 'confirmed', to_merchant: '99', fee: '1' }]);
    expect(detail.forwards[0]?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await m.agent.req('GET', '/v1/dashboard/settings/')).json()).toMatchObject({ receiving_mode: 'non_custodial_forwarder', forwarder_available: true });
    const admin = await adminAgent(t, owner);
    const listed = (await admin.agent.req('GET', '/admin/v1/custody/forwards?status=confirmed')).json<{ data: { invoice_id: string; fee: string }[] }>();
    expect(listed.data.find((r) => r.invoice_id === inv.id)).toMatchObject({ fee: '1' });

    // Late payment to the same address: forwarded again, all of it to the merchant (the fee cap is used up).
    await pay(inv.deposit_address, 5n * E18);
    await confirmPayments();
    await forwardAll(m.merchantId);
    expect((await balance(MERCHANT_WALLET)) - m0).toBe(104n * E18);
    expect((await balance(TEST_FEE_WALLET)) - f0).toBe(E18);
    const all = await owner.query<{ fee: string }>(`select fee::text from forwards where invoice_id = $1 and status = 'confirmed' order by created_at`, [inv.id]);
    expect(all.rows.map((r) => r.fee)).toEqual([String(E18), '0']);
    // Balances: received is the gross amount paid, the on-chain fee beside it; no prepaid fee balance applies, so the
    // live card is never "top up needed" (only xpub merchants prepay fees, D-076).
    type Bal = { token: string; received: string; fees_charged: string; fee_status: string };
    const test = (await m.api('GET', '/v1/balances')).json<{ data: Bal[] }>().data.find((b) => b.token === TOKEN);
    expect(test).toMatchObject({ received: '105', fees_charged: '1', fee_status: 'not_enforced' });
    const live = (await m.agent.req('GET', '/v1/dashboard/balances/?livemode=true')).json<{ custody_mode: string; data: Bal[] }>();
    expect(live.custody_mode).toBe('non_custodial_forwarder');
    expect(live.data.find((b) => b.token === LIVE_TOKEN)).toMatchObject({ fee_status: 'not_enforced' });
    // Reconciliation agrees: received = payments - forward fees; every forward fee booked once.
    const issues = (await reconcileLedger(deps)).filter((i) => ['received_balance', 'forward_fee_journal', 'unforwarded'].includes(i.check));
    expect(issues).toEqual([]);
  });

  it('the signer refuses a factory whose on-chain code is not the committed artifact', async () => {
    const m = await forwarderMerchant();
    const inv = await invoice(m, '10');
    await pay(inv.deposit_address, 10n * E18);
    await confirmPayments();
    const evil: ForwarderEnv = { signer: signerClient({ codeHash: async () => `0x${'ab'.repeat(32)}` }), chainTx: env.chainTx };
    await forwardAll(m.merchantId, evil);
    const f = await owner.query<{ status: string; last_error: string }>(`select status, last_error from forwards where invoice_id = $1`, [inv.id]);
    expect(f.rows).toEqual([{ status: 'failed', last_error: 'factory_mismatch' }]);
    expect(await balance(inv.deposit_address)).toBe(10n * E18); // nothing moved
    // With the real chain the next round forwards it.
    await forwardAll(m.merchantId);
    expect(await balance(inv.deposit_address)).toBe(0n);
  });

  it('needs a payout address, and the deployment flag', async () => {
    const noPayout = await forwarderMerchant(t, false);
    const r = await noPayout.api('POST', '/v1/invoices', { amount: '10', token: TOKEN });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/payout wallet address configured for test mode/);
    // Live mode needs its own (live) payout address.
    const live = await merchantWithKey(app, t.clock, owner, { livemode: true });
    await owner.query(`update merchants set custody_mode = 'non_custodial_forwarder' where id = $1`, [live.merchantId]);
    const lr = await live.api('POST', '/v1/invoices', { amount: '10', token: LIVE_TOKEN });
    expect(lr.json<{ error: { message: string } }>().error.message).toMatch(/payout wallet address configured for live mode/);

    const flagOff = await forwarderMerchant(off);
    expect((await flagOff.api('POST', '/v1/invoices', { amount: '10', token: TOKEN })).statusCode).toBe(403);
    off.clock.advance(30_000);
    const sw = await flagOff.agent.req('PUT', '/v1/dashboard/settings/receiving-mode', { mode: 'non_custodial_forwarder' }, { 'x-totp-code': totpNow(flagOff.secret, off.clock()) });
    expect(sw.statusCode).toBe(403);
    // The mode switch needs a fresh 2FA code.
    const noCode = await noPayout.agent.req('PUT', '/v1/dashboard/settings/receiving-mode', { mode: 'non_custodial_xpub' });
    expect(noCode.statusCode).toBe(403);
  });

  it('database guards: parameters immutable, factory set once, forwards stay within the cap', async () => {
    const m = await forwarderMerchant();
    const inv = await invoice(m, '10');
    const dep = await owner.query<{ id: string }>('select deposit_address_id id from invoices where id = $1', [inv.id]);
    const depId = dep.rows[0]?.id;
    await expect(owner.query(`update forwarder_params set merchant_address = $1 where deposit_address_id = $2`, [payer.address, depId])).rejects.toThrow();
    await expect(owner.query(`delete from forwarder_params where deposit_address_id = $1`, [depId])).rejects.toThrow();
    await expect(owner.query(`update chains set forwarder_factory = $1 where id = $2`, [payer.address, CHAIN])).rejects.toThrow(/set once/);
    // A confirmed forward cannot book more fee than the committed cap (0.1 for 10 at 1%).
    const ins = await owner.query<{ id: string }>(
      `insert into forwards (id, merchant_id, livemode, chain_id, token_id, deposit_address_id, invoice_id, forwarder_address, amount)
       values (gen_random_uuid(), $1, false, $2, $3, $4, $5, $6, 1) returning id`,
      [m.merchantId, CHAIN, TOKEN, depId, inv.id, inv.deposit_address],
    );
    const fid = ins.rows[0]?.id;
    await owner.query(`update forwards set status = 'sent', tx_hash = '0x01' where id = $1`, [fid]);
    await expect(owner.query(`update forwards set status = 'confirmed', to_merchant = 0, fee = $2 where id = $1`, [fid, String(E18)])).rejects.toThrow(/cap/);
    await expect(owner.query(`update forwards set status = 'pending' where id = $1`, [fid])).rejects.toThrow(/only moves forward/);
    await expect(owner.query(`update forwards set status = 'failed' where id = $1`, [fid])).resolves.toBeDefined();
    // A forward must flush its own invoice's forwarder address.
    await expect(
      owner.query(
        `insert into forwards (id, merchant_id, livemode, chain_id, token_id, deposit_address_id, invoice_id, forwarder_address, amount)
         values (gen_random_uuid(), $1, false, $2, $3, $4, $5, $6, 1)`,
        [m.merchantId, CHAIN, TOKEN, depId, inv.id, payer.address],
      ),
    ).rejects.toThrow(/its own invoice/);
  });
});

describe('forwarder edge cases (D-097)', () => {
  /** A forwarder invoice paid and confirmed; returns its pending forward (planned with the real chain). */
  async function paidInvoice(amount: bigint) {
    const m = await forwarderMerchant();
    const inv = await invoice(m, String(amount));
    await pay(inv.deposit_address, amount * E18);
    await confirmPayments();
    return { m, inv };
  }
  const forwardOf = async (invoiceId: string) =>
    (await owner.query<{ id: string; status: string; last_error: string | null; attempts: number }>(`select id, status, last_error, attempts from forwards where invoice_id = $1 order by created_at desc limit 1`, [invoiceId])).rows[0];
  const real = () => viemChainTx([anvilUrl]);

  it('planning skips an unreadable balance; signer refusals of the moment wait with backoff; the next round goes through', async () => {
    const { m, inv } = await paidInvoice(7n);
    const down: ForwarderEnv = { signer: env.signer, chainTx: () => ({ ...real(), tokenBalance: () => Promise.reject(new Error('rpc down')) }) };
    expect(await planForwards(deps, down, { merchantId: m.merchantId })).toBe(0);
    expect(await planForwards(deps, env, { merchantId: m.merchantId })).toBe(1);
    // Signer unreachable: the forward keeps its state and is retried after the lease.
    const unreachable: ForwarderEnv = { signer: { sign: () => Promise.reject(new Error('connect ECONNREFUSED')) }, chainTx: real };
    expect(await advanceForwards(deps, unreachable, { merchantId: m.merchantId })).toEqual({ error: 1 });
    expect(await forwardOf(inv.id)).toMatchObject({ status: 'pending', attempts: 0 });

    for (const [e, code] of [
      [{ signer: signerClient({ nativeBalance: () => Promise.resolve(0n) }), chainTx: real }, 'needs_gas'],
      [{ signer: signerClient({}, { SIGNER_MAX_FORWARD_GAS: '100000' }), chainTx: real }, 'over_limit'],
      [{ signer: signerClient({}, { SIGNER_MAX_FORWARDS_PER_DAY: '1' }), chainTx: real }, 'over_limit'],
    ] as const) {
      await owner.query(`update forwards set next_attempt_at = now() - interval '1 second' where invoice_id = $1`, [inv.id]);
      expect(await advanceForwards(deps, e, { merchantId: m.merchantId })).toEqual({ pending: 1 });
      expect(await forwardOf(inv.id)).toMatchObject({ status: 'pending', last_error: code });
    }
    await owner.query(`update forwards set next_attempt_at = now() - interval '1 second' where invoice_id = $1`, [inv.id]);
    await forwardAll(m.merchantId);
    expect(await forwardOf(inv.id)).toMatchObject({ status: 'confirmed', attempts: 3 });
  });

  it('a transaction the node never saw is rebroadcast with the same bytes', async () => {
    const { m, inv } = await paidInvoice(3n);
    let swallowed = 0;
    const lossy: ForwarderEnv = {
      signer: env.signer,
      chainTx: () => ({ ...real(), sendRaw: () => { swallowed++; return Promise.resolve(); } }),
    };
    await planForwards(deps, lossy, { merchantId: m.merchantId });
    expect(await advanceForwards(deps, lossy, { merchantId: m.merchantId })).toEqual({ sent: 1 });
    expect(swallowed).toBe(1);
    await owner.query(`update forwards set next_attempt_at = now() - interval '1 second' where invoice_id = $1`, [inv.id]);
    expect(await advanceForwards(deps, env, { merchantId: m.merchantId })).toEqual({ sent: 1 }); // not mined: rebroadcast
    await owner.query(`update forwards set next_attempt_at = now() - interval '1 second' where invoice_id = $1`, [inv.id]);
    // Mined, 1 of 2 confirmations: the head is pinned to the mined block, since other test files mine on this Anvil.
    const f = await owner.query<{ tx_hash: string }>(`select tx_hash from forwards where invoice_id = $1`, [inv.id]);
    const mined = (await real().receipt(f.rows[0]?.tx_hash ?? ''))?.blockNumber ?? 0n;
    expect(mined).toBeGreaterThan(0n);
    const pinned: ForwarderEnv = { signer: env.signer, chainTx: () => ({ ...real(), blockNumber: () => Promise.resolve(mined) }) };
    expect(await advanceForwards(deps, pinned, { merchantId: m.merchantId })).toEqual({ sent: 1 });
    await forwardAll(m.merchantId);
    expect(await forwardOf(inv.id)).toMatchObject({ status: 'confirmed' });
    expect(await balance(inv.deposit_address)).toBe(0n);
  });

  it('a reverted flush fails the forward; funds moved outside the gateway are not planned again', async () => {
    const { m, inv } = await paidInvoice(4n);
    const reverting: ForwarderEnv = {
      signer: env.signer,
      chainTx: () => ({ ...real(), receipt: async (h: string) => ((await real().receipt(h)) ? { status: 'reverted' as const, blockNumber: 1n, logs: [] } : null) }),
    };
    await planForwards(deps, reverting, { merchantId: m.merchantId });
    await advanceForwards(deps, reverting, { merchantId: m.merchantId });
    await owner.query(`update forwards set next_attempt_at = now() - interval '1 second' where invoice_id = $1`, [inv.id]);
    expect(await advanceForwards(deps, reverting, { merchantId: m.merchantId })).toEqual({ failed: 1 });
    expect(await forwardOf(inv.id)).toMatchObject({ status: 'failed', last_error: 'forward_reverted' });
    // The (actually mined) flush emptied the address: nothing to plan, and no scope = every merchant.
    expect(await planForwards(deps, env)).toBe(0);
    expect(await advanceForwards(deps, env)).toEqual({});
  });

  it('anyone can flush a forwarder directly (merchant self-rescue); the planner then leaves it alone', async () => {
    const { m, inv } = await paidInvoice(2n);
    const p = (await owner.query<{ salt: `0x${string}`; fee_cap: string }>(`select f.salt, f.fee_cap::text from forwarder_params f join invoices i on i.deposit_address_id = f.deposit_address_id where i.id = $1`, [inv.id])).rows[0];
    const before = await balance(MERCHANT_WALLET);
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: factory,
        abi: FORWARDER_FACTORY_ABI,
        functionName: 'deployAndFlush',
        args: [p?.salt ?? '0x', MERCHANT_WALLET, TEST_FEE_WALLET, token, 100, BigInt(p?.fee_cap ?? '0'), [token]],
      }),
    });
    expect((await balance(MERCHANT_WALLET)) - before).toBe((2n * E18 * 99n) / 100n);
    expect(await planForwards(deps, env, { merchantId: m.merchantId })).toBe(0);
  });

  it('the signer refuses tampered parameters, a non-pending forward, and a deposit address that is not the forwarder of its parameters', async () => {
    const { m, inv } = await paidInvoice(1n);
    await planForwards(deps, env, { merchantId: m.merchantId });
    const fwd = await forwardOf(inv.id);
    const id = fwd?.id ?? '';
    const signer = signerClient();
    // Simulates a tampered database (the guards forbid these updates; the signer must not rely on them).
    const tamper = async (set: string, args: unknown[]) => {
      const c = await owner.connect();
      try {
        await c.query('set session_replication_role = replica');
        await c.query(`update forwarder_params set ${set} where deposit_address_id = (select deposit_address_id from invoices where id = $1)`, [inv.id, ...args]);
      } finally {
        await c.query('set session_replication_role = origin');
        c.release();
      }
    };
    const orig = (await owner.query<{ factory: string; merchant_address: string; salt: string }>(`select factory, merchant_address, salt from forwarder_params f join invoices i on i.deposit_address_id = f.deposit_address_id where i.id = $1`, [inv.id])).rows[0];
    await tamper('factory = $2', [payer.address]);
    expect(await signer.sign('forward', id)).toMatchObject({ ok: false, code: 'factory_mismatch' });
    await tamper('factory = $2, merchant_address = $3', [orig?.factory, payer.address]);
    expect(await signer.sign('forward', id)).toMatchObject({ ok: false, code: 'params_mismatch' });
    await tamper('merchant_address = $2, salt = $3', [orig?.merchant_address, keccak256(stringToHex('forged'))]);
    expect(await signer.sign('forward', id)).toMatchObject({ ok: false, code: 'not_our_address' });
    await tamper('salt = $2', [orig?.salt]);
    // A forward that is no longer pending (and was never signed) is refused; an already signed intent would just get
    // its same signed bytes back (rebroadcast), never a second transaction.
    await owner.query(`update forwards set status = 'failed' where id = $1`, [id]);
    expect(await signer.sign('forward', id)).toMatchObject({ ok: false, code: 'wrong_status' });
    // Restored: the next planning round creates a new forward and it goes through.
    await forwardAll(m.merchantId);
    expect(await forwardOf(inv.id)).toMatchObject({ status: 'confirmed' });
    expect(await balance(inv.deposit_address)).toBe(0n);
  });
});
