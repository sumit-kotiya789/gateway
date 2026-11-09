// MONEY-CRITICAL (two-admin withdrawal threshold)
// Admin console settings (D-106, D-107), one row: the "needs a decision" queue, admin sessions, the admin IP
// allowlist, the two-admin withdrawal threshold, merchant sign-ups and new-merchant defaults. Routes in
// settings.routes.ts; read here by the invoice queue, the admin guards, signup and withdrawal requests.
import { eq } from 'drizzle-orm';
import { withSystem, type Tx } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { ATTENTION_STATUSES, adminSettings } from '../../db/schema.js';

export type AttentionStatus = (typeof ATTENTION_STATUSES)[number];
export interface IpEntry {
  cidr: string;
  label: string;
}

export interface AdminSettings {
  attentionStatuses: AttentionStatus[];
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  ipAllowlistEnabled: boolean;
  ipAllowlist: IpEntry[];
  /** Whole token units; null = the server ceiling. */
  withdrawalTwoPersonMin: string | null;
  signupEnabled: boolean;
  merchantDefaults: { feeBps: number; feeFixed: string; feeGrace: string; payoutFee: string; underpayToleranceBps: number };
  /** Merchant whitelists (D-109): hours until a new live address works, and until a switch-off takes effect. */
  whitelistActivationHours: number;
  whitelistDisableHours: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

/** NUMERIC as stored ("0.500000") in its canonical form ("0.5"). */
export const canonicalUnits = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

/**
 * Reads the settings row. System context only (RLS): a tenant transaction sees no row, and that throws rather than
 * falling back to defaults, so a wrong context can never silently loosen a rule. From tenant code use readAdminSettings.
 */
export async function loadAdminSettings(tx: Tx): Promise<AdminSettings> {
  const [s] = await tx.select().from(adminSettings).where(eq(adminSettings.id, 1));
  // Migration 0055 inserts the row and DELETE is revoked: missing = not system context.
  if (!s) throw new Error('admin_settings not visible: read it in system context (withSystem)');
  return {
    attentionStatuses: s.attentionStatuses.filter((x): x is AttentionStatus => (ATTENTION_STATUSES as readonly string[]).includes(x)),
    sessionIdleMinutes: s.sessionIdleMinutes,
    sessionMaxHours: s.sessionMaxHours,
    ipAllowlistEnabled: s.ipAllowlistEnabled,
    ipAllowlist: s.ipAllowlist,
    withdrawalTwoPersonMin: s.withdrawalTwoPersonMin,
    signupEnabled: s.signupEnabled,
    merchantDefaults: {
      feeBps: s.defaultFeeBps,
      feeFixed: canonicalUnits(s.defaultFeeFixed),
      feeGrace: canonicalUnits(s.defaultFeeGrace),
      payoutFee: canonicalUnits(s.defaultPayoutFee),
      underpayToleranceBps: s.defaultUnderpayToleranceBps,
    },
    whitelistActivationHours: s.whitelistActivationHours,
    whitelistDisableHours: s.whitelistDisableHours,
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt,
  };
}

/** The settings from any code path, tenant transactions included: a short system-context read of its own. */
export const readAdminSettings = (deps: Deps) => withSystem(deps.db, loadAdminSettings);

/** Compares two plain non-negative decimal strings exactly (no floats): -1, 0 or 1. */
export function compareUnits(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const n = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(n, '0'));
  const y = BigInt(bi + bf.padEnd(n, '0'));
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * Live withdrawals at or above this many token units need two different admins (D-090, D-107): the console value,
 * but never above the server's WITHDRAWAL_TWO_PERSON_MIN, so one console account cannot loosen the two-person rule.
 */
export function effectiveTwoPersonMin(s: AdminSettings, ceiling: string): string {
  const v = s.withdrawalTwoPersonMin;
  return v !== null && compareUnits(v, ceiling) < 0 ? v : ceiling;
}
