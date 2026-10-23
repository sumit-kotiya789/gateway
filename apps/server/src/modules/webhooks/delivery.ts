// Webhook delivery (worker). At-least-once: due deliveries are claimed with a lease (next_attempt_at pushed ahead), sent
// outside any transaction, then recorded. A crash mid-send means a resend once the lease runs out; receivers dedupe on
// the event id. No ordering guarantee across events (D-070).
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { and, asc, eq, inArray, lt, lte, ne } from 'drizzle-orm';
import { withSystem } from '../../common/db.js';
import { outboxEvents, webhookDeliveries, webhookEndpoints } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { eventsView } from '../ledger/ledger.routes.js';
import { resolveTarget } from './ssrf.js';
import { secretAad } from './webhooks.routes.js';

/** Wait after failed attempt n (1-based) before attempt n+1: 12 attempts over ~2.4 days, then the delivery fails. */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200, 18_000, 36_000, 36_000, 36_000, 36_000, 36_000, 36_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
export const BATCH = 50;
const PARALLEL = 10;
const TIMEOUT_MS = 10_000;
// A claimed batch is sent in waves of PARALLEL, each at most TIMEOUT_MS: the lease must outlast the whole batch.
const LEASE_MS = 2 * (BATCH / PARALLEL) * TIMEOUT_MS;
const MAX_RESPONSE_BYTES = 64 * 1024;
const RETENTION_MS = 30 * 86_400_000;

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, one v1 per active secret (two during a rotation). */
export function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${createHmac('sha256', s).update(`${timestamp}.${body}`).digest('hex')}`)].join(',');
}

/** POST to the pinned address. No redirects, no keep-alive, hard deadline, response read capped. */
function post(url: URL, target: { address: string; family: 4 | 6 }, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        host: target.address,
        family: target.family,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        // TLS checks the certificate against the URL's hostname, not the pinned address.
        ...(isIP(host) ? {} : { servername: host }),
        headers: { ...headers, host: url.host, 'content-length': String(Buffer.byteLength(body)) },
        agent: false,
        timeout: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS), // `timeout` alone only bounds socket idle time
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
          else res.destroy();
        });
        res.on('close', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timed out'));
    });
    req.on('error', reject);
    req.end(body);
  });
}

type Claimed = {
  d: typeof webhookDeliveries.$inferSelect;
  w: typeof webhookEndpoints.$inferSelect;
  body: string;
};

async function attempt(deps: Deps, { d, w, body }: Claimed): Promise<void> {
  const now = deps.clock();
  let status: number | null = null;
  let error: string | null = null;
  try {
    const secrets = [await deps.envelope.open(w.secretEnc, secretAad(w.id))];
    if (w.previousSecretEnc && w.previousSecretExpiresAt && w.previousSecretExpiresAt.getTime() > now) {
      secrets.push(await deps.envelope.open(w.previousSecretEnc, secretAad(w.id)));
    }
    const url = new URL(w.url);
    const target = await resolveTarget(url.hostname, deps.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    const res = await post(url, target, body, {
      'content-type': 'application/json',
      'user-agent': 'Gateway-Webhooks/1',
      'gateway-event-id': d.eventId,
      'gateway-signature': signatureHeader(secrets, Math.floor(now / 1000), body),
    });
    status = res.status;
    if (status < 200 || status >= 300) {
      error = `HTTP ${String(status)}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}${res.body ? `: ${res.body.slice(0, 300)}` : ''}`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const n = d.attempts + 1;
  const next = error === null ? 'succeeded' : n >= MAX_ATTEMPTS ? 'failed' : 'pending';
  const delayS = next === 'pending' ? (RETRY_DELAYS_S[n - 1] ?? 0) : 0;
  await withSystem(deps.db, (tx) =>
    tx
      .update(webhookDeliveries)
      .set({ status: next, attempts: n, lastAttemptAt: new Date(now), lastStatusCode: status, lastError: error?.slice(0, 500) ?? null, nextAttemptAt: new Date(now + delayS * 1000) })
      // A manual retry or endpoint deletion in the meantime wins.
      .where(and(eq(webhookDeliveries.seq, d.seq), eq(webhookDeliveries.status, 'pending'), eq(webhookDeliveries.attempts, d.attempts))),
  );
  if (next === 'failed') deps.log.warn({ deliveryId: d.id, endpointId: w.id, eventId: d.eventId, error }, 'webhook delivery failed permanently');
}

/**
 * Claims and sends one batch of due deliveries. Safe on several workers at once (SKIP LOCKED + lease). Returns the batch
 * size. `endpointId` limits the batch to one endpoint (tests, which share one database across files).
 */
export async function deliverDueWebhooks(deps: Deps, endpointId?: string): Promise<number> {
  const now = deps.clock();
  const claimed = await withSystem(deps.db, async (tx): Promise<Claimed[]> => {
    const rows = await tx
      .select({ d: webhookDeliveries, w: webhookEndpoints, e: outboxEvents })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .innerJoin(outboxEvents, eq(outboxEvents.id, webhookDeliveries.eventId))
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          lte(webhookDeliveries.nextAttemptAt, new Date(now)),
          endpointId ? eq(webhookDeliveries.endpointId, endpointId) : undefined,
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(BATCH)
      .for('update', { of: webhookDeliveries, skipLocked: true });
    if (rows.length === 0) return [];
    await tx
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(now + LEASE_MS) })
      .where(inArray(webhookDeliveries.seq, rows.map((r) => r.d.seq)));
    // Same body on every attempt: the event row and token decimals are immutable.
    const views = await eventsView(tx, rows.map((r) => r.e));
    return rows.map((r, i) => ({ d: r.d, w: r.w, body: JSON.stringify(views[i]) }));
  });
  // ponytail: fixed waves, so one slow endpoint holds up its wave; per-endpoint queues if throughput matters.
  for (let i = 0; i < claimed.length; i += PARALLEL) {
    await Promise.all(claimed.slice(i, i + PARALLEL).map((c) => attempt(deps, c)));
  }
  return claimed.length;
}

/** Delivery log retention: finished deliveries whose last attempt is older than 30 days. */
export async function purgeWebhookDeliveries(deps: Deps): Promise<number> {
  const cutoff = new Date(deps.clock() - RETENTION_MS);
  const rows = await withSystem(deps.db, (tx) =>
    tx
      .delete(webhookDeliveries)
      .where(and(ne(webhookDeliveries.status, 'pending'), lt(webhookDeliveries.lastAttemptAt, cutoff)))
      .returning({ seq: webhookDeliveries.seq }),
  );
  return rows.length;
}
