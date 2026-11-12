// Dashboard home (D-110): payments over time per token, the period against the one before it, status mix, the
// payment funnel, recent invoices, API traffic and the account's security posture. One call, one mode. account:read.
import { fromMinorUnits, sumUnits } from '@gw/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenant } from '../../common/db.js';
import { apiKeys, invoices, merchantUsers, tokens, webhookEndpoints } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { authedUser, requirePermission, requireUser } from '../auth/guards.js';
import { addressSwitch, ipSwitch, securityRow } from '../security/whitelist.js';

const PAID = sql`('paid', 'overpaid', 'settled', 'partially_paid')`;

export function overviewRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get(
      '/',
      {
        preHandler: requirePermission('account:read'),
        schema: { querystring: z.strictObject({ livemode: z.stringbool(), days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), 'one of 7, 30, 90').default(30) }) },
      },
      async (req) => {
        const user = authedUser(req);
        const { livemode, days } = req.query;
        const now = deps.clock();
        const to = new Date(now).toISOString();
        const from = new Date(now - days * 86_400_000).toISOString();
        const prevFrom = new Date(now - 2 * days * 86_400_000).toISOString();
        const m = user.merchantId;
        return withTenant(deps.db, m, async (tx) => {
          // Daily: invoices created, paid, and paid volume per token (by the invoice's creation day).
          const daily = (
            await tx.execute<{ t: string; token_id: string | null; created: number; paid: number; volume: string | null }>(sql`
              select g.t, i.token_id,
                count(i.id)::int as created,
                count(i.id) filter (where i.status in ${PAID})::int as paid,
                sum(i.amount_received) filter (where i.status in ${PAID})::text as volume
              from generate_series(date_trunc('day', ${from}::timestamptz) + interval '1 day', date_trunc('day', ${to}::timestamptz), interval '1 day') as g(t)
              left join invoices i on i.merchant_id = ${m} and i.livemode = ${livemode} and date_trunc('day', i.created_at) = g.t
              group by g.t, i.token_id order by g.t`)
          ).rows;
          const tokenRows = await tx.select({ id: tokens.id, symbol: tokens.symbol, decimals: tokens.decimals }).from(tokens);
          const tok = new Map(tokenRows.map((t) => [t.id, t]));
          const units = (tokenId: string | null, v: string | null) => {
            const t = tokenId ? tok.get(tokenId) : undefined;
            return t && v ? fromMinorUnits(BigInt(v), t.decimals) : '0';
          };
          // Keyed by symbol: one symbol on several chains (USDT on BSC, Ethereum, Polygon, D-112) adds up, never overwrites.
          const addTo = (into: Record<string, string>, tokenId: string, v: string) => {
            const sym = tok.get(tokenId)?.symbol ?? tokenId;
            const prev = into[sym];
            into[sym] = prev === undefined ? units(tokenId, v) : sumUnits([prev, units(tokenId, v)]);
          };
          const byDay = new Map<string, { t: string; created: number; paid: number; volume: Record<string, string> }>();
          for (const r of daily) {
            const t = new Date(r.t).toISOString();
            const d = byDay.get(t) ?? { t, created: 0, paid: 0, volume: {} };
            d.created += r.created;
            d.paid += r.paid;
            if (r.token_id && r.volume) addTo(d.volume, r.token_id, r.volume);
            byDay.set(t, d);
          }

          // This period and the previous one, for the deltas.
          const period = async (a: string, b: string) => {
            const rows = (
              await tx.execute<{ token_id: string; created: number; paid: number; volume: string | null; fees: string | null }>(sql`
                select token_id, count(*)::int as created, count(*) filter (where status in ${PAID})::int as paid,
                  sum(amount_received) filter (where status in ${PAID})::text as volume,
                  sum(fee_amount) filter (where status in ${PAID})::text as fees
                from invoices where merchant_id = ${m} and livemode = ${livemode} and created_at > ${a}::timestamptz and created_at <= ${b}::timestamptz
                group by token_id`)
            ).rows;
            const created = rows.reduce((s, r) => s + r.created, 0);
            const paid = rows.reduce((s, r) => s + r.paid, 0);
            const volume: Record<string, string> = {};
            const fees: Record<string, string> = {};
            for (const r of rows) {
              if (r.volume) addTo(volume, r.token_id, r.volume);
              if (r.fees) addTo(fees, r.token_id, r.fees);
            }
            return { created, paid, conversion: created > 0 ? paid / created : 0, volume, fees };
          };
          const current = await period(from, to);
          const previous = await period(prevFrom, from);

          const statuses = Object.fromEntries(
            (
              await tx.execute<{ status: string; n: number }>(sql`
                select status, count(*)::int as n from invoices
                where merchant_id = ${m} and livemode = ${livemode} and created_at > ${from}::timestamptz group by status`)
            ).rows.map((r) => [r.status, r.n]),
          );
          const [funnel] = (
            await tx.execute<{ created: number; seen: number; paid: number; settled: number }>(sql`
              select count(*)::int as created,
                count(*) filter (where amount_received > 0 or status in ('detected', 'confirming'))::int as seen,
                count(*) filter (where status in ${PAID})::int as paid,
                count(*) filter (where status = 'settled')::int as settled
              from invoices where merchant_id = ${m} and livemode = ${livemode} and created_at > ${from}::timestamptz`)
          ).rows;
          const [open] = (
            await tx.execute<{ open: number; attention: number }>(sql`
              select count(*) filter (where status in ('pending', 'detected', 'confirming'))::int as open,
                count(*) filter (where status in ('underpaid', 'held', 'late_payment'))::int as attention
              from invoices where merchant_id = ${m} and livemode = ${livemode}`)
          ).rows;

          const recent = (
            await tx
              .select({ id: invoices.id, status: invoices.status, amount: invoices.amountExpected, received: invoices.amountReceived, tokenId: invoices.tokenId, createdAt: invoices.createdAt, orderId: invoices.externalOrderId })
              .from(invoices)
              .where(and(eq(invoices.merchantId, m), eq(invoices.livemode, livemode)))
              .orderBy(desc(invoices.createdAt))
              .limit(6)
          ).map((i) => ({
            id: i.id,
            status: i.status,
            amount: units(i.tokenId, i.amount.toString()),
            amount_received: units(i.tokenId, i.received.toString()),
            token: i.tokenId,
            symbol: tok.get(i.tokenId)?.symbol ?? i.tokenId,
            order_id: i.orderId,
            created_at: i.createdAt.toISOString(),
          }));

          const api = (
            await tx.execute<{ t: string; requests: number; errors: number }>(sql`
              select g.t, coalesce(sum(u.requests) filter (where u.status_class <> 0), 0)::int as requests,
                coalesce(sum(u.requests) filter (where u.status_class in (4, 5)), 0)::int as errors
              from generate_series(date_trunc('day', ${from}::timestamptz) + interval '1 day', date_trunc('day', ${to}::timestamptz), interval '1 day') as g(t)
              left join api_key_usage u on date_trunc('day', u.bucket) = g.t
                and u.key_id in (select id from api_keys where merchant_id = ${m} and livemode = ${livemode})
              group by g.t order by g.t`)
          ).rows.map((r) => ({ t: new Date(r.t).toISOString(), requests: r.requests, errors: r.errors }));

          const sec = await securityRow(tx, m);
          const [me] = await tx.select({ totp: merchantUsers.totpEnabledAt, verified: merchantUsers.emailVerifiedAt }).from(merchantUsers).where(eq(merchantUsers.id, user.id));
          const [team] = (
            await tx.execute<{ members: number; with_2fa: number }>(sql`select count(*)::int as members, count(totp_enabled_at)::int as with_2fa from merchant_users where merchant_id = ${m}`)
          ).rows;
          const [keys] = await tx.select({ n: sql<number>`count(*)::int` }).from(apiKeys).where(and(eq(apiKeys.merchantId, m), eq(apiKeys.livemode, livemode), sql`${apiKeys.revokedAt} is null`));
          const [hooks] = await tx.select({ n: sql<number>`count(*)::int` }).from(webhookEndpoints).where(and(eq(webhookEndpoints.merchantId, m), eq(webhookEndpoints.livemode, livemode)));

          return {
            livemode,
            days,
            series: [...byDay.values()],
            current,
            previous,
            statuses,
            funnel: funnel ?? { created: 0, seen: 0, paid: 0, settled: 0 },
            open: open?.open ?? 0,
            attention: open?.attention ?? 0,
            recent,
            api,
            security: {
              totp: Boolean(me?.totp),
              email_verified: Boolean(me?.verified),
              team_members: team?.members ?? 0,
              team_with_2fa: team?.with_2fa ?? 0,
              address_whitelist: addressSwitch(sec, livemode, now).on,
              ip_whitelist: ipSwitch(sec, now).on,
              api_keys: keys?.n ?? 0,
              webhooks: hooks?.n ?? 0,
            },
          };
        });
      },
    );
  };
}
