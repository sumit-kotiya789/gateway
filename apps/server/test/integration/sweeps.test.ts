import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { eq } from 'drizzle-orm';
import { withSystem } from '../../src/common/db.js';
import { payments } from '../../src/db/schema.js';
import type { ChainTx } from '../../src/modules/custody/chain-tx.js';
import type { SignerClient } from '../../src/modules/custody/signer-client.js';
import { advanceSweeps, planSweeps, type SweeperEnv } from '../../src/modules/custody/sweeper.js';
import { transitionInvoice } from '../../src/modules/invoices/invoices.js';
import { postPayment, resolveInvoice } from '../../src/modules/ledger/ledger.js';
import { reconcileLedger } from '../../src/modules/ledger/reconciliation.js';
import type { ChainRpc } from '../../../signer/src/chain.js';
import { loadSignerConfig } from '../../../signer/src/config.js';
import { Keyring } from '../../../signer/src/keys.js';
import { Refusal, createSigner } from '../../../signer/src/signer.js';
import { TEST_MNEMONIC, buildTestApp, ensureLocalRegistry, ensurePlatformCustody, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp({ FEATURE_CUSTODIAL: 'true' });
const { app, clock, deps } = t;
const owner = ownerPool();
const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
let signerPool: pg.Pool;
let custody: Awaited<ReturnType<typeof ensurePlatformCustody>>;

/** A tiny simulated EVM chain: balances, a mempool, and blocks that apply transfers when mined. */
class FakeChain {
  head = 100n;
  gasPrice = 3n * GWEI;
  native = new Map<string, bigint>();
  token = new Map<string, bigint>();
  nonces = new Map<string, bigint>();
  mempool = new Map<string, string>();
  mined = new Map<string, { status: 'success' | 'reverted'; blockNumber: bigint }>();
  broadcasts = 0;
  revertNextSweep = false;
  private bal(m: Map<string, bigint>, a: string) {
    return m.get(a.toLowerCase()) ?? 0n;
  }
  private add(m: Map<string, bigint>, a: string, v: bigint) {
    m.set(a.toLowerCase(), this.bal(m, a) + v);
  }
  rpc: ChainRpc = {
    chainId: async () => 31337,
    pendingNonce: async (a) => this.nonces.get(a.toLowerCase()) ?? 0n,
    gasPrice: async () => this.gasPrice,
    nativeBalance: async (a) => this.bal(this.native, a),
    tokenBalance: async (_t, a) => this.bal(this.token, a),
  };
  tx: ChainTx = {
    sendRaw: async (raw) => {
      this.broadcasts++;
      const h = keccak256(raw as `0x${string}`);
      if (!this.mined.has(h)) this.mempool.set(h, raw);
    },
    receipt: async (h) => this.mined.get(h) ?? null,
    blockNumber: async () => this.head,
    nativeBalance: async (a) => this.bal(this.native, a),
  };
  /** Mines every pending transaction into the next block. */
  async mine(blocks = 1) {
    for (const [h, raw] of this.mempool) {
      const tx = parseTransaction(raw as TransactionSerialized);
      const from = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
      const fee = (tx.gas ?? 0n) * (tx.gasPrice ?? 0n);
      this.add(this.native, from, -fee - (tx.value ?? 0n));
      this.nonces.set(from.toLowerCase(), (this.nonces.get(from.toLowerCase()) ?? 0n) + 1n);
      let status: 'success' | 'reverted' = 'success';
      if (tx.data && tx.data !== '0x') {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
        const [to, amount] = args as [string, bigint];
        if (this.revertNextSweep || this.bal(this.token, from) < amount) {
          status = 'reverted';
          this.revertNextSweep = false;
        } else {
          this.add(this.token, from, -amount);
          this.add(this.token, to, amount);
        }
      } else if (tx.to) this.add(this.native, tx.to, tx.value ?? 0n);
      this.mined.set(h, { status, blockNumber: this.head + 1n });
    }
    this.mempool.clear();
    this.head += BigInt(blocks);
  }
}

let chain: FakeChain;
let env: SweeperEnv;
function makeEnv(c: FakeChain): SweeperEnv {
  const config = loadSignerConfig({
    SIGNER_DATABASE_URL: 'postgres://unused@localhost/db',
    SIGNER_HMAC_SECRET: 'h'.repeat(32),
    SIGNER_SEED_FILE: '/unused',
    SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64'),
  });
  const signer = createSigner({ pool: signerPool, keyring: Keyring.fromMnemonic(TEST_MNEMONIC), config, rpcFor: () => c.rpc });
  const client: SignerClient = {
    sign: async (kind, id) => {
      try {
        return { ok: true, tx: await signer.sign({ kind, id }) };
      } catch (err) {
        if (err instanceof Refusal) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    },
  };
  return { signer: client, chainTx: () => c.tx };
}

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

let logIndex = 0;
/** Custodial merchant (1% fee) with an invoice of `expected` that received a confirmed `received`. */
async function custodialPayment(expected: string, received: bigint, status: 'paid' | 'underpaid' = 'paid') {
  const m = await merchantWithKey(app, clock, owner);
  await owner.query("update merchants set custody_mode = 'custodial', fee_bps = 100 where id = $1", [m.merchantId]);
  const inv = (await m.api('POST', '/v1/invoices', { amount: expected, token: 'evm-local:usdt' })).json<{ id: string; deposit_address: string }>();
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, false, $2, 'evm-local', 'evm-local:usdt', '0xbeef', $3, '0x0000000000000000000000000000000000000001', $4, $5, 7, '0x01', now(), 2) returning id`,
    [m.merchantId, inv.id, 2000 + logIndex++, inv.deposit_address, received.toString()],
  );
  await withSystem(deps.db, async (tx) => {
    const [p] = await tx.update(payments).set({ status: 'confirmed', confirmedAt: new Date(clock()) }).where(eq(payments.id, r.rows[0]?.id ?? '')).returning();
    if (!p) throw new Error('payment missing');
    await postPayment(tx, p);
    await tx.execute(`update invoices set amount_received = ${received.toString()} where id = '${inv.id}'`);
    await transitionInvoice(deps, tx, inv.id, 'detected', 'test');
    await transitionInvoice(deps, tx, inv.id, 'confirming', 'test');
    await transitionInvoice(deps, tx, inv.id, status, 'test');
  });
  chain.token.set(inv.deposit_address.toLowerCase(), received); // the customer's transfer, on chain
  return { m, inv };
}

const sweepsOf = async (merchantId: string) =>
  (await owner.query<{ id: string; status: string; amount: string; last_error: string | null }>('select id, status, amount::text, last_error from sweeps where merchant_id = $1 order by created_at', [merchantId])).rows;
/** One worker tick, past any poll interval or backoff. */
async function tick(merchantId: string) {
  clock.advance(31 * 60_000);
  return advanceSweeps(deps, env, { merchantId });
}
const balance = async (m: Awaited<ReturnType<typeof merchantWithKey>>) =>
  (await m.api('GET', '/v1/balances')).json<{ data: { token: string; pending: string; available: string }[] }>().data.find((b) => b.token === 'evm-local:usdt');

describe('sweeps', () => {
  beforeAll(() => {
    chain = new FakeChain();
    env = makeEnv(chain);
  });

  it('gas top-up, sweep, confirmations, then the invoice settles and the balance becomes available', async () => {
    const { m, inv } = await custodialPayment('10', 10n * E18);
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(1);
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(0); // one open sweep per address
    expect((await sweepsOf(m.merchantId))[0]).toMatchObject({ status: 'pending', amount: (10n * E18).toString() });

    expect(await tick(m.merchantId)).toMatchObject({ gas_sent: 1 });
    const sent = chain.broadcasts;
    expect(await tick(m.merchantId)).toMatchObject({ gas_sent: 1 }); // not mined yet: rebroadcast of the same bytes
    expect(chain.broadcasts).toBe(sent + 1);
    expect(chain.mempool.size).toBe(1);
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 });
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 }); // 1 confirmation of 2
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });

    expect(chain.token.get(custody.hot.toLowerCase())).toBeGreaterThanOrEqual(10n * E18);
    expect(chain.token.get(inv.deposit_address.toLowerCase())).toBe(0n);
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'settled' });
    expect(await balance(m)).toMatchObject({ pending: '0', available: '9.9' });
    const lines = await owner.query<{ account: string; amount: string }>(
      `select a.kind as account, e.amount::text from ledger_journals j join ledger_entries e on e.journal_id = j.id join ledger_accounts a on a.id = e.account_id
       where j.invoice_id = $1 and j.kind = 'sweep' order by e.id`,
      [inv.id],
    );
    expect(lines.rows).toEqual([
      { account: 'custody_hot', amount: (10n * E18).toString() },
      { account: 'custody_deposits', amount: (-10n * E18).toString() },
    ]);
    expect(await tick(m.merchantId)).toEqual({}); // nothing left to do
  });

  it('an address that already holds gas skips the top-up', async () => {
    const { m, inv } = await custodialPayment('2', 2n * E18);
    chain.native.set(inv.deposit_address.toLowerCase(), 10n ** 16n);
    await planSweeps(deps, { merchantId: m.merchantId });
    expect(await tick(m.merchantId)).toMatchObject({ sweep_sent: 1 });
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
  });

  it('a reverted sweep fails; the next round plans a new one that succeeds', async () => {
    const { m, inv } = await custodialPayment('3', 3n * E18);
    chain.native.set(inv.deposit_address.toLowerCase(), 10n ** 16n);
    await planSweeps(deps, { merchantId: m.merchantId });
    await tick(m.merchantId);
    chain.revertNextSweep = true;
    await chain.mine();
    expect(await tick(m.merchantId)).toMatchObject({ failed: 1 });
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'paid' }); // not settled
    expect(await planSweeps(deps, { merchantId: m.merchantId })).toBe(1);
    await tick(m.merchantId);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
    expect((await sweepsOf(m.merchantId)).map((s) => s.status)).toEqual(['failed', 'confirmed']);
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'settled' });
  });

  it('a paused signer leaves sweeps waiting (never failed); they resume when unpaused', async () => {
    const { m } = await custodialPayment('1', 1n * E18);
    await planSweeps(deps, { merchantId: m.merchantId });
    await owner.query("update signer_controls set paused = true, reason = 'drill' where id = 1");
    try {
      expect(await tick(m.merchantId)).toMatchObject({ pending: 1 });
      expect((await sweepsOf(m.merchantId))[0]).toMatchObject({ status: 'pending', last_error: 'paused' });
    } finally {
      await owner.query('update signer_controls set paused = false where id = 1');
    }
    expect(await tick(m.merchantId)).toMatchObject({ gas_sent: 1 });
    await chain.mine();
    await tick(m.merchantId);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
  });

  it('underpaid funds are swept but stay pending until an admin accepts them, then settle at once', async () => {
    const { m, inv } = await custodialPayment('10', 4n * E18, 'underpaid');
    chain.native.set(inv.deposit_address.toLowerCase(), 10n ** 16n);
    await planSweeps(deps, { merchantId: m.merchantId });
    await tick(m.merchantId);
    await chain.mine(3);
    expect(await tick(m.merchantId)).toMatchObject({ confirmed: 1 });
    expect(await balance(m)).toMatchObject({ pending: '4', available: '0' });
    await withSystem(deps.db, (tx) => resolveInvoice(deps, tx, inv.id, 'customer confirmed'));
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json()).toMatchObject({ status: 'settled' });
    expect(await balance(m)).toMatchObject({ pending: '0', available: '3.96' });
  });

  it('reconciliation stays clean across sweeps and settlements', async () => {
    const issues = await reconcileLedger(deps);
    expect(issues.filter((i) => ['custodial_received', 'custodial_settlement', 'negative_merchant_balance', 'sweep_journal', 'negative_custody', 'ledger_unbalanced'].includes(i.check))).toEqual([]);
  });

  it('the hot wallet received exactly what was swept', () => {
    expect(chain.token.get(custody.hot.toLowerCase())).toBe((10n + 2n + 3n + 1n + 4n) * E18);
    expect(chain.mempool.size).toBe(0);
  });
});
