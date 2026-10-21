import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { parseUnits, type Address, type Hex } from 'viem';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createEvmAdapter, evmDeriver } from '../../src/index.js';
import { ANVIL_MNEMONIC, FAKE_ABI, MOCK_ABI, anvilClients, deploy, localChain, payer, tokenConfig } from '../support/anvil.js';

const url = inject('anvilUrl');
const { pub, wallet } = anvilClients(url);
const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(ANVIL_MNEMONIC)).derive("m/44'/60'/7'").publicExtendedKey;

let usdt: Address;
let usdt6: Address;
let fake: Address;
beforeAll(async () => {
  usdt = await deploy(url, 'MockERC20', ['Mock USDT', 'USDT', 18]);
  usdt6 = await deploy(url, 'MockERC20', ['Mock USDC', 'USDC', 6]);
  fake = await deploy(url, 'FakeTransferEmitter');
  const h = await wallet.writeContract({ address: usdt, abi: MOCK_ABI, functionName: 'mint', args: [payer.address, parseUnits('1000000', 18)] });
  await pub.waitForTransactionReceipt({ hash: h });
});

const adapter = () => createEvmAdapter(localChain(url), [url]);

async function pay(token: Address, to: string, amount: bigint) {
  const hash = await wallet.writeContract({ address: token, abi: MOCK_ABI, functionName: 'transfer', args: [to as Address, amount] });
  return pub.waitForTransactionReceipt({ hash });
}

describe('EVM adapter on Anvil', () => {
  it('reads blocks and finality', async () => {
    const a = adapter();
    const latest = await a.getLatestBlock();
    expect(latest).toBeGreaterThan(0n);
    const b = await a.getBlock(latest);
    expect(b.number).toBe(latest);
    expect(b.hash).toMatch(/^0x[0-9a-f]{64}$/);
    const fin = await a.getFinalizedBlock();
    expect(fin === null || fin <= latest).toBe(true);
    expect(await createEvmAdapter(localChain(url, { finality: 'confirmations' }), [url]).getFinalizedBlock()).toBeNull();
  });

  it('startup check reads on-chain decimals', async () => {
    expect(await adapter().readTokenDecimals(tokenConfig(usdt))).toBe(18);
    expect(await adapter().readTokenDecimals(tokenConfig(usdt6))).toBe(6);
  });

  it('finds a payment to a derived deposit address with exact amount', async () => {
    const { address } = evmDeriver.deriveFromXpub(xpub, 1);
    const amount = parseUnits('25.5', 18);
    const r = await pay(usdt, address, amount);
    const transfers = await adapter().getTokenTransfers(tokenConfig(usdt), r.blockNumber, r.blockNumber);
    const mine = transfers.filter((t) => t.to === address);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ amount, from: payer.address, tokenAddress: usdt, txHash: r.transactionHash, blockHash: r.blockHash });
    expect(await adapter().getBalance(address, tokenConfig(usdt))).toBe(amount);
  });

  it('fake Transfer events from another contract are never returned for the token', async () => {
    const { address } = evmDeriver.deriveFromXpub(xpub, 2);
    const hash = await wallet.writeContract({ address: fake, abi: FAKE_ABI, functionName: 'emitFake', args: [payer.address, address as Address, 10n ** 24n] });
    const r = await pub.waitForTransactionReceipt({ hash });
    const transfers = await adapter().getTokenTransfers(tokenConfig(usdt), r.blockNumber, r.blockNumber);
    expect(transfers.filter((t) => t.to === address)).toHaveLength(0);
    // The receipt shows the spoofed log, attributed to the fake emitter, so callers can filter by contract.
    const rec = await adapter().getTransactionReceipt(r.transactionHash);
    expect(rec?.transfers.every((t) => t.tokenAddress === fake)).toBe(true);
  });

  it('receipt: success with transfers; reverted tx has no transfers', async () => {
    const { address } = evmDeriver.deriveFromXpub(xpub, 3);
    const ok = await pay(usdt, address, 1n);
    const rec = await adapter().getTransactionReceipt(ok.transactionHash);
    expect(rec?.status).toBe('success');
    expect(rec?.transfers.filter((t) => t.tokenAddress === usdt && t.to === address)).toHaveLength(1);

    // Payer holds no USDC mock: the transfer reverts. Explicit gas skips simulation so the tx is mined anyway.
    const hash = await wallet.writeContract({
      address: usdt6,
      abi: MOCK_ABI,
      functionName: 'transfer',
      args: [address as Address, 1n],
      gas: 100_000n,
    });
    const failed = await adapter().getTransactionReceipt((await pub.waitForTransactionReceipt({ hash })).transactionHash);
    expect(failed?.status).toBe('reverted');
    expect(failed?.transfers).toHaveLength(0);
    expect(await adapter().getTransactionReceipt(`0x${'00'.repeat(32)}`)).toBeNull();
  });

  it('range filter: transfers outside [from, to] are excluded', async () => {
    const { address } = evmDeriver.deriveFromXpub(xpub, 4);
    const r1 = await pay(usdt, address, 5n);
    const r2 = await pay(usdt, address, 7n);
    const only2 = await adapter().getTokenTransfers(tokenConfig(usdt), r2.blockNumber, r2.blockNumber);
    expect(only2.filter((t) => t.to === address).map((t) => t.amount)).toEqual([7n]);
    const both = await adapter().getTokenTransfers(tokenConfig(usdt), r1.blockNumber, r2.blockNumber);
    expect(both.filter((t) => t.to === address).map((t) => t.amount)).toEqual([5n, 7n]);
    expect(await adapter().getTokenTransfers(tokenConfig(usdt), r2.blockNumber, r1.blockNumber)).toEqual([]);
  });

  it('fails over when the first RPC is down', async () => {
    const a = createEvmAdapter(localChain(url), ['http://127.0.0.1:1', url], { timeoutMs: 2000 });
    expect(await a.getLatestBlock()).toBeGreaterThan(0n);
  });

  it('address validation enforces EIP-55 checksums', () => {
    const a = adapter();
    expect(a.isValidAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(true);
    expect(a.isValidAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe(true); // all-lowercase has no checksum
    expect(a.isValidAddress('0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(false); // bad checksum
    expect(a.isValidAddress('0x123')).toBe(false);
    expect(a.normalizeAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('estimates fees and broadcasts a signed tx', async () => {
    const a = adapter();
    const fee = await a.estimateFee({ from: payer.address, to: payer.address, value: 1n });
    expect(fee.gasLimit).toBeGreaterThanOrEqual(21_000n);
    expect(fee.maxTotal).toBe(fee.gasLimit * fee.maxFeePerGas);
    const req = await wallet.prepareTransactionRequest({ to: payer.address, value: 1n });
    const signed = await wallet.signTransaction(req);
    const hash = await a.broadcast(signed);
    expect((await pub.waitForTransactionReceipt({ hash: hash as Hex })).status).toBe('success');
  });
});

describe('recipient filter', () => {
  it('returns only transfers to the given addresses', async () => {
    const a1 = evmDeriver.deriveFromXpub(xpub, 40).address;
    const a2 = evmDeriver.deriveFromXpub(xpub, 41).address;
    const other = evmDeriver.deriveFromXpub(xpub, 42).address;
    const r1 = await pay(usdt, a1, 1n);
    await pay(usdt, other, 2n);
    const r3 = await pay(usdt, a2, 3n);
    const got = await adapter().getTokenTransfers(tokenConfig(usdt), r1.blockNumber, r3.blockNumber, [a1, a2.toLowerCase()]);
    expect(got.map((t) => [t.to, t.amount])).toEqual([
      [a1, 1n],
      [a2, 3n],
    ]);
    expect(await adapter().getTokenTransfers(tokenConfig(usdt), r1.blockNumber, r3.blockNumber, [])).toEqual([]);
  });
});
