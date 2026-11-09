// Admin console settings (D-106, D-107): one row, the single place to manage platform behaviour. Read by every admin;
// changed by a superadmin with step-up 2FA, audited with the before/after values.
import { AppError } from '@gw/core';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withSystem } from '../../common/db.js';
import { ATTENTION_STATUSES, adminSettings } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { ipAllowed, requireAdmin, requireAdminTotp, validIpEntry } from '../auth/guards.js';
import { feeUnits } from './admin.routes.js';
import { compareUnits, effectiveTwoPersonMin, loadAdminSettings, readAdminSettings, type AdminSettings } from './settings.js';

const view = (s: AdminSettings, deps: Deps, requestIp: string) => ({
  attention_statuses: s.attentionStatuses,
  session_idle_minutes: s.sessionIdleMinutes,
  session_max_hours: s.sessionMaxHours,
  ip_allowlist_enabled: s.ipAllowlistEnabled,
  ip_allowlist: s.ipAllowlist,
  /** The caller's address as the server sees it (after TRUST_PROXY_HOPS): what the allowlist is checked against. */
  request_ip: requestIp,
  withdrawal_two_person_min: s.withdrawalTwoPersonMin,
  withdrawal_two_person_effective: effectiveTwoPersonMin(s, deps.config.WITHDRAWAL_TWO_PERSON_MIN),
  signup_enabled: s.signupEnabled,
  merchant_defaults: {
    fee_bps: s.merchantDefaults.feeBps,
    fee_fixed: s.merchantDefaults.feeFixed,
    fee_grace: s.merchantDefaults.feeGrace,
    payout_fee: s.merchantDefaults.payoutFee,
    underpay_tolerance_bps: s.merchantDefaults.underpayToleranceBps,
  },
  whitelist_activation_hours: s.whitelistActivationHours,
  whitelist_disable_hours: s.whitelistDisableHours,
  updated_by: s.updatedBy,
  updated_at: s.updatedAt?.toISOString() ?? null,
  // Outer limits from the server environment; the console works inside them.
  platform: {
    withdrawal_two_person_max: deps.config.WITHDRAWAL_TWO_PERSON_MIN,
    signup_allowed: deps.config.SIGNUP_ENABLED,
    admin_ip_allowlist_env: deps.config.ADMIN_IP_ALLOWLIST.length,
  },
});

/** What the audit log records (before and after). */
const snapshot = (s: AdminSettings) => ({
  attention_statuses: s.attentionStatuses,
  session_idle_minutes: s.sessionIdleMinutes,
  session_max_hours: s.sessionMaxHours,
  ip_allowlist_enabled: s.ipAllowlistEnabled,
  ip_allowlist: s.ipAllowlist,
  withdrawal_two_person_min: s.withdrawalTwoPersonMin,
  signup_enabled: s.signupEnabled,
  merchant_defaults: s.merchantDefaults,
  whitelist_activation_hours: s.whitelistActivationHours,
  whitelist_disable_hours: s.whitelistDisableHours,
});

const IpEntry = z.strictObject({
  cidr: z
    .string()
    .trim()
    .toLowerCase()
    .refine(validIpEntry, 'an IP address or CIDR, e.g. 203.0.113.7 or 203.0.113.0/24'),
  label: z.string().trim().max(60).default(''),
});

const Body = z
  .strictObject({
    attention_statuses: z
      .array(z.enum(ATTENTION_STATUSES))
      .min(1, 'pick at least one status')
      .transform((a) => ATTENTION_STATUSES.filter((s) => a.includes(s)))
      .optional(),
    session_idle_minutes: z.number().int().min(5).max(240).optional(),
    session_max_hours: z.number().int().min(1).max(24).optional(),
    ip_allowlist_enabled: z.boolean().optional(),
    ip_allowlist: z
      .array(IpEntry)
      .max(50)
      .transform((a) => a.filter((e, i) => a.findIndex((x) => x.cidr === e.cidr) === i))
      .optional(),
    // Whole token units; null = the server's WITHDRAWAL_TWO_PERSON_MIN.
    withdrawal_two_person_min: z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,14}$/, 'a whole number of tokens, 1 or more')
      .nullable()
      .optional(),
    signup_enabled: z.boolean().optional(),
    merchant_defaults: z
      .strictObject({
        fee_bps: z.number().int().min(0).max(10_000),
        fee_fixed: feeUnits(1000),
        fee_grace: feeUnits(100_000),
        payout_fee: feeUnits(1000),
        underpay_tolerance_bps: z.number().int().min(0).max(500),
      })
      .optional(),
    whitelist_activation_hours: z.number().int().min(1).max(168).optional(),
    whitelist_disable_hours: z.number().int().min(1).max(168).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((b) => Object.entries(b).some(([k, v]) => k !== 'reason' && v !== undefined), 'nothing to change');

export function adminSettingsRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/', { preHandler: requireAdmin(deps, 'admin:read') }, async (req) => view(await readAdminSettings(deps), deps, req.ip));

    // Partial update: fields left out keep their value.
    app.put('/', { preHandler: [requireAdmin(deps, 'settings:manage'), requireAdminTotp(deps)], schema: { body: Body } }, async (req) => {
      const adminId = req.admin?.id;
      /* v8 ignore next -- requireAdmin runs first */
      if (!adminId) throw new AppError('unauthorized', 'authentication required');
      const b = req.body;
      const ceiling = deps.config.WITHDRAWAL_TWO_PERSON_MIN;
      if (b.withdrawal_two_person_min && compareUnits(b.withdrawal_two_person_min, ceiling) > 0) {
        throw new AppError('validation_error', `withdrawal_two_person_min: at most ${ceiling} (the server's WITHDRAWAL_TWO_PERSON_MIN)`);
      }
      return withSystem(deps.db, async (tx) => {
        await tx.select({ id: adminSettings.id }).from(adminSettings).where(eq(adminSettings.id, 1)).for('update');
        const before = await loadAdminSettings(tx);
        const md = b.merchant_defaults;
        const next: AdminSettings = {
          ...before,
          attentionStatuses: b.attention_statuses ?? before.attentionStatuses,
          sessionIdleMinutes: b.session_idle_minutes ?? before.sessionIdleMinutes,
          sessionMaxHours: b.session_max_hours ?? before.sessionMaxHours,
          ipAllowlistEnabled: b.ip_allowlist_enabled ?? before.ipAllowlistEnabled,
          ipAllowlist: b.ip_allowlist ?? before.ipAllowlist,
          withdrawalTwoPersonMin: b.withdrawal_two_person_min === undefined ? before.withdrawalTwoPersonMin : b.withdrawal_two_person_min,
          signupEnabled: b.signup_enabled ?? before.signupEnabled,
          merchantDefaults: md
            ? { feeBps: md.fee_bps, feeFixed: md.fee_fixed, feeGrace: md.fee_grace, payoutFee: md.payout_fee, underpayToleranceBps: md.underpay_tolerance_bps }
            : before.merchantDefaults,
          whitelistActivationHours: b.whitelist_activation_hours ?? before.whitelistActivationHours,
          whitelistDisableHours: b.whitelist_disable_hours ?? before.whitelistDisableHours,
        };
        if (next.ipAllowlistEnabled) {
          if (next.ipAllowlist.length === 0) throw new AppError('validation_error', 'ip_allowlist: add at least one address before switching the allowlist on');
          // Never lock out the admin making the change: their own address must stay allowed.
          if (!ipAllowed(req.ip, next.ipAllowlist.map((e) => e.cidr))) {
            throw new AppError('conflict', `your address ${req.ip} is not on the allowlist: add it first, or this change would lock you out`, { reason: 'self_lockout' });
          }
        }
        const values = {
          attentionStatuses: next.attentionStatuses,
          sessionIdleMinutes: next.sessionIdleMinutes,
          sessionMaxHours: next.sessionMaxHours,
          ipAllowlistEnabled: next.ipAllowlistEnabled,
          ipAllowlist: next.ipAllowlist,
          withdrawalTwoPersonMin: next.withdrawalTwoPersonMin,
          signupEnabled: next.signupEnabled,
          defaultFeeBps: next.merchantDefaults.feeBps,
          defaultFeeFixed: next.merchantDefaults.feeFixed,
          defaultFeeGrace: next.merchantDefaults.feeGrace,
          defaultPayoutFee: next.merchantDefaults.payoutFee,
          defaultUnderpayToleranceBps: next.merchantDefaults.underpayToleranceBps,
          whitelistActivationHours: next.whitelistActivationHours,
          whitelistDisableHours: next.whitelistDisableHours,
          updatedBy: adminId,
          updatedAt: new Date(deps.clock()),
        };
        await tx.insert(adminSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: adminSettings.id, set: values });
        await audit(
          tx,
          { actorType: 'admin', actorId: adminId, action: 'admin.settings_updated', targetType: 'admin_settings', before: snapshot(before), after: { ...snapshot(next), reason: b.reason } },
          req,
        );
        return view(await loadAdminSettings(tx), deps, req.ip);
      });
    });
  };
}
