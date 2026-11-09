// MONEY-CRITICAL
// Merchant whitelists (D-109). Address whitelist, per mode: while on, payouts to the merchant's users (D-100) go only
// to active whitelisted addresses (also enforced by the database, 0058). IP whitelist, both modes: while on, the
// merchant's secret API keys work only from listed addresses (publishable keys run in browsers and are exempt).
// Switching on applies at once; switching off is scheduled whitelist_disable_hours ahead (console setting) and stays
// cancellable until then. A whitelist whose scheduled time has passed reads as off everywhere.
import { AppError } from '@gw/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../common/db.js';
import { chains, merchantSecuritySettings, whitelistedAddresses } from '../../db/schema.js';
import { ipAllowed } from '../auth/guards.js';

export type SecurityRow = typeof merchantSecuritySettings.$inferSelect;
export interface Switch {
  /** On now (a scheduled switch-off that has not happened yet still counts as on). */
  on: boolean;
  /** When a requested switch-off takes effect; null when none is scheduled. */
  disableAt: Date | null;
}

const isOn = (flag: boolean, disableAt: Date | null, now: number) => flag && (disableAt === null || disableAt.getTime() > now);
const sw = (flag: boolean, disableAt: Date | null, now: number): Switch => {
  const on = isOn(flag, disableAt, now);
  return { on, disableAt: on ? disableAt : null };
};

export const addressSwitch = (row: SecurityRow | undefined, livemode: boolean, now: number): Switch =>
  !row ? { on: false, disableAt: null } : livemode ? sw(row.addressesLive, row.addressesLiveDisableAt, now) : sw(row.addressesTest, row.addressesTestDisableAt, now);

export const ipSwitch = (row: SecurityRow | undefined, now: number): Switch => (!row ? { on: false, disableAt: null } : sw(row.ips, row.ipsDisableAt, now));

export async function securityRow(tx: Tx, merchantId: string, lock = false): Promise<SecurityRow | undefined> {
  const q = tx.select().from(merchantSecuritySettings).where(eq(merchantSecuritySettings.merchantId, merchantId));
  const [r] = lock ? await q.for('update') : await q;
  return r;
}

/** The row for an update, created if missing, locked, with switch-offs that are due applied. */
export async function lockedSecurityRow(tx: Tx, merchantId: string, now: number): Promise<SecurityRow> {
  await tx.insert(merchantSecuritySettings).values({ merchantId }).onConflictDoNothing();
  const r = await securityRow(tx, merchantId, true);
  /* v8 ignore next -- just inserted or already there */
  if (!r) throw new Error('merchant_security_settings row missing');
  const due = (flag: boolean, at: Date | null) => flag && at !== null && at.getTime() <= now;
  const patch: Partial<SecurityRow> = {};
  if (due(r.addressesLive, r.addressesLiveDisableAt)) Object.assign(patch, { addressesLive: false, addressesLiveDisableAt: null });
  if (due(r.addressesTest, r.addressesTestDisableAt)) Object.assign(patch, { addressesTest: false, addressesTestDisableAt: null });
  if (due(r.ips, r.ipsDisableAt)) Object.assign(patch, { ips: false, ipsDisableAt: null });
  if (Object.keys(patch).length === 0) return r;
  const [u] = await tx.update(merchantSecuritySettings).set(patch).where(eq(merchantSecuritySettings.merchantId, merchantId)).returning();
  /* v8 ignore next -- the row is locked */
  if (!u) throw new Error('merchant_security_settings update failed');
  return u;
}

/** Status of a whitelisted address at `now`. */
export const addressStatus = (a: { removedAt: Date | null; activatesAt: Date }, now: number) =>
  a.removedAt ? 'removed' : a.activatesAt.getTime() > now ? 'pending' : 'active';

/**
 * Refuses a customer payout to an address that is not an active whitelisted address while the address whitelist is
 * on for that mode. `address` is checksummed by the caller.
 */
export async function assertPayoutWhitelisted(tx: Tx, p: { merchantId: string; livemode: boolean; chainId: string; address: string; now: number }): Promise<void> {
  if (!addressSwitch(await securityRow(tx, p.merchantId), p.livemode, p.now).on) return;
  const [c] = await tx.select({ family: chains.family }).from(chains).where(eq(chains.id, p.chainId));
  const [w] = await tx
    .select({ activatesAt: whitelistedAddresses.activatesAt, removedAt: whitelistedAddresses.removedAt })
    .from(whitelistedAddresses)
    .where(
      and(
        eq(whitelistedAddresses.merchantId, p.merchantId),
        eq(whitelistedAddresses.livemode, p.livemode),
        eq(whitelistedAddresses.family, c?.family ?? 'evm'),
        sql`lower(${whitelistedAddresses.address}) = lower(${p.address})`,
        isNull(whitelistedAddresses.removedAt),
      ),
    );
  if (!w) throw new AppError('forbidden', 'this address is not on your payout whitelist', { field: 'to_address', reason: 'address_not_whitelisted' });
  if (addressStatus(w, p.now) === 'pending') {
    throw new AppError('forbidden', `this whitelisted address becomes usable at ${w.activatesAt.toISOString()}`, { field: 'to_address', reason: 'address_pending' });
  }
}

/** Secret API keys only work from the IP whitelist while it is on (checked at authentication). */
export function ipWhitelistAllows(row: SecurityRow | undefined, ip: string, now: number): boolean {
  if (!row || !ipSwitch(row, now).on) return true;
  return ipAllowed(
    ip,
    row.ipEntries.map((e) => e.cidr),
  );
}
