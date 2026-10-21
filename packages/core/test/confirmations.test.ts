import { describe, expect, it } from 'vitest';
import { isConfirmed, requiredConfirmations } from '../src/index.js';

const E18 = 10n ** 18n;
const token = {
  minConfirmations: 15,
  confirmationTiers: [
    { minAmount: 10_000n * E18, confirmations: 30 },
    { minAmount: 100_000n * E18, confirmations: 60 },
  ],
};

describe('requiredConfirmations', () => {
  it.each([
    [0n, 15],
    [1n, 15],
    [10_000n * E18 - 1n, 15],
    [10_000n * E18, 30],
    [99_999n * E18, 30],
    [100_000n * E18, 60],
    [10n ** 30n, 60],
  ])('amount %s -> %i', (amount, want) => {
    expect(requiredConfirmations(token, amount)).toBe(want);
  });

  it('tier order does not matter; tiers below the minimum never lower it', () => {
    const shuffled = { minConfirmations: 15, confirmationTiers: [...token.confirmationTiers].reverse() };
    expect(requiredConfirmations(shuffled, 100_000n * E18)).toBe(60);
    expect(requiredConfirmations({ minConfirmations: 20, confirmationTiers: [{ minAmount: 0n, confirmations: 5 }] }, 1n)).toBe(20);
  });
});

describe('isConfirmed', () => {
  it('requires latest - txBlock >= required', () => {
    expect(isConfirmed({ txBlock: 100n, latest: 115n, finalized: null, required: 15 })).toBe(true);
    expect(isConfirmed({ txBlock: 100n, latest: 114n, finalized: null, required: 15 })).toBe(false);
  });

  it('requires the tx block to be finalized when finality is known', () => {
    expect(isConfirmed({ txBlock: 100n, latest: 200n, finalized: 99n, required: 15 })).toBe(false);
    expect(isConfirmed({ txBlock: 100n, latest: 200n, finalized: 100n, required: 15 })).toBe(true);
  });

  it('finalized alone is not enough without the confirmation count', () => {
    expect(isConfirmed({ txBlock: 100n, latest: 105n, finalized: 105n, required: 15 })).toBe(false);
  });

  it('tx block ahead of latest (lagging RPC) is never confirmed', () => {
    expect(isConfirmed({ txBlock: 300n, latest: 200n, finalized: null, required: 0 })).toBe(false);
  });
});
