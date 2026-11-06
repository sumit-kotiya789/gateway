// Chaos (M11): the api keeps serving when a dependency fails and recovers without a restart.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool } from './helpers.js';

// Own application_name, so killing "our" connections never touches test files running in parallel.
const dbUrl = new URL(inject('pgAppUrl'));
dbUrl.searchParams.set('application_name', 'chaos-test');
const t = buildTestApp({ DATABASE_URL: dbUrl.toString() });
// Same client options as main-api: no offline queue, so commands fail at once while Redis is unreachable.
const noRedis = buildTestApp({ REDIS_URL: 'redis://127.0.0.1:1' }, { enableOfflineQueue: false });
noRedis.redis.on('error', () => {});
const owner = ownerPool();
beforeAll(async () => {
  await Promise.all([t.app.ready(), noRedis.app.ready()]);
  await ensureLocalRegistry(owner);
});
afterAll(async () => {
  await Promise.all([t.close(), noRedis.close()]);
  await owner.end();
});

describe('chaos', () => {
  it('Redis down: invoices are still created (rate limits fail open, D-031); readiness reports it', async () => {
    const m = await merchantWithKey(noRedis.app, noRedis.clock, owner);
    expect((await m.api('POST', '/v1/invoices', { amount: '1', token: 'evm-local:usdt' })).statusCode).toBe(201);
    const ready = await noRedis.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ checks: { db: true, redis: false } });
  });

  it('Postgres drops every connection (restart, failover): the process survives and the next request reconnects', async () => {
    const m = await merchantWithKey(t.app, t.clock, owner);
    expect((await m.api('GET', '/v1/invoices')).statusCode).toBe(200); // the pool now holds idle connections
    const killed = await owner.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'chaos-test'");
    expect(killed.rowCount).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200)); // the pool notices the dropped sockets (unhandled, this crashed the process)
    expect((await m.api('GET', '/v1/invoices')).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });
});
