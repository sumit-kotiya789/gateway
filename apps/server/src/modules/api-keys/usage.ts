// API key analytics (D-110): every request made with an API key lands in an hourly bucket (endpoint, status class,
// latency) and in the key's client list (IP + user agent: its digital fingerprint). Recorded after the response is
// sent, so it never slows a request down, and a failure here is logged, never surfaced.
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withSystem } from '../../common/db.js';
import { apiKeyUsage } from '../../db/schema.js';
import type { Deps } from '../../deps.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The key a request named, set once the key is known even if the request is then refused (IP not allowed). */
    apiKeyAttempt: { id: string; merchantId: string } | null;
  }
}

/** Status class for analytics: 2-5 (hundreds); 0 = blocked before reaching the endpoint (IP not allowed). */
export const statusClass = (status: number, blocked: boolean) => (blocked ? 0 : Math.min(5, Math.max(2, Math.floor(status / 100))));

export async function recordApiUsage(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.apiKey ?? req.apiKeyAttempt;
  if (!key) return;
  const blocked = !req.apiKey;
  const status = reply.statusCode;
  const cls = statusClass(status, blocked);
  const route = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0] ?? ''}`.slice(0, 200);
  const ua = (req.headers['user-agent'] ?? '').slice(0, 300);
  const now = new Date(deps.clock());
  const bucket = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const ms = Math.round(reply.elapsedTime);
  const error = !blocked && status >= 400 ? 1 : 0;
  try {
    await withSystem(deps.db, async (tx) => {
      await tx
        .insert(apiKeyUsage)
        .values({ keyId: key.id, merchantId: key.merchantId, bucket, route, statusClass: cls, requests: 1, totalMs: ms })
        .onConflictDoUpdate({
          target: [apiKeyUsage.keyId, apiKeyUsage.bucket, apiKeyUsage.route, apiKeyUsage.statusClass],
          set: { requests: sql`${apiKeyUsage.requests} + 1`, totalMs: sql`${apiKeyUsage.totalMs} + ${ms}` },
        });
      // Raw SQL: the conflict target is the md5(user_agent) expression index.
      await tx.execute(sql`
        insert into api_key_clients (key_id, merchant_id, ip, user_agent, first_seen, last_seen, last_route, requests, errors, blocked)
        values (${key.id}, ${key.merchantId}, ${req.ip}, ${ua}, ${now.toISOString()}, ${now.toISOString()}, ${route}, 1, ${error}, ${blocked ? 1 : 0})
        on conflict (key_id, ip, md5(user_agent)) do update set
          last_seen = excluded.last_seen, last_route = excluded.last_route,
          requests = api_key_clients.requests + 1,
          errors = api_key_clients.errors + excluded.errors,
          blocked = api_key_clients.blocked + excluded.blocked`);
    });
  } catch (err) {
    req.log.warn({ err }, 'api key usage not recorded');
  }
}

