// MONEY-CRITICAL
// How deep a payment must be before it is credited. Larger amounts wait longer (tiers).
import type { TokenConfig } from './chain.js';

/** Highest confirmation count among tiers whose minAmount <= amount, never below the token minimum. */
export function requiredConfirmations(token: Pick<TokenConfig, 'minConfirmations' | 'confirmationTiers'>, amount: bigint): number {
  let required = token.minConfirmations;
  for (const tier of token.confirmationTiers) {
    if (amount >= tier.minAmount && tier.confirmations > required) required = tier.confirmations;
  }
  return required;
}

/**
 * True when a transfer mined in `txBlock` is final enough to credit.
 * Depth = latest - txBlock (spec rule: credit only when latest - txBlock >= required; stricter by one than
 * counting the mining block).
 * When the chain reports a finalized block, the tx block must also be at or below it (D-008).
 */
export function isConfirmed(params: { txBlock: bigint; latest: bigint; finalized: bigint | null; required: number }): boolean {
  const { txBlock, latest, finalized, required } = params;
  if (txBlock > latest) return false;
  if (latest - txBlock < BigInt(required)) return false;
  return finalized === null || txBlock <= finalized;
}
