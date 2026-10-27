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
import { authHeader, requestHandler } from '../../../signer/src/server.js';
import { createSigner, Refusal } from '../../../signer/src/signer.js';
import { LOCAL_USDT, TEST_MNEMONIC, buildTestApp, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
let signerPool: pg.Pool;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;

/** In-memory chain: balances and nonces the test sets. */
const chain = {
  id: 31337,
  gasPrice: 3n * GWEI,
  native: new Map<string, bigint>(),
  token: new Map<string, bigint>(),
  nonces: new Map<string, bigint>(),
};
const rpc: ChainRpc = {
  chainId: async () => chain.id,
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
  await owner.query('update signer_controls set paused = false where id = 1');
  await signerPool.end();
  await t.close();
  await owner.end();
});

function makeSigner(env: Record<string, string> = {}) {
  const config = loadSignerConfig({
    SIGNER_DATABASE_URL: 'postgres://unused@localhost/db',
    SIGNER_HMAC_SECRET: 'h'.repeat(32),
    SIGNER_SEED_FILE: '/unused',
    SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64'),
    ...env,
  });
  return createSigner({ pool: signerPool, keyring: Keyring.fromMnemonic(TEST_MNEMONIC), config, rpcFor: () => rpc });
}

let logIndex = 0;
/** A custodial invoice with a confirmed payment of `amount` and a pending sweep of `sweepAmount` (default: all of it). */
async function paidDeposit(amount: bigint, sweepAmount = amount) {
  const m = await merchantWithKey(app, clock, owner);
  await owner.query("update merchants set custody_mode = 'custodial' where id = $1", [m.merchantId]);
  const inv = (await m.api('POST', '/v1/invoices', { amount: '1', token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string }>();
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, false, $2, 'evm-local', 'evm-local:usdt', '0xfeed', $3, '0x0000000000000000000000000000000000000001', $4, $5, 7, '0x01', now(), 2) returning id`,
    [m.merchantId, inv.id, 1000 + logIndex++, inv.deposit_address, amount.toString()],
  );
  const sweepId = await withSystem(deps.db, async (tx) => {
    const [p] = await tx.update(payments).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(payments.id, r.rows[0]?.id ?? '')).returning();
    if (!p) throw new Error('payment missing');
    await postPayment(tx, p);
    await transitionInvoice(deps, tx, inv.id, 'detected', 'test');
    const [d] = await tx.execute<{ id: string }>(`select deposit_address_id as id from invoices where id = '${inv.id}'`).then((x) => x.rows);
    const [s] = await tx
      .insert(sweeps)
      .values({ merchantId: m.merchantId, livemode: false, chainId: 'evm-local', tokenId: 'evm-local:usdt', depositAddressId: d?.id ?? '', invoiceId: inv.id, fromAddress: inv.deposit_address, toAddress: custody.hot, amount: sweepAmount })
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
    await owner.query("update signer_controls set paused = true, reason = 'test' where id = 1");
    await expect(signer.sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('paused'));
    await owner.query('update signer_controls set paused = false where id = 1');
    await expect(makeSigner({ SIGNER_PAUSED: 'true' }).sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('paused'));

    chain.gasPrice = 50n * GWEI;
    await expect(signer.sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('gas_price_too_high'));
    chain.gasPrice = 3n * GWEI;
    chain.id = 1;
    await expect(signer.sign({ kind: 'gas_topup', id: d.sweepId })).rejects.toEqual(refusal('rpc_wrong_chain'));
    chain.id = 31337;
    await expect(signer.sign({ kind: 'withdrawal', id: d.sweepId })).rejects.toEqual(refusal('unsupported'));
    await expect(signer.sign({ kind: 'sweep', id: '00000000-0000-7000-8000-000000000000' })).rejects.toBeInstanceOf(Refusal);
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
      const w = JSON.stringify({ kind: 'withdrawal', id: d.sweepId });
      const refused = await call(w, authHeader(secret, w, now));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: 'unsupported' });
      expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
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
