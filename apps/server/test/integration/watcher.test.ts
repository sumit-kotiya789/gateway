import { createHash } from 'node:crypto';
import type { BlockInfo, ChainAdapter, ChainConfig, Receipt, TokenConfig, Transfer } from '@gw/core';
import { createEvmAdapter } from '@gw/chains';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { expireDueInvoices } from '../../src/modules/invoices/invoices.js';
import { FencedError, becomeLeader, scanTick } from '../../src/modules/watcher/scanner.js';
import { buildTestApp, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();

// ---------------------------------------------------------------- deterministic fake chain

const USDT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PAYER = '0x3333333333333333333333333333333333333333';
const hash = (s: string) => `0x${createHash('sha256').update(s).digest('hex')}`;

/** In-memory chain: blocks with hashes, transfers, receipts. `reorg(n)` replaces block n and everything after it. */
class FakeChain {
  blocks: BlockInfo[] = [];
  txs = new Map<string, Transfer & { reverted?: boolean }>();
  finalizedLag: number | null = null;
  private fork = 0;
  private nonce = 0;
  time = BigInt(Math.floor(Date.now() / 1000));

  constructor() {
    this.mine(100);
  }

  get latest() {
    return BigInt(this.blocks.length - 1);
  }

  mine(n = 1, secondsPerBlock = 3) {
    for (let i = 0; i < n; i++) {
      const number = BigInt(this.blocks.length);
      this.time += BigInt(secondsPerBlock);
      this.blocks.push({ number, hash: hash(`b${String(number)}f${String(this.fork)}`), parentHash: this.blocks.at(-1)?.hash ?? '0x0', timestamp: this.time });
    }
  }

  /** New block containing one transfer. */
  pay(to: string, amount: bigint, token = USDT): Transfer {
    this.mine();
    const b = this.blocks.at(-1) as BlockInfo;
    const tr: Transfer = { chainId: 'evm-fake', tokenAddress: token, from: PAYER, to, amount, txHash: hash(`tx${String(this.nonce++)}`), logIndex: 0, blockNumber: b.number, blockHash: b.hash };
    this.txs.set(tr.txHash, tr);
    return tr;
  }

  /** Drops blocks >= n (and their txs, unless re-included), then mines `length` new blocks. */
  reorg(n: bigint, length: number, reinclude: Transfer[] = []) {
    this.fork++;
    this.blocks = this.blocks.slice(0, Number(n));
    for (const [h, tr] of this.txs) if (tr.blockNumber >= n) this.txs.delete(h);
    this.mine(length);
    for (const tr of reinclude) {
      const b = this.blocks.at(-1) as BlockInfo;
      this.txs.set(tr.txHash, { ...tr, blockNumber: b.number, blockHash: b.hash });
    }
  }

  adapter(): ChainAdapter {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the adapter object reads live chain state
    const self = this;
    return {
      chainId: 'evm-fake',
      family: 'evm',
      getNetworkId: async () => '999999',
      getLatestBlock: async () => self.latest,
      getFinalizedBlock: async () => (self.finalizedLag === null ? null : self.latest - BigInt(self.finalizedLag)),
      async getBlock(n) {
        const b = self.blocks[Number(n)];
        if (!b) throw new Error(`no block ${String(n)}`);
        return b;
      },
      async getTokenTransfers(token, from, to, recipients) {
        const want = recipients && new Set(recipients.map((a) => a.toLowerCase()));
        return [...self.txs.values()].filter(
          (x) => x.tokenAddress.toLowerCase() === token.contractAddress.toLowerCase() && x.blockNumber >= from && x.blockNumber <= to && (!want || want.has(x.to.toLowerCase())),
        );
      },
      async getTransactionReceipt(h): Promise<Receipt | null> {
        const x = self.txs.get(h);
        return x ? { txHash: h, status: x.reverted ? 'reverted' : 'success', blockNumber: x.blockNumber, blockHash: x.blockHash, transfers: [x] } : null;
      },
      getBalance: async () => 0n,
      readTokenDecimals: async () => 6,
      estimateFee: async () => ({ gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, maxTotal: 0n }),
      broadcast: async () => '0x',
      isValidAddress: () => true,
      normalizeAddress: (a) => a,
    };
  }
}

const fakeChainCfg: ChainConfig = {
  id: 'evm-fake',
  family: 'evm',
  name: 'Fake EVM',
  evmChainId: 999999,
  rpcUrls: [],
  explorerUrl: null,
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  blockTimeMs: 1000,
  defaultConfirmations: 3,
  reorgDepth: 8,
  finality: 'confirmations',
  testnet: true,
  enabled: true,
};
const tok = (id: string, address: string): TokenConfig => ({
  id,
  chainId: 'evm-fake',
  symbol: id.split(':')[1]?.toUpperCase() ?? 'X',
  name: id,
  contractAddress: address,
  decimals: 6,
  minConfirmations: 3,
  confirmationTiers: [{ minAmount: 1_000_000_000n, confirmations: 6 }], // >= 1000 tokens: 6
  minAmount: 10_000n, // 0.01
  enabled: true,
});
const fakeTokens = [tok('evm-fake:usdt', USDT), tok('evm-fake:other', OTHER)];

const chain = new FakeChain();
let epoch = 0;
const tick = (e = epoch) => scanTick({ deps, adapter: chain.adapter(), chain: fakeChainCfg, tokens: fakeTokens, epoch: e });
/** A payment found in one tick is confirmed in a later one (fresh receipt check), so deep payments need two. */
const settle = async () => {
  await tick();
  await tick();
};

beforeAll(async () => {
  await app.ready();
  await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
      default_confirmations, reorg_depth, finality, testnet, enabled)
    values ('evm-fake', 'evm', 'Fake EVM', 999999, '{}', 'ETH', 18, 1000, 3, 8, 'confirmations', true, true) on conflict do nothing`);
  for (const k of fakeTokens) {
    await owner.query(
      `insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, confirmation_tiers, min_amount, enabled)
       values ($1, 'evm-fake', $2, $1, $3, 6, 3, $4, 10000, true) on conflict do nothing`,
      [k.id, k.symbol, k.contractAddress, JSON.stringify([{ min_amount: '1000000000', confirmations: 6 }])],
    );
  }
  epoch = await becomeLeader(deps, chain.adapter(), fakeChainCfg);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

type Inv = { id: string; status: string; amount_received: string; deposit_address: string; expires_at: string; payments: { status: string; amount: string }[] };

async function newInvoice(amount = '10', over: Record<string, unknown> = {}) {
  const m = await merchantWithKey(app, clock, owner);
  const inv = (await m.api('POST', '/v1/invoices', { amount, token: 'evm-fake:usdt', ...over })).json<Inv>();
  if (!inv.id) throw new Error(`invoice creation failed: ${JSON.stringify(inv)}`);
  const get = async () => (await m.api('GET', `/v1/invoices/${inv.id}`)).json<Inv>();
  return { m, inv, get };
}
const units = (n: number) => BigInt(Math.round(n * 1e6));

describe('watcher on a fake chain', () => {
  it('cursor starts reorgDepth behind the head, and a new leader bumps the epoch', async () => {
    const r = await owner.query<{ block_number: string; leader_epoch: string }>(`select block_number, leader_epoch from chain_cursors where chain_id = 'evm-fake'`);
    expect(Number(r.rows[0]?.block_number)).toBe(99 - 8); // head is block 99
    expect(Number(r.rows[0]?.leader_epoch)).toBe(epoch);
  });

  it('exact payment: detected -> confirming -> paid after the required depth, re-checked against the receipt', async () => {
    const { inv, get } = await newInvoice('10');
    chain.pay(inv.deposit_address, units(10));
    await tick();
    expect(await get()).toMatchObject({ status: 'detected', amount_received: '0', payments: [{ status: 'detected', amount: '10' }] });
    chain.mine(1);
    await tick();
    expect((await get()).status).toBe('confirming');
    chain.mine(1); // depth 2 < 3
    await tick();
    expect((await get()).status).toBe('confirming');
    chain.mine(1); // depth 3
    await tick();
    expect(await get()).toMatchObject({ status: 'paid', amount_received: '10', payments: [{ status: 'confirmed' }] });
    const h = await owner.query<{ t: string; reason: string }>('select to_status::text t, reason from invoice_status_history where invoice_id = $1 order by id', [inv.id]);
    expect(h.rows.map((x) => x.t)).toEqual(['created', 'pending', 'detected', 'confirming', 'paid']);
  });

  it('large amounts wait for the higher confirmation tier', async () => {
    const { inv, get } = await newInvoice('2000');
    chain.pay(inv.deposit_address, units(2000));
    chain.mine(3);
    await tick();
    expect((await get()).status).toBe('confirming');
    chain.mine(3);
    await tick();
    expect((await get()).status).toBe('paid');
  });

  it('finality tag: deep enough is not enough until the block is finalized', async () => {
    const { inv, get } = await newInvoice('10');
    chain.finalizedLag = 20;
    try {
      chain.pay(inv.deposit_address, units(10));
      chain.mine(5);
      await tick();
      expect((await get()).status).toBe('confirming');
      chain.mine(16);
      await tick();
      expect((await get()).status).toBe('paid');
    } finally {
      chain.finalizedLag = null;
    }
  });

  it('underpaid, then a top-up makes it paid; overpaid is flagged', async () => {
    const a = await newInvoice('10');
    chain.pay(a.inv.deposit_address, units(6));
    chain.mine(3);
    await settle();
    expect(await a.get()).toMatchObject({ status: 'underpaid', amount_received: '6' });
    chain.pay(a.inv.deposit_address, units(4));
    await tick();
    expect((await a.get()).status).toBe('detected');
    chain.mine(3);
    await tick();
    expect(await a.get()).toMatchObject({ status: 'paid', amount_received: '10' });

    const b = await newInvoice('10');
    chain.pay(b.inv.deposit_address, units(12));
    chain.mine(3);
    await settle();
    expect(await b.get()).toMatchObject({ status: 'overpaid', amount_received: '12' });
  });

  it('within tolerance (0.5%) counts as paid', async () => {
    const { inv, get } = await newInvoice('10');
    chain.pay(inv.deposit_address, units(9.95));
    chain.mine(3);
    await settle();
    expect((await get()).status).toBe('paid');
  });

  it('ignores dust, other tokens, and transfers to unwatched addresses', async () => {
    const { inv, get } = await newInvoice('10');
    chain.pay(inv.deposit_address, 9_999n); // below 0.01
    chain.pay(inv.deposit_address, units(10), OTHER); // wrong token
    chain.pay('0x4444444444444444444444444444444444444444', units(10));
    chain.mine(3);
    await tick();
    expect(await get()).toMatchObject({ status: 'pending', payments: [] });
  });

  it('reorg before confirmation: payment orphaned, invoice back to pending; re-mined later: confirmed', async () => {
    const { inv, get } = await newInvoice('10');
    const tr = chain.pay(inv.deposit_address, units(10));
    chain.mine(1);
    await tick();
    expect((await get()).status).toBe('confirming');

    chain.reorg(tr.blockNumber, 2); // replacement chain without the tx
    await tick();
    expect(await get()).toMatchObject({ status: 'pending', payments: [{ status: 'orphaned' }] });

    chain.reorg(chain.latest, 1, [tr]); // tx re-included in a new block
    await tick();
    expect(await get()).toMatchObject({ status: 'detected', payments: [{ status: 'detected' }] });
    chain.mine(3);
    await tick();
    expect(await get()).toMatchObject({ status: 'paid', amount_received: '10', payments: [{ status: 'confirmed' }] });
  });

  it('re-mined in a different block before confirmation: follows the tx, keeps one payment', async () => {
    const { inv, get } = await newInvoice('10');
    const tr = chain.pay(inv.deposit_address, units(10));
    await tick();
    chain.reorg(tr.blockNumber, 2, [tr]);
    await tick();
    const p = await owner.query<{ n: string; block_hash: string }>('select count(*) n, max(block_hash) block_hash from payments where invoice_id = $1', [inv.id]);
    expect(p.rows[0]?.n).toBe('1');
    expect(p.rows[0]?.block_hash).toBe(chain.blocks.at(-1)?.hash);
    chain.mine(3);
    await tick();
    expect((await get()).status).toBe('paid');
  });

  it('a reverted receipt is never confirmed', async () => {
    const { inv, get } = await newInvoice('10');
    const tr = chain.pay(inv.deposit_address, units(10));
    await tick();
    const x = chain.txs.get(tr.txHash);
    if (x) x.reverted = true;
    chain.mine(5);
    await tick();
    expect(await get()).toMatchObject({ status: 'confirming', payments: [{ status: 'detected' }] });
  });

  it('payment after the deadline: invoice expires and becomes late_payment once confirmed', async () => {
    const { inv, get } = await newInvoice('10', { expires_in: 300 });
    chain.mine(1, Number(BigInt(Math.floor(Date.parse(inv.expires_at) / 1000)) - chain.time + 10n));
    chain.pay(inv.deposit_address, units(10));
    await tick();
    expect((await get()).status).toBe('expired');
    chain.mine(3);
    await tick();
    expect(await get()).toMatchObject({ status: 'late_payment', amount_received: '10' });
  });

  it('cancelled invoice that still receives funds becomes late_payment', async () => {
    const { m, inv, get } = await newInvoice('10');
    await m.api('POST', `/v1/invoices/${inv.id}/cancel`);
    chain.pay(inv.deposit_address, units(10));
    chain.mine(3);
    await settle();
    expect((await get()).status).toBe('late_payment');
  });

  it('expiry waits for the scanner; then pending invoices expire', async () => {
    const { inv, get } = await newInvoice('10', { expires_in: 300 });
    clock.advance(301_000);
    const r = await owner.query<{ bt: Date }>(`select block_time bt from chain_cursors where chain_id = 'evm-fake'`);
    if ((r.rows[0]?.bt.getTime() ?? 0) < Date.parse(inv.expires_at)) {
      expect(await expireDueInvoices(deps)).not.toContain(inv.id);
      chain.mine(1, Math.ceil((Date.parse(inv.expires_at) - Number(chain.time) * 1000) / 1000) + 5);
      await tick();
    }
    expect(await expireDueInvoices(deps)).toContain(inv.id);
    expect((await get()).status).toBe('expired');
  });

  it('a stale leader is fenced out and writes nothing', async () => {
    const { inv, get } = await newInvoice('10');
    const old = epoch;
    epoch = await becomeLeader(deps, chain.adapter(), fakeChainCfg);
    expect(epoch).toBe(old + 1);
    chain.pay(inv.deposit_address, units(10));
    await expect(tick(old)).rejects.toBeInstanceOf(FencedError);
    expect((await get()).payments).toEqual([]);
    await tick();
    expect((await get()).status).toBe('detected');
  });

  const cursorBlock = async () =>
    BigInt((await owner.query<{ b: string }>(`select block_number b from chain_cursors where chain_id = 'evm-fake'`)).rows[0]?.b ?? '0');

  it('an RPC behind our cursor changes nothing', async () => {
    const before = await cursorBlock();
    const lagging = { ...chain.adapter(), getLatestBlock: async () => before - 1n };
    const r = await scanTick({ deps, adapter: lagging, chain: fakeChainCfg, tokens: fakeTokens, epoch });
    expect(r).toMatchObject({ found: 0, decisions: 0, to: before });
    expect(await cursorBlock()).toBe(before);
  });

  it('catches up at most MAX_RANGE blocks per tick', async () => {
    await tick();
    const start = await cursorBlock();
    chain.mine(600);
    await tick();
    expect(await cursorBlock()).toBe(start + 500n);
    await tick();
    expect(await cursorBlock()).toBe(chain.latest);
  });

  it('a reorg deeper than reorgDepth below the cursor raises the DEEP REORG alarm', async () => {
    await tick();
    const c = await cursorBlock();
    chain.mine(20);
    chain.reorg(c, 25); // replaces the cursor block itself, 20+ blocks below the new head
    const spy = vi.spyOn(deps.log, 'error');
    try {
      await tick();
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ chain: 'evm-fake' }), expect.stringContaining('DEEP REORG'));
    } finally {
      spy.mockRestore();
    }
  });

  it('a payment whose token is disabled at runtime is left alone until it is enabled again', async () => {
    const { inv, get } = await newInvoice('10', { expires_in: 86_400 }) // chain time ran ahead during catch-up;
    chain.pay(inv.deposit_address, units(10));
    await tick();
    chain.mine(5);
    await scanTick({ deps, adapter: chain.adapter(), chain: fakeChainCfg, tokens: [tok('evm-fake:other', OTHER)], epoch });
    expect(await get()).toMatchObject({ payments: [{ status: 'detected' }] });
    await tick();
    expect((await get()).status).toBe('paid');
  });

  it('a stale receipt pointing at a replaced block does not keep the payment alive', async () => {
    const { inv, get } = await newInvoice('10', { expires_in: 86_400 });
    const tr = chain.pay(inv.deposit_address, units(10));
    await tick();
    chain.reorg(tr.blockNumber, 2);
    chain.txs.set(tr.txHash, tr); // RPC still serves the old receipt (old block hash)
    try {
      await tick();
      expect(await get()).toMatchObject({ status: 'pending', payments: [{ status: 'orphaned' }] });
    } finally {
      chain.txs.delete(tr.txHash);
    }
  });

  it('DB refuses payments that do not match their invoice, and edits to confirmed payments', async () => {
    const { inv } = await newInvoice('10');
    const ins = (to: string) =>
      owner.query(
        `insert into payments (id, merchant_id, livemode, invoice_id, chain_id, token_id, tx_hash, log_index, from_address, to_address, amount,
           block_number, block_hash, block_time, required_confirmations)
         select gen_random_uuid(), merchant_id, livemode, id, chain_id, token_id, $2, 0, $3, $4, 1, 1, '0x', now(), 1 from invoices where id = $1`,
        [inv.id, hash(`manual${to}`), PAYER, to],
      );
    await expect(ins('0x4444444444444444444444444444444444444444')).rejects.toThrow(/does not match invoice/);
    const confirmed = await owner.query<{ id: string }>(`select id from payments where status = 'confirmed' limit 1`);
    await expect(owner.query('update payments set amount = amount + 1 where id = $1', [confirmed.rows[0]?.id])).rejects.toThrow(/immutable/);
    await expect(owner.query(`update payments set status = 'orphaned' where id = $1`, [confirmed.rows[0]?.id])).rejects.toThrow(/final/);
    await expect(owner.query('delete from payments where id = $1', [confirmed.rows[0]?.id])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- real node

describe('watcher on Anvil', () => {
  it('finds a real ERC-20 payment by recipient filter and confirms it past the finalized tag', async () => {
    const anvilUrl = inject('anvilUrl');
    const { anvilAccount, deploy, anvilClients, mineBlocks, MOCK_ABI, localChain } = await import('../../../../packages/chains/test/support/anvil.js');
    const acct = anvilAccount(7);
    const token = await deploy(anvilUrl, 'MockERC20', ['Watch USD', 'WUSD', 6], acct);
    await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
        default_confirmations, reorg_depth, finality, testnet, enabled)
      values ('evm-watch', 'evm', 'Anvil watch', 31337, '{}', 'ETH', 18, 1000, 2, 16, 'tag', true, true)`);
    await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
      values ('evm-watch:wusd', 'evm-watch', 'WUSD', 'Watch USD', $1, 6, 2, 10000, true)`, [token]);
    const cfg = localChain(anvilUrl, { id: 'evm-watch', reorgDepth: 16 });
    const wusd: TokenConfig = { id: 'evm-watch:wusd', chainId: 'evm-watch', symbol: 'WUSD', name: 'Watch USD', contractAddress: token, decimals: 6, minConfirmations: 2, confirmationTiers: [], minAmount: 10_000n, enabled: true };
    const adapter = createEvmAdapter(cfg, [anvilUrl]);
    const e = await becomeLeader(deps, adapter, cfg);

    const m = await merchantWithKey(app, clock, owner);
    const inv = (await m.api('POST', '/v1/invoices', { amount: '25', token: 'evm-watch:wusd' })).json<Inv>();
    const { pub, wallet } = anvilClients(anvilUrl, acct);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'mint', args: [acct.address, 100_000_000n] }) });
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'transfer', args: [inv.deposit_address as `0x${string}`, 25_000_000n] }),
    });

    const run = () => scanTick({ deps, adapter, chain: cfg, tokens: [wusd], epoch: e });
    await run();
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json<Inv>().status).toBe('detected');
    await mineBlocks(anvilUrl, 70); // Anvil finalizes at head - 64
    await run();
    expect((await m.api('GET', `/v1/invoices/${inv.id}`)).json<Inv>()).toMatchObject({ status: 'paid', amount_received: '25' });
  });
});
