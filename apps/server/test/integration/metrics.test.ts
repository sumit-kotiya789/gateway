import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool } from './helpers.js';

const TOKEN = 'metrics-token-0123456789abcdef0123456789';
const t = buildTestApp({ METRICS_TOKEN: TOKEN });
const { app, clock } = t;
const off = buildTestApp();
const owner = ownerPool();
beforeAll(async () => {
  await Promise.all([app.ready(), off.app.ready()]);
  await ensureLocalRegistry(owner);
  await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
      default_confirmations, reorg_depth, finality, testnet, enabled)
    values ('evm-metrics', 'evm', 'Metrics "test" chain', 31338, '{}', 'ETH', 18, 1000, 2, 16, 'tag', true, true) on conflict do nothing`);
});
afterAll(async () => {
  await owner.query("update chains set enabled = false where id = 'evm-metrics'");
  await owner.query("delete from reconciliation_runs where started_at > '2900-01-01'");
  await Promise.all([t.close(), off.close()]);
  await owner.end();
});

const scrape = () => app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
/** Value of one series from the text format, e.g. value(body, 'gw_emails_due'). */
function value(body: string, series: string): number | undefined {
  const line = body.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('metrics', () => {
  it('no METRICS_TOKEN: no route; wrong token: 401', async () => {
    expect((await off.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}x` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: TOKEN } })).statusCode).toBe(401);
  });

  it('prometheus text: health gauges per chain, escaped labels, HTTP counters by route template', async () => {
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/v1/invoices/not-a-real-id' });
    await app.inject({ method: 'GET', url: '/nope/123' });
    const r = await scrape();
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('# TYPE gw_scanner_cursor_age_seconds gauge');
    // An enabled chain without a cursor reads NaN (alert: never ran).
    expect(r.body).toContain('gw_scanner_cursor_age_seconds{chain="evm-metrics"} NaN');
    expect(value(r.body, 'gw_http_requests_total{method="GET",route="/healthz",status="2xx"}')).toBeGreaterThanOrEqual(1);
    expect(value(r.body, 'gw_http_requests_total{method="GET",route="/v1/invoices/:id",status="4xx"}')).toBeGreaterThanOrEqual(1);
    // Unknown URLs never become label values.
    expect(r.body).not.toContain('/nope/123');
    expect(r.body).toContain('route="unmatched"');
    for (const name of ['gw_webhook_deliveries_due', 'gw_webhook_oldest_due_seconds', 'gw_emails_due', 'gw_invoices_overdue_pending', 'gw_emails_failed_24h']) {
      expect(value(r.body, name)).toBeGreaterThanOrEqual(0);
    }
  });

  it('scanner age, overdue invoices and reconciliation follow the database', async () => {
    await owner.query(
      "insert into chain_cursors (chain_id, block_number, block_hash, block_time, updated_at) values ('evm-metrics', 77, '0x01', $1, $1) on conflict (chain_id) do update set block_number = 77, block_time = $1, updated_at = $1",
      [new Date(clock() - 300_000)],
    );
    await owner.query(
      `insert into reconciliation_runs (id, started_at, finished_at, ok, issues) values (gen_random_uuid(), '2999-01-01', '2999-01-01', false, $1)`,
      [JSON.stringify([{ check: 'unsettled', count: 3, sample: [] }, { check: 'received_balance', count: 1, sample: [] }])],
    );
    const m = await merchantWithKey(app, clock, owner);
    await m.api('POST', '/v1/invoices', { amount: '1', token: 'evm-local:usdt', expires_in: 300 });
    clock.advance(300_000 + 121_000 + 5_000); // past the deadline + grace, and past the scrape cache
    const body = (await scrape()).body;
    expect(value(body, 'gw_scanner_cursor_block{chain="evm-metrics"}')).toBe(77);
    expect(value(body, 'gw_scanner_cursor_age_seconds{chain="evm-metrics"}')).toBeGreaterThanOrEqual(300 + 426);
    expect(value(body, 'gw_invoices_overdue_pending')).toBeGreaterThanOrEqual(1);
    expect(value(body, 'gw_reconciliation_last_ok')).toBe(0);
    expect(value(body, 'gw_reconciliation_issues{check="unsettled"}')).toBe(3);
    expect(value(body, 'gw_reconciliation_issues{check="received_balance"}')).toBe(1);
  });
});
