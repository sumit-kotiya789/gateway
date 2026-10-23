import { describe, expect, it } from 'vitest';
import { computeFee, feeBase } from '../src/index.js';

describe('fees', () => {
  it.each([
    [10_000_000n, 100, 0n, 100_000n], // 10 USDT (6 dp) at 1%
    [199n, 100, 0n, 1n], // 1.99 -> floor
    [99n, 100, 0n, 0n], // rounds down to zero
    [10_000n, 0, 0n, 0n],
    [10_000n, 10_000, 0n, 10_000n],
    [10_000n, 100, 50n, 150n],
    [100n, 100, 500n, 100n], // never above the base
    [0n, 100, 5n, 0n],
  ])('computeFee(%s, %s bps, +%s) = %s', (base, bps, fixed, fee) => {
    expect(computeFee(base, bps, fixed)).toBe(fee);
  });

  it('fee base is received, capped at expected', () => {
    expect(feeBase(100n, 100n)).toBe(100n);
    expect(feeBase(100n, 150n)).toBe(100n); // overpayment not charged
    expect(feeBase(100n, 60n)).toBe(60n); // accepted underpayment charged on what arrived
  });

  it.each([
    () => computeFee(-1n, 100),
    () => computeFee(1n, -1),
    () => computeFee(1n, 10_001),
    () => computeFee(1n, 1.5),
    () => computeFee(1n, 100, -1n),
    () => feeBase(0n, 1n),
    () => feeBase(1n, -1n),
  ])('rejects invalid input %#', (fn) => {
    expect(fn).toThrow(RangeError);
  });
});
