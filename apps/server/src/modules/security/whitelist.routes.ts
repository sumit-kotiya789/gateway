// Merchant whitelists from the dashboard (D-109). Read: account:read. Change: the owner (payouts:manage) with 2FA,
// except removing an address (tightening needs no code). Every change is audited; owners get an email when live
// addresses are added and when a switch-off is scheduled.
import { AppError } from '@gw/core';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { withTenant, type Tx } from '../../common/db.js';
import { merchantSecuritySettings, whitelistedAddresses } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { readAdminSettings } from '../admin/settings.js';
import { authedUser, requirePermission, requireTotp, requireUser, validIpEntry } from '../auth/guards.js';
import { notifyOwners } from '../email/outbox.js';
import { templates } from '../email/templates.js';
import { addressStatus, addressSwitch, ipSwitch, lockedSecurityRow, securityRow, type SecurityRow, type Switch } from './whitelist.js';

const Livemode = z.stringbool();
const switchView = (s: Switch) => ({ enabled: s.on, disable_at: s.disableAt?.toISOString() ?? null });
type AddressRow = typeof whitelistedAddresses.$inferSelect;
const addressView = (a: AddressRow, now: number) => ({
  id: a.id,
  livemode: a.livemode,
  family: a.family,
  address: a.address,
  label: a.label,
  status: addressStatus(a, now),
  created_at: a.createdAt.toISOString(),
  activates_at: a.activatesAt.toISOString(),
});
const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

const IpEntry = z.strictObject({
  cidr: z.string().trim().toLowerCase().refine(validIpEntry, 'an IP address or CIDR, e.g. 203.0.113.7 or 203.0.113.0/24'),
  label: z.string().trim().max(60).default(''),
});

export function whitelistRoutes(deps: Deps): FastifyPluginAsyncZod {
  const write = [requirePermission('payouts:manage'), requireTotp(deps)];

  /** Owners are told when a switch-off is scheduled: that is what an attacker with the session would do first. */
  const scheduleOff = async (tx: Tx, merchantId: string, what: string, at: Date) =>
    notifyOwners(deps, tx, merchantId, 'whitelist_disable_scheduled', templates.whitelistDisableScheduled({ what, at: at.toISOString(), dashboardUrl: deps.config.DASHBOARD_URL }));

  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('account:read'), schema: { querystring: z.strictObject({ livemode: Livemode }) } }, async (req) => {
      const user = authedUser(req);
      const now = deps.clock();
      const settings = await readAdminSettings(deps);
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const row = await securityRow(tx, user.merchantId);
        const counts = await tx
          .select({ pending: sql<number>`count(*) filter (where ${whitelistedAddresses.activatesAt} > ${new Date(now).toISOString()}::timestamptz)::int`, total: sql<number>`count(*)::int` })
          .from(whitelistedAddresses)
          .where(and(eq(whitelistedAddresses.merchantId, user.merchantId), eq(whitelistedAddresses.livemode, req.query.livemode), isNull(whitelistedAddresses.removedAt)));
        const c = counts[0] ?? { pending: 0, total: 0 };
        return {
          livemode: req.query.livemode,
          addresses: { ...switchView(addressSwitch(row, req.query.livemode, now)), active: c.total - c.pending, pending: c.pending },
          ips: { ...switchView(ipSwitch(row, now)), entries: row?.ipEntries ?? [] },
          activation_hours: settings.whitelistActivationHours,
          disable_hours: settings.whitelistDisableHours,
          request_ip: req.ip,
        };
      });
    });

    // Address whitelist on (at once) or off (scheduled; on again cancels the schedule).
    app.put('/addresses', { preHandler: write, schema: { body: z.strictObject({ livemode: z.boolean(), enabled: z.boolean() }) } }, async (req) => {
      const user = authedUser(req);
      const { livemode, enabled } = req.body;
      const now = deps.clock();
      const hours = (await readAdminSettings(deps)).whitelistDisableHours;
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const row = await lockedSecurityRow(tx, user.merchantId, now);
        const before = addressSwitch(row, livemode, now);
        const flag = livemode ? 'addressesLive' : 'addressesTest';
        const at = livemode ? 'addressesLiveDisableAt' : 'addressesTestDisableAt';
        let patch: Partial<SecurityRow> = {};
        if (enabled) patch = { [flag]: true, [at]: null };
        else if (before.on && !before.disableAt) patch = { [at]: new Date(now + hours * 3_600_000) };
        if (Object.keys(patch).length > 0) {
          const [u] = await tx.update(merchantSecuritySettings).set({ ...patch, updatedBy: user.id, updatedAt: new Date(now) }).where(eq(merchantSecuritySettings.merchantId, user.merchantId)).returning();
          const after = addressSwitch(u, livemode, now);
          await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'whitelist.addresses', before: { livemode, ...switchView(before) }, after: { livemode, ...switchView(after) } }, req);
          if (after.disableAt) await scheduleOff(tx, user.merchantId, `${livemode ? 'live' : 'test'} payout address`, after.disableAt);
          return switchView(after);
        }
        return switchView(before);
      });
    });

    app.get(
      '/addresses',
      { preHandler: requirePermission('account:read'), schema: { querystring: z.strictObject({ livemode: Livemode, q: z.string().trim().max(100).optional() }) } },
      async (req) => {
        const user = authedUser(req);
        const now = deps.clock();
        const q = req.query.q;
        const rows = await withTenant(deps.db, user.merchantId, (tx) =>
          tx
            .select()
            .from(whitelistedAddresses)
            .where(
              and(
                eq(whitelistedAddresses.merchantId, user.merchantId),
                eq(whitelistedAddresses.livemode, req.query.livemode),
                isNull(whitelistedAddresses.removedAt),
                q ? or(ilike(whitelistedAddresses.address, like(q)), ilike(whitelistedAddresses.label, like(q))) : undefined,
              ),
            )
            .orderBy(desc(whitelistedAddresses.createdAt))
            .limit(500),
        );
        return { data: rows.map((r) => addressView(r, now)) };
      },
    );

    // Add one address or a CSV's worth. Invalid lines and duplicates are reported back, not fatal.
    app.post(
      '/addresses',
      {
        preHandler: write,
        schema: {
          body: z.strictObject({
            livemode: z.boolean(),
            entries: z.array(z.strictObject({ address: z.string().trim().max(100), label: z.string().trim().max(60).default('') })).min(1).max(500),
          }),
        },
      },
      async (req, reply) => {
        const user = authedUser(req);
        const { livemode, entries } = req.body;
        const now = deps.clock();
        const hours = (await readAdminSettings(deps)).whitelistActivationHours;
        // Database time, like payout addresses: the payout guard compares against the database clock.
        const activatesAt = livemode ? sql`now() + make_interval(hours => ${hours})` : sql`now()`;
        const invalid: { address: string; reason: string }[] = [];
        const valid = new Map<string, string>();
        for (const e of entries) {
          if (!isAddress(e.address, { strict: true })) {
            invalid.push({ address: e.address, reason: /^0x[0-9a-fA-F]{40}$/.test(e.address) ? 'checksum does not match: check for a typo' : 'not an EVM address' });
            continue;
          }
          const a = getAddress(e.address);
          if (!valid.has(a.toLowerCase())) valid.set(a.toLowerCase(), JSON.stringify([a, e.label]));
        }
        const out = await withTenant(deps.db, user.merchantId, async (tx) => {
          const added: AddressRow[] = [];
          let skipped = 0;
          for (const v of valid.values()) {
            const [address, label] = JSON.parse(v) as [string, string];
            const [ok] = (await tx.execute<{ allowed: boolean }>(sql`select payout_destination_allowed(${address}) as allowed`)).rows;
            if (!ok?.allowed) {
              invalid.push({ address, reason: 'a gateway or blocked address cannot receive payouts' });
              continue;
            }
            const [row] = await tx
              .insert(whitelistedAddresses)
              .values({ merchantId: user.merchantId, livemode, family: 'evm', address, label, createdBy: user.id, activatesAt })
              .onConflictDoNothing()
              .returning();
            if (row) added.push(row);
            else skipped++;
          }
          const first = added[0];
          if (first) {
            const at = first.activatesAt.toISOString();
            await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'whitelist.address_added', after: { livemode, addresses: added.map((a) => a.address), activates_at: at } }, req);
            await notifyOwners(deps, tx, user.merchantId, 'whitelist_addresses_added', templates.whitelistAddressesAdded({ livemode, count: added.length, activatesAt: at, dashboardUrl: deps.config.DASHBOARD_URL }));
          }
          return { added: added.map((a) => addressView(a, now)), skipped, invalid };
        });
        return reply.status(out.added.length > 0 ? 201 : 200).send(out);
      },
    );

    app.post('/addresses/:id/remove', { preHandler: requirePermission('payouts:manage'), schema: { params: z.strictObject({ id: z.uuid() }) } }, async (req, reply) => {
      const user = authedUser(req);
      const now = deps.clock();
      await withTenant(deps.db, user.merchantId, async (tx) => {
        const [r] = await tx
          .update(whitelistedAddresses)
          .set({ removedAt: new Date(now), removedBy: user.id })
          .where(and(eq(whitelistedAddresses.id, req.params.id), eq(whitelistedAddresses.merchantId, user.merchantId), isNull(whitelistedAddresses.removedAt)))
          .returning();
        if (!r) throw new AppError('not_found', 'whitelisted address not found');
        await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'whitelist.address_removed', targetType: 'whitelisted_address', targetId: r.id, before: { livemode: r.livemode, address: r.address } }, req);
      });
      return reply.status(204).send();
    });

    // IP whitelist: entries (replace) and/or the switch. On needs an entry; off is scheduled.
    app.put(
      '/ips',
      {
        preHandler: write,
        schema: {
          body: z
            .strictObject({
              enabled: z.boolean().optional(),
              entries: z
                .array(IpEntry)
                .max(100)
                .transform((a) => a.filter((e, i) => a.findIndex((x) => x.cidr === e.cidr) === i))
                .optional(),
            })
            .refine((b) => b.enabled !== undefined || b.entries !== undefined, 'nothing to change'),
        },
      },
      async (req) => {
        const user = authedUser(req);
        const now = deps.clock();
        const hours = (await readAdminSettings(deps)).whitelistDisableHours;
        return withTenant(deps.db, user.merchantId, async (tx) => {
          const row = await lockedSecurityRow(tx, user.merchantId, now);
          const before = ipSwitch(row, now);
          const entries = req.body.entries ?? row.ipEntries;
          const patch: Partial<SecurityRow> = { ipEntries: entries };
          if (req.body.enabled === true) Object.assign(patch, { ips: true, ipsDisableAt: null });
          else if (req.body.enabled === false && before.on && !before.disableAt) patch.ipsDisableAt = new Date(now + hours * 3_600_000);
          if ((patch.ips ?? row.ips) && entries.length === 0) {
            throw new AppError('validation_error', 'add at least one IP address while the IP whitelist is on', { field: 'entries' });
          }
          const [u] = await tx.update(merchantSecuritySettings).set({ ...patch, updatedBy: user.id, updatedAt: new Date(now) }).where(eq(merchantSecuritySettings.merchantId, user.merchantId)).returning();
          const after = ipSwitch(u, now);
          await audit(
            tx,
            { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'whitelist.ips', before: { ...switchView(before), entries: row.ipEntries }, after: { ...switchView(after), entries } },
            req,
          );
          if (after.disableAt && !before.disableAt) await scheduleOff(tx, user.merchantId, 'API IP', after.disableAt);
          return { ...switchView(after), entries };
        });
      },
    );
  };
}

