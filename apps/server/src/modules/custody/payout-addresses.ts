// MONEY-CRITICAL
// The merchant's payout wallets (D-090, D-114). The current one (newest active) is where forwarders pay (D-097) and
// the default for withdrawals; a self withdrawal may pick any active wallet. Kept here (not in withdrawals) so custody
// code can use it without an import cycle. The forwarder_params and withdrawals DB guards enforce the same rules.
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

/**
 * One of the merchant's saved payout wallets (D-114), usable now: its own, this mode and family, activated (live: 24 h
 * after it was added, owners emailed) and not removed. Self withdrawals may go to any of them; the withdrawal guard in
 * the database and the signer check the same rule.
 */
export async function activePayoutAddress(tx: Tx, merchantId: string, livemode: boolean, family: Family, id: string): Promise<PayoutRow | undefined> {
  const [row] = await tx
    .select()
    .from(payoutAddresses)
    .where(
      and(
        eq(payoutAddresses.id, id),
        eq(payoutAddresses.merchantId, merchantId),
        eq(payoutAddresses.livemode, livemode),
        eq(payoutAddresses.family, family),
        isNull(payoutAddresses.cancelledAt),
        sql`${payoutAddresses.activatesAt} <= now()`,
      ),
    );
  return row;
}
