// MONEY-CRITICAL
// The merchant's current payout address (D-090): where custodial withdrawals go and, in forwarder mode (D-097), where
// every forwarder deposit address pays out. Kept here (not in withdrawals) so custody code can use it without an
// import cycle. The forwarder_params DB guard enforces the same rule.
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { payoutAddresses } from '../../db/schema.js';

export type PayoutRow = typeof payoutAddresses.$inferSelect;
type Family = PayoutRow['family'];

/** Newest activated, not cancelled. */
export async function currentPayoutAddress(tx: Tx, merchantId: string, livemode: boolean, family: Family): Promise<PayoutRow | undefined> {
  const [row] = await tx
    .select()
    .from(payoutAddresses)
    .where(
      and(
        eq(payoutAddresses.merchantId, merchantId),
        eq(payoutAddresses.livemode, livemode),
        eq(payoutAddresses.family, family),
        isNull(payoutAddresses.cancelledAt),
        sql`${payoutAddresses.activatesAt} <= now()`,
      ),
    )
    .orderBy(desc(payoutAddresses.activatesAt), desc(payoutAddresses.createdAt))
    .limit(1);
  return row;
}
