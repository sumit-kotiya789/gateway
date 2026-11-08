// Parity: the TS address and fee math (src/evm/forwarder.ts) against the real contracts on Anvil.
import { keccak256, parseUnits, type Address, type Hex } from 'viem';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import {
  FORWARDER_FACTORY_ABI,
  FORWARDER_FACTORY_BYTECODE,
  FORWARDER_FACTORY_CODEHASH,
  decodeFlushed,
  deployAndFlushData,
  forwarderAddress,
  forwarderFeeOn,
  forwarderFlushFee,
  forwarderSalt,
  type ForwarderParams,
} from '../../src/index.js';
import { MOCK_ABI, anvilAccount, anvilClients, deploy } from '../support/anvil.js';

const url = inject('anvilUrl');
// Own Anvil account: test files run in parallel against one node (see support/anvil.ts).
const me = anvilAccount(6);
const { pub, wallet } = anvilClients(url, me);
const MERCHANT = '0x000000000000000000000000000000000000bEEF';
const PLATFORM = '0x0000000000000000000000000000000000000FEE';

let factory: Address;
let usdt: Address;
beforeAll(async () => {
  const hash = await wallet.deployContract({ abi: FORWARDER_FACTORY_ABI, bytecode: FORWARDER_FACTORY_BYTECODE, args: [] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error('factory deploy failed');
  factory = r.contractAddress;
  usdt = await deploy(url, 'MockERC20', ['sastaUSDT', 'sastaUSDT', 18], me);
});

const balance = (who: string) => pub.readContract({ address: usdt, abi: MOCK_ABI, functionName: 'balanceOf', args: [who as Address] }) as Promise<bigint>;

async function send(data: Hex) {
  const hash = await wallet.sendTransaction({ to: factory, data });
  return pub.waitForTransactionReceipt({ hash });
}

describe('forwarder contracts on Anvil', () => {
  it('on-chain factory code matches the committed artifact', async () => {
    const code = await pub.getCode({ address: factory });
    expect(code && keccak256(code)).toBe(FORWARDER_FACTORY_CODEHASH);
  });

  it('TS address == factory.predict for many argument sets', async () => {
    for (let i = 0; i < 8; i++) {
      const p: ForwarderParams = { merchant: MERCHANT, feeRecipient: PLATFORM, token: usdt, feeBps: i * 37, feeCap: BigInt(i) * 10n ** 17n };
      const salt = forwarderSalt(`parity-${String(i)}`);
      const onChain = await pub.readContract({
        address: factory,
        abi: FORWARDER_FACTORY_ABI,
        functionName: 'predict',
        args: [salt, p.merchant, p.feeRecipient, p.token, p.feeBps, p.feeCap],
      });
      expect(onChain).toBe(forwarderAddress(factory, salt, p));
    }
  });

  it('pay -> deployAndFlush: merchant and fee wallet get exactly the TS split; a late payment respects the cap', async () => {
    const amountExpected = parseUnits('100', 18);
    const p: ForwarderParams = { merchant: MERCHANT, feeRecipient: PLATFORM, token: usdt, feeBps: 100, feeCap: forwarderFeeOn(amountExpected, 100) };
    const salt = forwarderSalt('e2e-1');
    const dep = forwarderAddress(factory, salt, p);
    const [m0, f0] = [await balance(MERCHANT), await balance(PLATFORM)];

    // two payments of 60 -> one flush of 120 (overpaid): fee capped at the fee on 100
    for (let i = 0; i < 2; i++) {
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt, abi: MOCK_ABI, functionName: 'mint', args: [dep, parseUnits('60', 18)] }) });
    }
    const r1 = await send(deployAndFlushData(salt, p, [usdt]));
    expect(r1.status).toBe('success');
    const fee1 = forwarderFlushFee(parseUnits('120', 18), 100, p.feeCap);
    expect(fee1).toBe(parseUnits('1', 18));
    expect(decodeFlushed(r1.logs, dep)).toEqual([{ asset: usdt, toMerchant: parseUnits('119', 18), fee: fee1 }]);
    expect((await balance(MERCHANT)) - m0).toBe(parseUnits('119', 18));
    expect((await balance(PLATFORM)) - f0).toBe(fee1);
    expect(await balance(dep)).toBe(0n);

    // late payment after the cap: all to the merchant; the factory call works on an existing forwarder too
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt, abi: MOCK_ABI, functionName: 'mint', args: [dep, parseUnits('5', 18)] }) });
    const r2 = await send(deployAndFlushData(salt, p, [usdt]));
    expect(decodeFlushed(r2.logs, dep)).toEqual([{ asset: usdt, toMerchant: parseUnits('5', 18), fee: 0n }]);
  });

  it('tampered arguments reach another address and leave the deposit untouched', async () => {
    const p: ForwarderParams = { merchant: MERCHANT, feeRecipient: PLATFORM, token: usdt, feeBps: 100, feeCap: parseUnits('1', 18) };
    const salt = forwarderSalt('tamper-1');
    const dep = forwarderAddress(factory, salt, p);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt, abi: MOCK_ABI, functionName: 'mint', args: [dep, parseUnits('10', 18)] }) });
    const evil = { ...p, merchant: me.address };
    await send(deployAndFlushData(salt, evil, [usdt]));
    expect(await balance(dep)).toBe(parseUnits('10', 18));
  });
});
