// API key analytics for the dashboard (D-110): per-key traffic over time, endpoints, status mix, latency, and the
// key's digital fingerprint (every IP + user agent it was used from, with first/last seen). api_keys:read.
import { AppError } from '@gw/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenant, type Tx } from '../../common/db.js';
import { apiKeyClients, apiKeys } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { authedUser, ipAllowed, requirePermission, requireUser } from '../auth/guards.js';
import { ipSwitch, securityRow } from '../security/whitelist.js';

const Days = z.coerce.number().int().refine((d) => [1, 7, 30, 90].includes(d), 'one of 1, 7, 30, 90').default(7);

interface SeriesRow {
  t: string;
  ok: number;
  errors: number;
  blocked: number;
  total_ms: number;
  [k: string]: unknown;
}

/** Requests per hour (1 day) or per day, gaps filled, split into ok (2xx/3xx), errors (4xx/5xx) and blocked. */
async function series(tx: Tx, where: ReturnType<typeof sql>, days: number, now: number) {
  const unit = days === 1 ? 'hour' : 'day';
  const to = new Date(now).toISOString();
  const r = await tx.execute<SeriesRow>(sql`
    select g.t,
      coalesce(sum(u.requests) filter (where u.status_class in (2, 3)), 0)::int as ok,
      coalesce(sum(u.requests) filter (where u.status_class in (4, 5)), 0)::int as errors,
      coalesce(sum(u.requests) filter (where u.status_class = 0), 0)::int as blocked,
      coalesce(sum(u.total_ms) filter (where u.status_class <> 0), 0)::float8 as total_ms
    from generate_series(date_trunc(${unit}, ${to}::timestamptz - make_interval(days => ${days}) + interval '1 ${sql.raw(unit)}'),
                         date_trunc(${unit}, ${to}::timestamptz), interval '1 ${sql.raw(unit)}') as g(t)
    left join api_key_usage u on date_trunc(${unit}, u.bucket) = g.t and ${where}
    group by g.t order by g.t`);
  return {
    unit,
    points: r.rows.map((p) => ({ t: new Date(p.t).toISOString(), ok: p.ok, errors: p.errors, blocked: p.blocked, avg_ms: p.ok + p.errors > 0 ? Math.round(p.total_ms / (p.ok + p.errors)) : 0 })),
  };
}

export function apiKeyAnalyticsRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    // One row per key of a mode: totals over the range, a daily sparkline and where it was last used from.
    app.get('/usage', { preHandler: requirePermission('api_keys:read'), schema: { querystring: z.strictObject({ livemode: z.stringbool(), days: Days }) } }, async (req) => {
      const user = authedUser(req);
      const { livemode, days } = req.query;
      const now = deps.clock();
      const since = new Date(now - days * 86_400_000).toISOString();
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const keys = await tx.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.merchantId, user.merchantId), eq(apiKeys.livemode, livemode)));
        const data = await Promise.all(
          keys.map(async (k) => {
            const s = await series(tx, sql`u.key_id = ${k.id}`, days, now);
            const [c] = (
              await tx.execute<{ clients: number; last_ip: string | null; last_seen: string | null; new_clients: number }>(sql`
                select count(*)::int as clients,
                  (array_agg(ip order by last_seen desc))[1] as last_ip, max(last_seen) as last_seen,
                  count(*) filter (where first_seen >= ${since}::timestamptz)::int as new_clients
                from api_key_clients where key_id = ${k.id}`)
            ).rows;
            const sum = (f: 'ok' | 'errors' | 'blocked') => s.points.reduce((a, p) => a + p[f], 0);
            const requests = sum('ok') + sum('errors');
            return {
              key_id: k.id,
              requests,
              errors: sum('errors'),
              blocked: sum('blocked'),
              error_rate: requests > 0 ? sum('errors') / requests : 0,
              clients: c?.clients ?? 0,
              new_clients: c?.new_clients ?? 0,
              last_ip: c?.last_ip ?? null,
              last_seen: c?.last_seen ? new Date(c.last_seen).toISOString() : null,
              spark: s.points.map((p) => p.ok + p.errors + p.blocked),
            };
          }),
        );
        return { days, data };
      });
    });

    app.get(
      '/:id/analytics',
      { preHandler: requirePermission('api_keys:read'), schema: { params: z.strictObject({ id: z.uuid() }), querystring: z.strictObject({ days: Days }) } },
      async (req) => {
        const user = authedUser(req);
        const { days } = req.query;
        const now = deps.clock();
        const since = new Date(now - days * 86_400_000).toISOString();
        return withTenant(deps.db, user.merchantId, async (tx) => {
          const [k] = await tx.select().from(apiKeys).where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.merchantId, user.merchantId)));
          if (!k) throw new AppError('not_found', 'API key not found');
          const s = await series(tx, sql`u.key_id = ${k.id}`, days, now);
          const routes = (
            await tx.execute<{ route: string; requests: number; errors: number; total_ms: number }>(sql`
              select route, sum(requests)::int as requests,
                coalesce(sum(requests) filter (where status_class in (4, 5)), 0)::int as errors, sum(total_ms)::float8 as total_ms
              from api_key_usage where key_id = ${k.id} and bucket >= ${since}::timestamptz and status_class <> 0
              group by route order by requests desc limit 12`)
          ).rows.map((r) => ({ route: r.route, requests: r.requests, errors: r.errors, avg_ms: r.requests > 0 ? Math.round(r.total_ms / r.requests) : 0 }));
          const statuses = Object.fromEntries(
            (
              await tx.execute<{ status_class: number; requests: number }>(sql`
                select status_class, sum(requests)::int as requests from api_key_usage
                where key_id = ${k.id} and bucket >= ${since}::timestamptz group by status_class`)
            ).rows.map((r) => [r.status_class === 0 ? 'blocked' : `${String(r.status_class)}xx`, r.requests]),
          );
          // The fingerprint: every client, newest activity first, flagged against the allowlists.
          const sec = await securityRow(tx, user.merchantId);
          const wl = ipSwitch(sec, now).on ? (sec?.ipEntries ?? []).map((e) => e.cidr) : null;
          const clients = (await tx.select().from(apiKeyClients).where(eq(apiKeyClients.keyId, k.id)).orderBy(desc(apiKeyClients.lastSeen)).limit(200)).map((c) => ({
            ip: c.ip,
            user_agent: c.userAgent,
            first_seen: c.firstSeen.toISOString(),
            last_seen: c.lastSeen.toISOString(),
            last_route: c.lastRoute,
            requests: c.requests,
            errors: c.errors,
            blocked: c.blocked,
            new: c.firstSeen.getTime() >= now - 86_400_000,
            in_key_allowlist: k.ipAllowlist ? ipAllowed(c.ip, k.ipAllowlist) : null,
            in_ip_whitelist: wl ? ipAllowed(c.ip, wl) : null,
          }));
          const total = (f: 'ok' | 'errors' | 'blocked') => s.points.reduce((a, p) => a + p[f], 0);
          const served = total('ok') + total('errors');
          const lat = s.points.filter((p) => p.ok + p.errors > 0);
          return {
            key: { id: k.id, name: k.name, kind: k.kind, livemode: k.livemode, prefix: k.prefix, scopes: k.scopes, ip_allowlist: k.ipAllowlist, created_at: k.createdAt, last_used_at: k.lastUsedAt, revoked_at: k.revokedAt, expires_at: k.expiresAt },
            days,
            unit: s.unit,
            series: s.points,
            totals: {
              requests: served,
              errors: total('errors'),
              blocked: total('blocked'),
              error_rate: served > 0 ? total('errors') / served : 0,
              avg_ms: lat.length > 0 ? Math.round(lat.reduce((a, p) => a + p.avg_ms * (p.ok + p.errors), 0) / served) : 0,
              clients: clients.length,
              unique_ips: new Set(clients.map((c) => c.ip)).size,
            },
            routes,
            statuses,
            clients,
            ip_whitelist_on: wl !== null,
          };
        });
      },
    );
  };
}
