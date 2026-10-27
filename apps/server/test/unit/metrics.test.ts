import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/common/config.js';
import { HttpMetrics, renderMetrics } from '../../src/modules/metrics/metrics.js';

describe('prometheus text format', () => {
  it('escapes label values and writes special numbers', () => {
    const text = renderMetrics([
      { name: 'gw_x', help: 'Example.', type: 'gauge', samples: [{ labels: { chain: 'a"b\\c\nd' }, value: Number.NaN }, { value: Number.POSITIVE_INFINITY }, { value: 2.5 }] },
    ]);
    expect(text).toBe('# HELP gw_x Example.\n# TYPE gw_x gauge\ngw_x{chain="a\\"b\\\\c\\nd"} NaN\ngw_x +Inf\ngw_x 2.5\n');
  });

  it('http counters group by method, route template and status class', () => {
    const h = new HttpMetrics();
    h.observe('GET', '/v1/invoices/:id', 200, 0.25);
    h.observe('GET', '/v1/invoices/:id', 204, 0.5);
    h.observe('GET', undefined, 404, 0.1);
    const text = renderMetrics(h.metrics());
    expect(text).toContain('gw_http_requests_total{method="GET",route="/v1/invoices/:id",status="2xx"} 2');
    expect(text).toContain('gw_http_request_seconds_total{method="GET",route="/v1/invoices/:id",status="2xx"} 0.75');
    expect(text).toContain('gw_http_requests_total{method="GET",route="unmatched",status="4xx"} 1');
  });
});

describe('METRICS_TOKEN', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'j'.repeat(32),
    ADMIN_JWT_SECRET: 'a'.repeat(32),
    API_KEY_PEPPER: 'p'.repeat(32),
    DATA_KEK: Buffer.alloc(32, 1).toString('base64'),
  };
  it('is optional, but at least 32 characters when set', () => {
    expect(loadConfig(base).METRICS_TOKEN).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_TOKEN: 'm'.repeat(32) }).METRICS_TOKEN).toBe('m'.repeat(32));
    expect(() => loadConfig({ ...base, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
  });
});
