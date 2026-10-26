// MONEY-CRITICAL
// Amount conversion between API decimal strings and integer minor units.
// Rules: bigint only, never number; no rounding (excess precision is rejected);
// non-negative; must fit NUMERIC(78,0) / uint256.
import { AppError } from './errors.js';

const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_INPUT_LENGTH = 100;
export const MAX_UINT256 = (1n << 256n) - 1n;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`invalid token decimals: ${decimals}`);
  }
}

/** "25.5" with decimals 6 -> 25500000n. Throws AppError(invalid_amount) on any malformed input. */
export function toMinorUnits(amount: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof amount !== 'string' || amount.length > MAX_INPUT_LENGTH) {
    throw new AppError('invalid_amount', 'amount must be a decimal string');
  }
  const m = DECIMAL_RE.exec(amount);
  if (!m) throw new AppError('invalid_amount', 'amount must be a plain non-negative decimal string');
  const int = m[1] as string;
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new AppError('invalid_amount', `amount has more than ${decimals} decimal places`);
  }
  const value = BigInt(int + frac.padEnd(decimals, '0'));
  if (value > MAX_UINT256) throw new AppError('invalid_amount', 'amount too large');
  return value;
}

/** 25500000n with decimals 6 -> "25.5". Canonical: no trailing fractional zeros, no trailing dot. */
export function fromMinorUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) {
    throw new RangeError('minor units must be a bigint in [0, 2^256)');
  }
  if (decimals === 0) return value.toString();
  const s = value.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** Like fromMinorUnits, for balances that may be negative (e.g. a prepaid fee balance used into its grace). */
export function fromSignedMinorUnits(value: bigint, decimals: number): string {
  return value < 0n ? `-${fromMinorUnits(-value, decimals)}` : fromMinorUnits(value, decimals);
}
