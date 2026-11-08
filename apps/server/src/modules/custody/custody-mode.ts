// Leaving custody (D-098): the merchant chooses custody on or off themselves; turning it off must never strand money
// the platform holds or still expects for them.
import { AppError } from '@gw/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { invoices } from '../../db/schema.js';
import { merchantBalances } from '../ledger/ledger.js';

/** Custodial invoices that can still bring money into custody (expired / cancelled ones only via a late payment). */
const CUSTODY_OPEN = ['created', 'pending', 'detected', 'confirming', 'underpaid', 'paid', 'overpaid', 'held', 'late_payment'] as const;

/** Refuses to take a merchant out of custodial while the platform holds funds for it (any mode) or still expects some. */
export async function assertNothingInCustody(tx: Tx, merchantId: string): Promise<void> {
  for (const livemode of [false, true]) {
    for (const [token, b] of await merchantBalances(tx, merchantId, livemode)) {
      if (b.pending !== 0n || b.available !== 0n || b.withdrawing !== 0n) {
        throw new AppError('conflict', `the platform still holds your ${livemode ? 'live' : 'test'} ${token}: withdraw it all before turning custody off`, { reason: 'funds_in_custody' });
      }
    }
  }
  const [open] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.merchantId, merchantId), eq(invoices.custodyMode, 'custodial'), inArray(invoices.status, [...CUSTODY_OPEN])))
    .limit(1);
  if (open) throw new AppError('conflict', 'some custody invoices are still open: wait until they settle or expire, or cancel them', { reason: 'open_custodial_invoices' });
}
