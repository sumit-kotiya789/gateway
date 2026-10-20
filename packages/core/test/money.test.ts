import { describe, expect, it } from 'vitest';
import { AppError, MAX_UINT256, fromMinorUnits, toMinorUnits } from '../src/index.js';

describe('toMinorUnits', () => {
  it.each([
    ['25', 18, 25n * 10n ** 18n],
    ['25.00', 6, 25_000_000n],
    ['0.5', 6, 500_000n],
    ['0', 18, 0n],
    ['0.000001', 6, 1n],
    ['123456789.123456789012345678', 18, 123456789123456789012345678n],
    ['7', 0, 7n],
  ])('%s @%d -> %s', (input, dec, want) => {
    expect(toMinorUnits(input, dec)).toBe(want);
  });

  it.each([
    '', ' 1', '1 ', '-1', '+1', '1e6', '1E2', '.5', '5.', '01', '00.1', '1,5', '0x10', 'NaN', 'Infinity', '1.2.3', '１',
  ])('rejects malformed %j', (input) => {
    expect(() => toMinorUnits(input, 6)).toThrow(AppError);
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => toMinorUnits('0.0000001', 6)).toThrow(/more than 6 decimal/);
    expect(() => toMinorUnits('1.5', 0)).toThrow(AppError);
  });

  it('rejects non-string input', () => {
    expect(() => toMinorUnits(25 as unknown as string, 6)).toThrow(AppError);
  });

  it('rejects overlong input and values above uint256', () => {
    expect(() => toMinorUnits('1'.repeat(101), 0)).toThrow(AppError);
    expect(toMinorUnits(MAX_UINT256.toString(), 0)).toBe(MAX_UINT256);
    expect(() => toMinorUnits((MAX_UINT256 + 1n).toString(), 0)).toThrow(/too large/);
  });

  it('rejects invalid decimals config', () => {
    for (const d of [-1, 78, 1.5, Number.NaN]) expect(() => toMinorUnits('1', d)).toThrow(RangeError);
  });

  it('error carries invalid_amount code and 400 status', () => {
    try {
      toMinorUnits('abc', 6);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('invalid_amount');
      expect((e as AppError).status).toBe(400);
    }
  });
});

describe('fromMinorUnits', () => {
  it.each([
    [25_000_000n, 6, '25'],
    [25_500_000n, 6, '25.5'],
    [1n, 6, '0.000001'],
    [1n, 18, '0.000000000000000001'],
    [0n, 18, '0'],
    [7n, 0, '7'],
  ])('%s @%d -> %s', (v, dec, want) => {
    expect(fromMinorUnits(v, dec)).toBe(want);
  });

  it('rejects negative, out-of-range and non-bigint', () => {
    expect(() => fromMinorUnits(-1n, 6)).toThrow(RangeError);
    expect(() => fromMinorUnits(MAX_UINT256 + 1n, 6)).toThrow(RangeError);
    expect(() => fromMinorUnits(5 as unknown as bigint, 6)).toThrow(RangeError);
    expect(() => fromMinorUnits(1n, 78)).toThrow(RangeError);
  });

  it('round-trips', () => {
    for (const s of ['0', '1', '0.1', '25.5', '999999.999999', '0.000001']) {
      expect(fromMinorUnits(toMinorUnits(s, 6), 6)).toBe(s);
    }
  });
});
