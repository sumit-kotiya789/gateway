// Test support for custody: a simulated EVM chain (balances, mempool, blocks) and the real signer wired to it.
import { inject } from 'vitest';
import pg from 'pg';
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import type { ChainTx } from '../../src/modules/custody/chain-tx.js';
import type { SignerClient } from '../../src/modules/custody/signer-client.js';
import type { SweeperEnv } from '../../src/modules/custody/sweeper.js';
import type { ChainRpc } from '../../../signer/src/chain.js';
import { loadSignerConfig } from '../../../signer/src/config.js';
import { Keyring } from '../../../signer/src/keys.js';
import { Refusal, createSigner } from '../../../signer/src/signer.js';
import { TEST_MNEMONIC } from './helpers.js';

const GWEI = 10n ** 9n;

/** A tiny simulated EVM chain: balances, a mempool, and blocks that apply transfers when mined. */
export class FakeChain {
  head = 100n;
  chainId = 31337;
  gasPrice = 3n * GWEI;
  native = new Map<string, bigint>();
  token = new Map<string, bigint>();
  nonces = new Map<string, bigint>();
  mempool = new Map<string, string>();
  mined = new Map<string, { status: 'success' | 'reverted'; blockNumber: bigint }>();
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
      } else if (this.revertNextNative) {
        status = 'reverted';
        this.revertNextNative = false;
      } else if (tx.to) {
        this.add(this.native, from, -(tx.value ?? 0n));
        this.add(this.native, tx.to, tx.value ?? 0n);
      }
      this.mined.set(h, { status, blockNumber: this.head + 1n });
    }
    this.mempool.clear();
    this.head += BigInt(blocks);
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
