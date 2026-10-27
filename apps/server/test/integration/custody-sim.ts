// Test support for custody: a simulated EVM chain (balances, mempool, blocks) and the real signer wired to it.
import { inject } from 'vitest';
import pg from 'pg';
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { TRANSFER_TOPIC, type RawLog } from '@gw/chains';
import type { ChainTx } from '../../src/modules/custody/chain-tx.js';
import type { SignerClient } from '../../src/modules/custody/signer-client.js';
import type { SweeperEnv } from '../../src/modules/custody/sweeper.js';
import type { ChainRpc } from '../../../signer/src/chain.js';
import { loadSignerConfig } from '../../../signer/src/config.js';
import { Keyring } from '../../../signer/src/keys.js';
import { Refusal, createSigner } from '../../../signer/src/signer.js';
import { eq } from 'drizzle-orm';
import { withSystem } from '../../src/common/db.js';
import { payments, sweeps } from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { transitionInvoice } from '../../src/modules/invoices/invoices.js';
import { postPayment, postSweep, settleIfSwept } from '../../src/modules/ledger/ledger.js';
import { TEST_MNEMONIC, merchantWithKey, type buildTestApp } from './helpers.js';

const GWEI = 10n ** 9n;
const E18 = 10n ** 18n;

/** A tiny simulated EVM chain: balances, a mempool, and blocks that apply transfers when mined. */
export class FakeChain {
  head = 100n;
  chainId = 31337;
  gasPrice = 3n * GWEI;
  native = new Map<string, bigint>();
  token = new Map<string, bigint>();
  nonces = new Map<string, bigint>();
  mempool = new Map<string, string>();
  mined = new Map<string, { status: 'success' | 'reverted'; blockNumber: bigint; logs: RawLog[] }>();
  broadcasts = 0;
  revertNextSweep = false;
  revertNextNative = false;
  /** The next broadcast throws (RPC down). */
  failNextSend = false;
  private bal(m: Map<string, bigint>, a: string) {
    return m.get(a.toLowerCase()) ?? 0n;
  }
  private add(m: Map<string, bigint>, a: string, v: bigint) {
    m.set(a.toLowerCase(), this.bal(m, a) + v);
  }
  rpc: ChainRpc = {
    chainId: async () => this.chainId,
    pendingNonce: async (a) => this.nonces.get(a.toLowerCase()) ?? 0n,
    gasPrice: async () => this.gasPrice,
    nativeBalance: async (a) => this.bal(this.native, a),
    tokenBalance: async (_t, a) => this.bal(this.token, a),
  };
  tx: ChainTx = {
    sendRaw: async (raw) => {
      if (this.failNextSend) {
        this.failNextSend = false;
        throw new Error('rpc unreachable');
      }
      this.broadcasts++;
      const h = keccak256(raw as `0x${string}`);
      if (!this.mined.has(h)) this.mempool.set(h, raw);
    },
    receipt: async (h) => this.mined.get(h) ?? null,
    blockNumber: async () => this.head,
    nativeBalance: async (a) => this.bal(this.native, a),
    tokenBalance: async (_t, a) => this.bal(this.token, a),
  };
  /** Mines every pending transaction into the next block. */
  async mine(blocks = 1) {
    for (const [h, raw] of this.mempool) {
      const tx = parseTransaction(raw as TransactionSerialized);
      const from = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
      const fee = (tx.gas ?? 0n) * (tx.gasPrice ?? 0n);
      this.add(this.native, from, -fee); // the fee is paid even when the transaction reverts
      this.nonces.set(from.toLowerCase(), (this.nonces.get(from.toLowerCase()) ?? 0n) + 1n);
      let status: 'success' | 'reverted' = 'success';
      const logs: RawLog[] = [];
      if (tx.data && tx.data !== '0x') {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
        const [to, amount] = args as [string, bigint];
        if (this.revertNextSweep || this.bal(this.token, from) < amount) {
          status = 'reverted';
          this.revertNextSweep = false;
        } else {
          this.add(this.token, from, -amount);
          this.add(this.token, to, amount);
          logs.push(this.transferLog(tx.to ?? '0x', from, to, amount, h));
        }
      } else if (this.revertNextNative) {
        status = 'reverted';
        this.revertNextNative = false;
      } else if (tx.to) {
        this.add(this.native, from, -(tx.value ?? 0n));
        this.add(this.native, tx.to, tx.value ?? 0n);
      }
      this.mined.set(h, { status, blockNumber: this.head + 1n, logs });
    }
    this.mempool.clear();
    this.head += BigInt(blocks);
  }

  private transferLog(token: string, from: string, to: string, amount: bigint, txHash: string, logIndex = 0): RawLog {
    const topic = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
    return {
      address: token,
      topics: [TRANSFER_TOPIC, topic(from), topic(to)],
      data: `0x${amount.toString(16).padStart(64, '0')}`,
      blockNumber: this.head + 1n,
      blockHash: `0x${'b'.repeat(64)}`,
      transactionHash: txHash,
      logIndex,
    };
  }

  /** A token transfer the platform did not sign (e.g. the cold multisig refilling the hot wallet), mined now. */
  external(token: string, from: string, to: string, amount: bigint): string {
    const h = `0x${(this.head * 1000n + BigInt(this.mined.size)).toString(16).padStart(64, 'e')}`;
    this.add(this.token, from, -amount);
    this.add(this.token, to, amount);
    this.mined.set(h, { status: 'success', blockNumber: this.head + 1n, logs: [this.transferLog(token, from, to, amount, h)] });
    this.head += 1n;
    return h;
  }
}

/**
 * Cross-file test lock around the global signer switch: every test signature holds it shared; the kill-switch test
 * holds it exclusively while the signer is paused, so test files signing in parallel never see that pause.
 */
const SIGNER_SWITCH_LOCK = 7_310_001;
export async function withSwitchLock<T>(pool: pg.Pool, mode: 'shared' | 'exclusive', fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(mode === 'shared' ? 'select pg_advisory_lock_shared($1)' : 'select pg_advisory_lock($1)', [SIGNER_SWITCH_LOCK]);
    return await fn();
  } finally {
    await c.query(mode === 'shared' ? 'select pg_advisory_unlock_shared($1)' : 'select pg_advisory_unlock($1)', [SIGNER_SWITCH_LOCK]);
    c.release();
  }
}

/** A LOGIN user in gw_signer (the signer's DB role), and a pool connected as it. */
export async function signerPool(owner: pg.Pool): Promise<pg.Pool> {
  await owner.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'signer_test') then create role signer_test login password 'signer' in role gw_signer; end if; end $$`);
  const url = new URL(inject('pgOwnerUrl'));
  url.username = 'signer_test';
  url.password = 'signer';
  return new pg.Pool({ connectionString: url.toString(), max: 3 });
}

/** The worker's environment with the real signer (test seed) on a simulated chain. */
export function custodyEnv(pool: pg.Pool, c: FakeChain, signerEnv: Record<string, string> = {}, mnemonic = TEST_MNEMONIC): SweeperEnv {
  const config = loadSignerConfig({
    SIGNER_DATABASE_URL: 'postgres://unused@localhost/db',
    SIGNER_HMAC_SECRET: 'h'.repeat(32),
    SIGNER_SEED_FILE: '/unused',
    SIGNER_SEED_KEK: Buffer.alloc(32, 7).toString('base64'),
    ...signerEnv,
  });
  const signer = createSigner({ pool, keyring: Keyring.fromMnemonic(mnemonic), config, rpcFor: (row) => ({ ...c.rpc, chainId: async () => row.evm_chain_id }) });
  const client: SignerClient = {
    sign: async (kind, id) => {
      try {
        return { ok: true, tx: await withSwitchLock(pool, 'shared', () => signer.sign({ kind, id })) };
      } catch (err) {
        if (err instanceof Refusal) return { ok: false, code: err.code, message: err.message };
        throw err;
      }
    },
  };
  return { signer: client, chainTx: () => c.tx };
}

let fundIndex = 0;
/** A custodial merchant (no fee) with `amount` available: paid, swept into the hot wallet the way the worker books it, settled. */
export async function fundCustodialMerchant(
  ctx: { app: ReturnType<typeof buildTestApp>['app']; clock: ReturnType<typeof buildTestApp>['clock']; deps: Deps; owner: pg.Pool; custody: { hot: string; liveHot: string } },
  amount: bigint,
  livemode = false,
) {
  const { app, clock, deps, owner, custody } = ctx;
  const tokenOf = (l: boolean) => (l ? 'evm-mainsim:usdt' : 'evm-local:usdt');
  const chainOf = (l: boolean) => (l ? 'evm-mainsim' : 'evm-local');
  const m = await merchantWithKey(app, clock, owner, { livemode, scopes: ['read', 'invoices:write', 'withdrawals:write'] });
  await owner.query("update merchants set custody_mode = 'custodial', fee_bps = 0 where id = $1", [m.merchantId]);
  const inv = (await m.api('POST', '/v1/invoices', { amount: '1', token: tokenOf(livemode) })).json<{ id: string; deposit_address: string }>();
  const r = await owner.query<{ id: string }>(
    `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount, block_number, block_hash, block_time, required_confirmations)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, '0xabcd', $8, '0x0000000000000000000000000000000000000001', $6, $7, 7, '0x01', now(), 2) returning id`,
    [m.merchantId, livemode, inv.id, chainOf(livemode), tokenOf(livemode), inv.deposit_address, amount.toString(), 3000 + Math.floor(Math.random() * 1e6) * 10 + fundIndex++],
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
    if (!(await settleIfSwept(deps, tx, inv.id))) throw new Error('funding did not settle');
  });
  return m;
}
