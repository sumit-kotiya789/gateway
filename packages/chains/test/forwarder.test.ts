import { computeFee, feeBase } from '@gw/core';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  FORWARDER_ABI,
  FORWARDER_FACTORY_CODEHASH,
  decodeFlushed,
  deployAndFlushData,
  forwarderAddress,
  forwarderFeeOn,
  forwarderFlushFee,
  forwarderSalt,
  type ForwarderParams,
} from '../src/index.js';

const FACTORY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const base: ForwarderParams = {
  merchant: '0x000000000000000000000000000000000000bEEF',
  feeRecipient: '0x0000000000000000000000000000000000000FEE',
  token: '0x55d398326f99059fF775485246999027B3197955',
  feeBps: 100,
  feeCap: 10n ** 18n,
};

/** Deterministic pseudo-random bigints (xorshift), no test flakiness. */
function* rand(seed: bigint, n: number) {
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= (x << 13n) & (2n ** 64n - 1n);
    x ^= x >> 7n;
    x ^= (x << 17n) & (2n ** 64n - 1n);
    yield x;
  }
}

describe('forwarder fee math (mirrors Forwarder.flush)', () => {
  it('feeOn is exact floor(amount * bps / 10000), even near 2^256', () => {
    for (const r of rand(0x9e3779b97f4a7c15n, 500)) {
      const amount = r * 10n ** 12n;
      const bps = Number(r % 10_001n);
      expect(forwarderFeeOn(amount, bps)).toBe((amount * BigInt(bps)) / 10_000n);
    }
    expect(forwarderFeeOn(2n ** 256n - 1n, 10_000)).toBe(2n ** 256n - 1n);
  });

  it('one flush charges exactly what the off-chain rule charges: fee on min(received, expected), fixed fee 0', () => {
    for (const r of rand(0x1234567n, 500)) {
      const expected = (r % 10n ** 9n) * 10n ** 12n + 1n;
      const received = ((r >> 20n) % 10n ** 9n) * 10n ** 12n;
      const bps = Number(r % 10_001n);
      const cap = computeFee(expected, bps, 0n);
      expect(forwarderFlushFee(received, bps, cap)).toBe(computeFee(feeBase(expected, received), bps, 0n));
    }
  });

  it('later flushes share the cap', () => {
    const cap = forwarderFeeOn(100n * 10n ** 18n, 100); // 1 token
    const first = forwarderFlushFee(60n * 10n ** 18n, 100, cap);
    expect(first).toBe(6n * 10n ** 17n);
    expect(forwarderFlushFee(60n * 10n ** 18n, 100, cap, first)).toBe(4n * 10n ** 17n);
    expect(forwarderFlushFee(50n * 10n ** 18n, 100, cap, cap)).toBe(0n);
    expect(() => forwarderFlushFee(1n, 100, cap, cap + 1n)).toThrow(RangeError);
  });
});

describe('forwarder address (mirrors ForwarderFactory.predict)', () => {
  const salt = forwarderSalt('01a1baa1-0000-7000-8000-000000000001');

  it('is deterministic and checksummed', () => {
    const a = forwarderAddress(FACTORY, salt, base);
    expect(a).toBe(getAddress(a));
    expect(forwarderAddress(FACTORY, salt, { ...base, merchant: base.merchant.toLowerCase() })).toBe(a);
  });

  it('every argument changes the address', () => {
    const a = forwarderAddress(FACTORY, salt, base);
    const other = '0x000000000000000000000000000000000000bad1';
    for (const p of [
      { ...base, merchant: other },
      { ...base, feeRecipient: other },
      { ...base, token: other },
      { ...base, feeBps: 101 },
      { ...base, feeCap: base.feeCap + 1n },
    ]) {
      expect(forwarderAddress(FACTORY, salt, p)).not.toBe(a);
    }
    expect(forwarderAddress(FACTORY, forwarderSalt('another-id'), base)).not.toBe(a);
    expect(forwarderAddress('0x0000000000000000000000000000000000000001', salt, base)).not.toBe(a);
  });

  it('refuses what the contract refuses', () => {
    expect(() => forwarderAddress(FACTORY, salt, { ...base, merchant: '0x0000000000000000000000000000000000000000' })).toThrow(/merchant/);
    // mixed case with a wrong EIP-55 checksum = probably a typo: refused (all-lowercase is fine)
    expect(() => forwarderAddress(FACTORY, salt, { ...base, merchant: '0x000000000000000000000000000000000000BeEf' })).toThrow(/merchant/);
    expect(() => forwarderAddress(FACTORY, salt, { ...base, feeBps: 10_001 })).toThrow(/feeBps/);
    expect(() => forwarderAddress(FACTORY, salt, { ...base, feeBps: 1.5 })).toThrow(/feeBps/);
    expect(() => forwarderAddress(FACTORY, salt, { ...base, feeCap: -1n })).toThrow(/feeCap/);
    expect(() => deployAndFlushData(salt, base, [])).toThrow(/asset/);
  });

  it('salt is per deposit address row', () => {
    expect(forwarderSalt('a')).not.toBe(forwarderSalt('b'));
    expect(forwarderSalt('a')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(FORWARDER_FACTORY_CODEHASH).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('decodeFlushed', () => {
  it('reads Flushed events of the given forwarder only', () => {
    const fwd = '0x00000000000000000000000000000000000000AA';
    const topics = encodeEventTopics({ abi: FORWARDER_ABI, eventName: 'Flushed', args: { asset: base.token } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [99n, 1n]);
    const logs = [
      { address: fwd, topics, data },
      { address: '0x00000000000000000000000000000000000000bb', topics, data },
      { address: fwd, topics: ['0x' + '00'.repeat(32)] as Hex[], data },
    ];
    expect(decodeFlushed(logs, fwd.toLowerCase())).toEqual([{ asset: getAddress(base.token), toMerchant: 99n, fee: 1n }]);
  });
});
