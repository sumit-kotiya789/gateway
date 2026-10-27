// Prometheus metrics (M9, D-085). Health gauges are read from the database at scrape time, so one api process reports
// on the worker and watchers too (their state lives in the DB). HTTP counters are per api process. Text format is
// written by hand: a handful of series does not justify a client library.
import { timingSafeEqual } from 'node:crypto';
import { AppError, fromMinorUnits } from '@gw/core';
import { and, count, desc, eq, gt, inArray, lt, lte, min, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { withSystem } from '../../common/db.js';
import { chainCursors, chains, emailOutbox, invoices, ledgerAccounts, ledgerEntries, reconciliationRuns, sweeps, tokens, webhookDeliveries } from '../../db/schema.js';
import type { Deps } from '../../deps.js';

/** A pending invoice this long past its deadline means the expiry job is not running. */
const OVERDUE_GRACE_MS = 120_000;
const DAY_MS = 86_400_000;
/** Scrapes within this window reuse the last DB read (several Prometheus replicas, retries). */
const CACHE_MS = 5_000;

type Labels = Record<string, string>;
interface Sample {
  labels?: Labels;
  value: number;
}
interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Sample[];
}

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labelText = (l?: Labels) =>
  l && Object.keys(l).length > 0
    ? `{${Object.entries(l)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(',')}}`
    : '';
const num = (v: number) => (Number.isFinite(v) ? String(v) : v > 0 ? '+Inf' : v < 0 ? '-Inf' : 'NaN');

export function renderMetrics(metrics: Metric[]): string {
  let out = '';
  for (const m of metrics) {
    out += `# HELP ${m.name} ${m.help}\n# TYPE ${m.name} ${m.type}\n`;
    for (const s of m.samples) out += `${m.name}${labelText(s.labels)} ${num(s.value)}\n`;
  }
  return out;
}

/** Request counts and total seconds per route template (bounded cardinality: never the raw URL). */
export class HttpMetrics {
  private readonly requests = new Map<string, { labels: Labels; count: number; seconds: number }>();

  observe(method: string, route: string | undefined, status: number, seconds: number): void {
    const labels = { method, route: route ?? 'unmatched', status: `${String(Math.floor(status / 100))}xx` };
    const key = `${labels.method} ${labels.route} ${labels.status}`;
    const cur = this.requests.get(key) ?? { labels, count: 0, seconds: 0 };
    cur.count++;
    cur.seconds += seconds;
    this.requests.set(key, cur);
  }

  metrics(): Metric[] {
    const rows = [...this.requests.values()];
    return [
      { name: 'gw_http_requests_total', help: 'HTTP requests handled by this api process.', type: 'counter', samples: rows.map((r) => ({ labels: r.labels, value: r.count })) },
      { name: 'gw_http_request_seconds_total', help: 'Total time spent handling HTTP requests.', type: 'counter', samples: rows.map((r) => ({ labels: r.labels, value: r.seconds })) },
    ];
  }
}

const seconds = (now: number, d: Date | null | undefined) => (d ? Math.max(0, (now - d.getTime()) / 1000) : NaN);

/** Health gauges from the database. Alert rules: infra/prometheus/alerts.yml. */
export async function collectHealth(deps: Deps): Promise<Metric[]> {
  const now = deps.clock();
  return withSystem(deps.db, async (tx) => {
    const cursors = await tx
      .select({ chain: chains.id, block: chainCursors.blockNumber, blockTime: chainCursors.blockTime, updatedAt: chainCursors.updatedAt })
      .from(chains)
      .leftJoin(chainCursors, eq(chainCursors.chainId, chains.id))
      .where(eq(chains.enabled, true))
      .orderBy(chains.id);
    const [recon] = await tx.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.startedAt)).limit(1);
    const [hooksDue] = await tx
      .select({ n: count(), oldest: min(webhookDeliveries.nextAttemptAt) })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date(now))));
    const [hooksFailed] = await tx
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, 'failed'), gt(webhookDeliveries.lastAttemptAt, new Date(now - DAY_MS))));
    const [mailDue] = await tx
      .select({ n: count(), oldest: min(emailOutbox.nextAttemptAt) })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.nextAttemptAt, new Date(now))));
    const [mailFailed] = await tx
      .select({ n: count() })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, 'failed'), gt(emailOutbox.createdAt, new Date(now - DAY_MS))));
    const [overdue] = await tx
      .select({ n: count() })
      .from(invoices)
      .where(and(eq(invoices.status, 'pending'), lt(invoices.expiresAt, new Date(now - OVERDUE_GRACE_MS))));

    const [sweepsOpen] = await tx
      .select({ n: count(), oldest: min(sweeps.createdAt) })
      .from(sweeps)
      .where(inArray(sweeps.status, ['pending', 'gas_sent', 'sweep_sent']));
    const [sweepsFailed] = await tx
      .select({ n: count() })
      .from(sweeps)
      .where(and(eq(sweeps.status, 'failed'), gt(sweeps.createdAt, new Date(now - DAY_MS))));

    // Platform custody per mode and token, from the ledger (hot wallet cap alert; deposits not swept yet).
    const custody = await tx
      .select({ livemode: ledgerAccounts.livemode, token: ledgerAccounts.tokenId, kind: ledgerAccounts.kind, total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text`, decimals: tokens.decimals })
      .from(ledgerAccounts)
      .innerJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .innerJoin(tokens, eq(tokens.id, ledgerAccounts.tokenId))
      .where(inArray(ledgerAccounts.kind, ['custody_deposits', 'custody_hot', 'custody_cold']))
      .groupBy(ledgerAccounts.livemode, ledgerAccounts.tokenId, ledgerAccounts.kind, tokens.decimals);

    const issues = Array.isArray(recon?.issues) ? (recon.issues as { check?: unknown; count?: unknown }[]) : [];
    const perChain = (f: (c: (typeof cursors)[number]) => number) => cursors.map((c) => ({ labels: { chain: c.chain }, value: f(c) }));
    return [
      { name: 'gw_scanner_cursor_age_seconds', help: 'Seconds since the chain scanner last advanced its cursor (NaN: never ran).', type: 'gauge', samples: perChain((c) => seconds(now, c.updatedAt)) },
      { name: 'gw_scanner_block_age_seconds', help: 'Age of the newest scanned block (how far behind the chain the scanner is).', type: 'gauge', samples: perChain((c) => seconds(now, c.blockTime)) },
      { name: 'gw_scanner_cursor_block', help: 'Newest scanned block number.', type: 'gauge', samples: perChain((c) => (c.block === null ? NaN : Number(c.block))) },
      { name: 'gw_reconciliation_last_run_age_seconds', help: 'Seconds since the last reconciliation run started (NaN: never ran).', type: 'gauge', samples: [{ value: seconds(now, recon?.startedAt) }] },
      { name: 'gw_reconciliation_last_ok', help: '1 when the last reconciliation run found no issue.', type: 'gauge', samples: [{ value: recon ? Number(recon.ok) : NaN }] },
      {
        name: 'gw_reconciliation_issues',
        help: 'Rows flagged by each failing check of the last reconciliation run.',
        type: 'gauge',
        samples: issues.map((i) => ({ labels: { check: typeof i.check === 'string' ? i.check : 'unknown' }, value: typeof i.count === 'number' ? i.count : NaN })),
      },
      { name: 'gw_webhook_deliveries_due', help: 'Webhook deliveries due now and not yet sent.', type: 'gauge', samples: [{ value: hooksDue?.n ?? 0 }] },
      { name: 'gw_webhook_oldest_due_seconds', help: 'How long the oldest due webhook delivery has waited (0: none).', type: 'gauge', samples: [{ value: hooksDue?.oldest ? seconds(now, hooksDue.oldest) : 0 }] },
      { name: 'gw_webhook_deliveries_failed_24h', help: 'Webhook deliveries that gave up in the last 24 h.', type: 'gauge', samples: [{ value: hooksFailed?.n ?? 0 }] },
      { name: 'gw_emails_due', help: 'Emails due now and not yet sent.', type: 'gauge', samples: [{ value: mailDue?.n ?? 0 }] },
      { name: 'gw_email_oldest_due_seconds', help: 'How long the oldest due email has waited (0: none).', type: 'gauge', samples: [{ value: mailDue?.oldest ? seconds(now, mailDue.oldest) : 0 }] },
      { name: 'gw_emails_failed_24h', help: 'Emails given up on, created in the last 24 h.', type: 'gauge', samples: [{ value: mailFailed?.n ?? 0 }] },
      {
        name: 'gw_custody_balance',
        help: 'Platform custody per mode, token and place (deposits not swept yet, hot wallet, cold storage), in token units.',
        type: 'gauge',
        samples: custody.map((c) => ({
          labels: { livemode: String(c.livemode), token: c.token, account: c.kind.replace('custody_', '') },
          value: Number(fromMinorUnits(BigInt(c.total) > 0n ? BigInt(c.total) : 0n, c.decimals)),
        })),
      },
      { name: 'gw_sweeps_open', help: 'Custodial sweeps not finished yet.', type: 'gauge', samples: [{ value: sweepsOpen?.n ?? 0 }] },
      { name: 'gw_sweep_oldest_open_seconds', help: 'Age of the oldest unfinished sweep (0: none).', type: 'gauge', samples: [{ value: sweepsOpen?.oldest ? seconds(now, sweepsOpen.oldest) : 0 }] },
      { name: 'gw_sweeps_failed_24h', help: 'Sweeps that failed (reverted or refused as inconsistent) in the last 24 h.', type: 'gauge', samples: [{ value: sweepsFailed?.n ?? 0 }] },
      { name: 'gw_invoices_overdue_pending', help: 'Pending invoices more than 2 minutes past their deadline (expiry job not running).', type: 'gauge', samples: [{ value: overdue?.n ?? 0 }] },
    ] satisfies Metric[];
  });
}

/**
 * GET /metrics with `Authorization: Bearer <METRICS_TOKEN>`. Without METRICS_TOKEN the route does not exist (404), so
 * nothing is exposed by default. Keep it off the public edge anyway.
 */
export function metricsRoutes(deps: Deps, http: HttpMetrics): FastifyPluginAsync {
  let cache: { at: number; health: Metric[] } | null = null;
  return async (app) => {
    const token = deps.config.METRICS_TOKEN;
    if (!token) return;
    const expected = Buffer.from(`Bearer ${token}`);
    app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
      const got = Buffer.from(req.headers.authorization ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new AppError('unauthorized', 'metrics token required');
      if (!cache || deps.clock() - cache.at >= CACHE_MS) cache = { at: deps.clock(), health: await collectHealth(deps) };
      return reply
        .type('text/plain; version=0.0.4; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderMetrics([...cache.health, ...http.metrics()]));
    });
  };
}
