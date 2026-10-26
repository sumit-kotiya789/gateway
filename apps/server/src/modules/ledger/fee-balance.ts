// MONEY-CRITICAL
// Prepaid fee balance (D-076). Per merchant, mode and token: prepaid = -(merchant_fees_owed balance), i.e. top-ups
// minus fees charged. Live invoices need prepaid + grace > 0; test mode is never blocked.
import { AppError, feeBalanceStatus, feeUnitsToMinor, toMinorUnits, type FeeBalanceStatus } from '@gw/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { ledgerAccounts, ledgerEntries } from '../../db/schema.js';

/** Below this headroom (token units) the merchant is warned to top up. */
export const FEE_LOW_BALANCE = '10';

export interface FeeBalance {
  prepaid: bigint;
  grace: bigint;
  status: FeeBalanceStatus | 'not_enforced';
}

export async function feesOwed(tx: Tx, merchantId: string, livemode: boolean, tokenId: string): Promise<bigint> {
  const [r] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerAccounts.kind, 'merchant_fees_owed'),
        eq(ledgerAccounts.merchantId, merchantId),
        eq(ledgerAccounts.livemode, livemode),
        eq(ledgerAccounts.tokenId, tokenId),
      ),
    );
  /* v8 ignore next -- invariant: an aggregate without GROUP BY returns exactly one row */
  if (!r) throw new Error('fee balance query returned no row');
  return BigInt(r.total);
}

/** Balance state from what is owed (minor units) and the merchant's grace setting (token units). */
export function feeBalanceOf(livemode: boolean, owed: bigint, graceUnits: string, decimals: number): FeeBalance {
  const prepaid = -owed;
  const grace = feeUnitsToMinor(graceUnits, decimals);
  const status = livemode ? feeBalanceStatus(prepaid, grace, toMinorUnits(FEE_LOW_BALANCE, decimals)) : 'not_enforced';
  return { prepaid, grace, status };
}

/**
 * Refuses a new live invoice in `token` when the merchant's prepaid fee balance (plus grace, the merchant's `fee_grace`
 * setting in token units) is used up.
 */
export async function assertFeeBalance(
  tx: Tx,
  merchantId: string,
  livemode: boolean,
  token: { id: string; decimals: number; symbol: string },
  graceUnits: string,
): Promise<void> {
  if (!livemode) return;
  const b = feeBalanceOf(livemode, await feesOwed(tx, merchantId, livemode, token.id), graceUnits, token.decimals);
  if (b.status === 'blocked') {
    throw new AppError('insufficient_fee_balance', `prepaid fee balance for ${token.symbol} (${token.id}) is used up; top it up to create live invoices`, {
      token: token.id,
    });
  }
}
