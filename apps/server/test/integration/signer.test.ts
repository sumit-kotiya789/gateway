import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { eq } from 'drizzle-orm';
import { withSystem } from '../../src/common/db.js';
import { payments, sweeps } from '../../src/db/schema.js';
import { transitionInvoice } from '../../src/modules/invoices/invoices.js';
import { postPayment } from '../../src/modules/ledger/ledger.js';
import type { ChainRpc } from '../../../signer/src/chain.js';
import { loadSignerConfig } from '../../../signer/src/config.js';
import { Keyring } from '../../../signer/src/keys.js';
import { createSignerClient } from '../../src/modules/custody/signer-client.js';
import { authHeader, requestHandler } from '../../../signer/src/server.js';
import { withSwitchLock } from './custody-sim.js';
import { createSigner, Refusal } from '../../../signer/src/signer.js';
import { LOCAL_USDT, TEST_MNEMONIC, buildTestApp, ensureLiveSimRegistry, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
let signerPool: pg.Pool;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;

/** In-memory chain: balances and nonces the test sets. */
const chain = {
  /** Set to make the RPC answer the wrong network. */
  wrongChain: false,
  gasPrice: 3n * GWEI,
  native: new Map<string, bigint>(),
  token: new Map<string, bigint>(),
  nonces: new Map<string, bigint>(),
};
const rpc: ChainRpc = {
  chainId: async () => 0,
  pendingNonce: async (a) => chain.nonces.get(a.toLowerCase()) ?? 0n,
  gasPrice: async () => chain.gasPrice,
  nativeBalance: async (a) => chain.native.get(a.toLowerCase()) ?? 0n,
  tokenBalance: async (_t, a) => chain.token.get(a.toLowerCase()) ?? 0n,
};

beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
  custody = await ensurePlatformCustody(owner);
  await owner.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'signer_test') then create role signer_test login password 'signer' in role gw_signer; end if; end $$`);
  const url = new URL(inject('pgOwnerUrl'));
  url.username = 'signer_test';
  url.password = 'signer';
  signerPool = new pg.Pool({ connectionString: url.toString(), max: 3 });
});
afterAll(async () => {
  await signerPool.end();
  await t.close();
  await owner.end();
});

function makeSigner(env: Record<string, string> = {}, mnemonic = TEST_MNEMONIC) {
  const config = loadSignerConfig({
    SIGNER_DATABASE_URL: 'postgres://unused@localhost/db',
    SIGNER_HMAC_SECRET: 'h'.repeat(32),
    SIGNER_SEED_FILE: '/unused',
    SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64'),
    ...env,
  });
  const s = createSigner({
    pool: signerPool,
    keyring: Keyring.fromMnemonic(mnemonic),
    config,
    rpcFor: (row) => ({ ...rpc, chainId: async () => (chain.wrongChain ? 1 : row.evm_chain_id) }),
  });
  return { sign: (i: Parameters<typeof s.sign>[0]) => withSwitchLock(signerPool, 'shared', () => s.sign(i)) };
}

let logIndex = 0;
/** A custodial invoice with a confirmed payment of `amount` and a pending sweep of `sweepAmount` (default: all of it). */
async function paidDeposit(amount: bigint, sweepAmount: bigint | null = amount, where: { chain: string; livemode: boolean; m?: Awaited<ReturnType<typeof merchantWithKey>> } = { chain: 'evm-local', livemode: false }) {
  const m = where.m ?? (await merchantWithKey(app, clock, owner, { livemode: where.livemode }));
  await owner.query("update merchants set custody_mode = 'custodial' where id = $1", [m.merchantId]);
  const token = `${where.chain}:usdt`;
  const inv = (await m.api('POST', '/v1/invoices', { amount: '1', token })).json<{ id: string; deposit_address: string }>();
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, $6, $2, $7, $8, '0xfeed', $3, '0x0000000000000000000000000000000000000001', $4, $5, 7, '0x01', now(), 2) returning id`,
    [m.merchantId, inv.id, 1000 + logIndex++, inv.deposit_address, amount.toString(), where.livemode, where.chain, token],
  );
  const sweepId = await withSystem(deps.db, async (tx) => {
    const [p] = await tx.update(payments).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(payments.id, r.rows[0]?.id ?? '')).returning();
    if (!p) throw new Error('payment missing');
    await postPayment(tx, p);
    await transitionInvoice(deps, tx, inv.id, 'detected', 'test');
    if (sweepAmount === null) return '';
    const [d] = await tx.execute<{ id: string }>(`select deposit_address_id as id from invoices where id = '${inv.id}'`).then((x) => x.rows);
    const [s] = await tx
      .insert(sweeps)
      .values({
        merchantId: m.merchantId,
        livemode: where.livemode,
        chainId: where.chain,
        tokenId: token,
        depositAddressId: d?.id ?? '',
        invoiceId: inv.id,
        fromAddress: inv.deposit_address,
        toAddress: where.livemode ? custody.liveHot : custody.hot,
        amount: sweepAmount,
        // Signed directly by these tests: never due for a worker run in another test file.
        nextAttemptAt: new Date(Date.now() + 365 * 86_400_000),
      })
      .returning();
    return s?.id ?? '';
  });
  return { sweepId, address: inv.deposit_address.toLowerCase(), merchant: m };
}

const refusal = (code: string) => expect.objectContaining({ code }) as unknown;

describe('signer', () => {
  it('gas top-up: from the gas wallet to the deposit address, enough for the sweep plus 20%; asking again returns the same transaction', async () => {
    const d = await paidDeposit(5n * E18);
    const signer = makeSigner();
    const s = await signer.sign({ kind: 'gas_topup', id: d.sweepId });
    const tx = parseTransaction(s.raw_tx as TransactionSerialized);
    expect(await recoverTransactionAddress({ serializedTransaction: s.raw_tx as TransactionSerialized })).toBe(custody.gas);
    expect(tx).toMatchObject({ chainId: 31337, to: d.address, value: (100_000n * 3n * GWEI * 120n) / 100n, gas: 21_000n, gasPrice: 3n * GWEI });
    const again = await signer.sign({ kind: 'gas_topup', id: d.sweepId });
    expect(again).toMatchObject({ raw_tx: s.raw_tx, reused: true });
    // Topped up already (balance covers it): a fresh sweep id would be refused as not needed.
    chain.native.set(d.address, 10n ** 16n);
    const d2 = await paidDeposit(1n * E18);
    chain.native.set(d2.address, 10n ** 16n);
    await expect(signer.sign({ kind: 'gas_topup', id: d2.sweepId })).rejects.toEqual(refusal('not_needed'));
  });

  it('sweep: token transfer of exactly the booked amount from the deposit address to the hot wallet', async () => {
    const d = await paidDeposit(7n * E18);
    const signer = makeSigner();
    await expect(signer.sign({ kind: 'sweep', id: d.sweepId })).rejects.toEqual(refusal('insufficient_funds'));
    chain.token.set(d.address, 7n * E18);
    await expect(signer.sign({ kind: 'sweep', id: d.sweepId })).rejects.toEqual(refusal('needs_gas'));
    chain.native.set(d.address, 100_000n * 3n * GWEI);
    const s = await signer.sign({ kind: 'sweep', id: d.sweepId });
    expect((await recoverTransactionAddress({ serializedTransaction: s.raw_tx as TransactionSerialized })).toLowerCase()).toBe(d.address);
    const tx = parseTransaction(s.raw_tx as TransactionSerialized);
    expect(tx.to?.toLowerCase()).toBe(LOCAL_USDT.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data ?? '0x' })).toEqual({ functionName: 'transfer', args: [custody.hot, 7n * E18] });
    const row = await owner.query("select intent_kind, amount::text, token_id, lower(from_address) as f from signer_signatures where intent_id = $1", [d.sweepId]);
    expect(row.rows[0]).toEqual({ intent_kind: 'sweep', amount: (7n * E18).toString(), token_id: 'evm-local:usdt', f: d.address });
  });

  it('refuses: more than booked, paused (DB or env), gas price above the cap, wrong chain, unsupported intents', async () => {
    const signer = makeSigner();
    const over = await paidDeposit(2n * E18, 3n * E18);
    chain.token.set(over.address, 3n * E18);
    chain.native.set(over.address, 10n ** 16n);
    await expect(signer.sign({ kind: 'sweep', id: over.sweepId })).rejects.toEqual(refusal('over_booked'));

    const d = await paidDeposit(1n * E18);
    // The admin switch, seen only by this signer: set inside a transaction that is rolled back, so test files
    // signing in parallel never see a paused signer.
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query("update signer_controls set paused = true, reason = 'test' where id = 1");
      const config = loadSignerConfig({ SIGNER_DATABASE_URL: 'postgres://unused@localhost/db', SIGNER_HMAC_SECRET: 'h'.repeat(32), SIGNER_SEED_FILE: '/unused', SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64') });
      const isolated = createSigner({ pool: { query: (q: string, a: unknown[]) => c.query(q, a) } as unknown as pg.Pool, keyring: Keyring.fromMnemonic(TEST_MNEMONIC), config, rpcFor: () => rpc });
      await expect(isolated.sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('paused'));
    } finally {
      await c.query('rollback');
      c.release();
    }
    await expect(makeSigner({ SIGNER_PAUSED: 'true' }).sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('paused'));

    chain.gasPrice = 50n * GWEI;
    await expect(signer.sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('gas_price_too_high'));
    chain.gasPrice = 3n * GWEI;
    chain.wrongChain = true;
    await expect(signer.sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('rpc_wrong_chain'));
    chain.wrongChain = false;
    await expect(makeSigner({ SIGNER_MAX_GAS_TOPUP: '0.0000001' }).sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('over_limit'));
    await expect(makeSigner({}, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about').sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(
      refusal('not_our_address'),
    );
    await owner.query("update sweeps set status = 'failed' where id = $1", [d.sweepId]);
    await expect(signer.sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('wrong_status'));
    await expect(signer.sign({ kind: 'treasury', id: d.sweepId })).rejects.toEqual(refusal('unsupported'));
    await expect(signer.sign({ kind: 'sweep', id: '00000000-0000-7000-8000-000000000000' })).rejects.toBeInstanceOf(Refusal);
  });

  it('refuses on a disabled chain, without an active hot wallet, and to a hot wallet that was replaced', async () => {
    const signer = makeSigner();
    // A chain only this test uses, so switching it off cannot disturb other test files.
    await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms, default_confirmations, reorg_depth, finality, testnet, enabled)
      values ('evm-sgn', 'evm', 'Signer test chain', 31339, '{}', 'ETH', 18, 1000, 2, 16, 'tag', true, true) on conflict do nothing`);
    await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
      values ('evm-sgn:usdt', 'evm-sgn', 'USDT', 'Signer test USDT', $1, 18, 2, 1, true) on conflict do nothing`, [LOCAL_USDT]);
    const off = await paidDeposit(1n * E18, 1n * E18, { chain: 'evm-sgn', livemode: false });
    await owner.query("update chains set enabled = false where id = 'evm-sgn'");
    await expect(signer.sign({ kind: 'gas_topup', id: off.sweepId })).rejects.toEqual(refusal('chain_disabled'));

    // Live hot wallet retired: nothing signs to it and no new sweep is planned for live funds.
    await ensureLiveSimRegistry(owner);
    const live = await paidDeposit(1n * E18, 1n * E18, { chain: 'evm-mainsim', livemode: true });
    chain.token.set(live.address, 1n * E18);
    chain.native.set(live.address, 10n ** 16n);
    // Inside a transaction that is rolled back, seen only by a signer bound to it: other test files keep the hot wallet.
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query("update platform_wallets set retired_at = now() where kind = 'hot' and livemode and retired_at is null");
      const config = loadSignerConfig({ SIGNER_DATABASE_URL: 'postgres://unused@localhost/db', SIGNER_HMAC_SECRET: 'h'.repeat(32), SIGNER_SEED_FILE: '/unused', SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64') });
      const bound = createSigner({
        pool: { query: (q: string, a: unknown[]) => c.query(q, a) } as unknown as pg.Pool,
        keyring: Keyring.fromMnemonic(TEST_MNEMONIC),
        config,
        rpcFor: (row) => ({ ...rpc, chainId: async () => row.evm_chain_id }),
      });
      await expect(bound.sign({ kind: 'sweep', id: live.sweepId })).rejects.toEqual(refusal('no_platform_wallet'));
      // A replacement hot wallet (same seed, next index): the old sweep's destination is no longer allowed.
      const next = "m/44'/60'/10'/0/1";
      await c.query("insert into platform_wallets (id, family, livemode, kind, address, derivation_path) values (gen_random_uuid(), 'evm', true, 'hot', $1, $2)", [custody.keyring.address(next), next]);
      await expect(bound.sign({ kind: 'sweep', id: live.sweepId })).rejects.toEqual(refusal('wrong_destination'));
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect((await signer.sign({ kind: 'sweep', id: live.sweepId })).reused).toBe(false);
  });

  it('two identical requests at once return the same transaction', async () => {
    const d = await paidDeposit(1n * E18);
    const signer = makeSigner();
    const [a, b] = await Promise.all([signer.sign({ kind: 'gas_topup', id: d.sweepId }), signer.sign({ kind: 'gas_topup', id: d.sweepId })]);
    expect(a.raw_tx).toBe(b.raw_tx);
    expect((await owner.query('select count(*)::int as n from signer_signatures where intent_id = $1', [d.sweepId])).rows[0]).toEqual({ n: 1 });
  });

  it('nonces: never reused for one sender, at least the chain pending nonce', async () => {
    const signer = makeSigner();
    const a = await paidDeposit(1n * E18);
    const b = await paidDeposit(1n * E18);
    chain.nonces.set(custody.gas.toLowerCase(), 40n);
    const [x, y] = await Promise.all([signer.sign({ kind: 'gas_topup', id: a.sweepId }), signer.sign({ kind: 'gas_topup', id: b.sweepId })]);
    expect([x.nonce, y.nonce].sort()).toEqual(['40', '41']);
  });

  it('HTTP: authenticated intents only; refusals carry a code, never internals', async () => {
    const d = await paidDeposit(1n * E18);
    const secret = 'h'.repeat(32);
    const logs: string[] = [];
    const log = { info: () => undefined, warn: (_o: object, m: string) => void logs.push(m), error: (_o: object, m: string) => void logs.push(m) };
    const server = createServer(requestHandler({ secret, sign: makeSigner().sign, log }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const call = (body: string, auth?: string) =>
      fetch(`http://127.0.0.1:${String(port)}/v1/sign`, { method: 'POST', body, headers: auth ? { 'x-signer-auth': auth } : {} });
    try {
      const body = JSON.stringify({ kind: 'gas_topup', id: d.sweepId });
      const now = Math.floor(Date.now() / 1000);
      expect((await call(body)).status).toBe(401);
      expect((await call(body, authHeader('x'.repeat(32), body, now))).status).toBe(401);
      const bad = JSON.stringify({ kind: 'raw', id: d.sweepId });
      expect((await call(bad, authHeader(secret, bad, now))).status).toBe(400);
      const ok = await call(body, authHeader(secret, body, now));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ reused: false, tx_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown });
      const w = JSON.stringify({ kind: 'treasury', id: d.sweepId });
      const refused = await call(w, authHeader(secret, w, now));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: 'unsupported' });
      expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);

      // The worker's client: same answers through its HMAC-signed requests.
      const client = createSignerClient({ ...deps.config, SIGNER_URL: `http://127.0.0.1:${String(port)}`, SIGNER_HMAC_SECRET: secret });
      expect(await client.sign('gas_topup', d.sweepId)).toMatchObject({ ok: true, tx: { reused: true } });
      expect(await client.sign('treasury', d.sweepId)).toEqual({ ok: false, code: 'unsupported', message: expect.any(String) as unknown });
      const wrong = createSignerClient({ ...deps.config, SIGNER_URL: `http://127.0.0.1:${String(port)}`, SIGNER_HMAC_SECRET: 'w'.repeat(32) });
      await expect(wrong.sign('sweep', d.sweepId)).rejects.toThrow(/HTTP 401/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('only the signer role writes signatures; the app role reads them; nobody changes them', async () => {
    const appPool = new pg.Pool({ connectionString: inject('pgAppUrl'), max: 1 });
    try {
      await expect(
        appPool.query(`insert into signer_signatures (id, intent_kind, intent_id, chain_id, from_address, to_address, amount, nonce, tx_hash, raw_tx)
          values (gen_random_uuid(), 'sweep', gen_random_uuid(), 'evm-local', '0x1', '0x2', 1, 999999, '0x', '0x')`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await appPool.end();
    }
    await expect(owner.query("update signer_signatures set to_address = '0xattacker'")).rejects.toThrow(/append-only|not allowed|forbid/i);
    // The signer cannot change sweeps (read-only outside signer_signatures).
    await expect(signerPool.query("update sweeps set to_address = '0xattacker'")).rejects.toThrow(/permission denied/);
  });

  it('a sweep can only go from a custodial deposit address to the active hot wallet', async () => {
    const d = await paidDeposit(1n * E18);
    const row = await owner.query<{ deposit_address_id: string; invoice_id: string; merchant_id: string; from_address: string }>(
      'select deposit_address_id, invoice_id, merchant_id, from_address from sweeps where id = $1',
      [d.sweepId],
    );
    const r = row.rows[0];
    await expect(
      owner.query(
        `insert into sweeps (id, merchant_id, livemode, chain_id, token_id, deposit_address_id, invoice_id, from_address, to_address, amount)
         values (gen_random_uuid(), $1, false, 'evm-local', 'evm-local:usdt', $2, $3, $4, '0x000000000000000000000000000000000000dEaD', 1)`,
        [r?.merchant_id, r?.deposit_address_id, r?.invoice_id, r?.from_address],
      ),
    ).rejects.toThrow(/active hot wallet|sweeps_open_uq|duplicate/);
    await expect(owner.query("update sweeps set amount = amount + 1 where id = $1", [d.sweepId])).rejects.toThrow(/immutable/);
  });
});
