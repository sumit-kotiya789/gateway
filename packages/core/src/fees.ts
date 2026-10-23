// MONEY-CRITICAL
// Platform fee math (D-011). Integer minor units only; rounding always favors the merchant.

export const MAX_FEE_BPS = 10_000;

/**
 * What the fee is charged on: the amount received, capped at the amount expected. An overpayment is the payer's money
 * (refundable), not revenue; an accepted underpayment is charged on what actually arrived.
 */
export function feeBase(expected: bigint, received: bigint): bigint {
  if (expected <= 0n) throw new RangeError('expected amount must be positive');
  if (received < 0n) throw new RangeError('received amount cannot be negative');
  return received < expected ? received : expected;
}

/** floor(base * bps / 10000) + fixed, never more than the base itself. */
export function computeFee(base: bigint, bps: number, fixed = 0n): bigint {
  if (base < 0n) throw new RangeError('fee base cannot be negative');
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) throw new RangeError(`fee bps must be an integer in [0, ${MAX_FEE_BPS}]`);
  if (fixed < 0n) throw new RangeError('fixed fee cannot be negative');
  const fee = (base * BigInt(bps)) / 10_000n + fixed;
  return fee > base ? base : fee;
}
