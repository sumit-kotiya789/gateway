import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenanceJob } from '../../src/main-worker.js';
import { MAX_ATTEMPTS, RETRY_DELAYS_S, deliverDueWebhooks } from '../../src/modules/webhooks/delivery.js';
import { buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool, totpNow } from './helpers.js';

// Local receivers are loopback addresses: this app allows private networks; `strict` below does not.
const t = buildTestApp({ WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' });
const strict = buildTestApp({ DATA_KEK: t.deps.config.DATA_KEK }); // same key: it must decrypt t's endpoint secrets
const { app, clock, deps } = t;
const owner = ownerPool();

type Hit = { path: string; headers: IncomingHttpHeaders; body: string };
const hits: Hit[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  req.on('end', () => {
    hits.push({ path: req.url ?? '', headers: req.headers, body });
    if (req.url === '/fail') res.writeHead(500).end('boom');
    else if (req.url === '/redirect') res.writeHead(302, { location: 'http://127.0.0.1/' }).end();
    else res.writeHead(200).end('ok');
  });
});
let base = '';

beforeAll(async () => {
  await app.ready();
  await strict.app.ready();
  await ensureLocalRegistry(owner);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  server.close();
  await t.close();
  await strict.close();
  await owner.end();
});

async function merchant() {
  const m = await merchantWithKey(app, clock, owner);
  const code = () => {
    clock.advance(30_000);
    return { 'x-totp-code': totpNow(m.secret, clock()) };
  };
  const endpoint = async (path: string, livemode = false) => {
    const r = await m.agent.req('POST', '/v1/dashboard/webhooks/', { livemode, url: `${base}${path}` }, code());
    if (r.statusCode !== 201) throw new Error(r.body);
    return r.json<{ id: string; secret: string }>();
  };
  /** Creates and cancels a test invoice: exactly one event (invoice.cancelled). */
  const event = async () => {
    const inv = (await m.api('POST', '/v1/invoices', { amount: '7.5', token: 'evm-local:usdt' })).json<{ id: string }>();
    await m.api('POST', `/v1/invoices/${inv.id}/cancel`);
    const ev = (await m.api('GET', '/v1/events?limit=1')).json<{ data: { id: string; type: string }[] }>().data[0];
    if (!ev) throw new Error('no event');
    return ev;
  };
  return { ...m, code, endpoint, event };
}

const deliveries = (endpointId: string) =>
  owner.query<{ status: string; attempts: number; next_attempt_at: Date; last_status_code: number | null; last_error: string | null }>(
    'select status, attempts, next_attempt_at, last_status_code, last_error from webhook_deliveries where endpoint_id = $1 order by seq',
    [endpointId],
  );

function signatures(h: Hit) {
  const parts = String(h.headers['gateway-signature']).split(',');
  const ts = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
  return { ts, v1: parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3)) };
}
const hmac = (secret: string, ts: string, body: string) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

describe('webhook delivery', () => {
  it('delivers each event once, signed with the endpoint secret; body = the API event', async () => {
    const m = await merchant();
    const w = await m.endpoint('/ok');
    const ev = await m.event();
    expect(await deliverDueWebhooks(deps, w.id)).toBe(1);
    expect(await deliverDueWebhooks(deps, w.id)).toBe(0);

    const h = hits.filter((x) => x.headers['gateway-event-id'] === ev.id);
    expect(h).toHaveLength(1);
    const hit = h[0] as Hit;
    expect(hit.headers['content-type']).toBe('application/json');
    const { ts, v1 } = signatures(hit);
    expect(Number(ts)).toBe(Math.floor(clock() / 1000));
    expect(v1).toEqual([hmac(w.secret, ts, hit.body)]);
    expect(JSON.parse(hit.body)).toEqual((await m.api('GET', `/v1/events/${ev.id}`)).json());
    expect((await deliveries(w.id)).rows).toEqual([expect.objectContaining({ status: 'succeeded', attempts: 1, last_status_code: 200, last_error: null })]);

    const log = (await m.agent.req('GET', `/v1/dashboard/webhooks/${w.id}/deliveries`)).json<{ data: unknown[] }>();
    expect(log.data).toEqual([expect.objectContaining({ event_id: ev.id, event_type: 'invoice.cancelled', status: 'succeeded', attempts: 1, next_attempt_at: null })]);
  });

  it('non-2xx and redirects are retried with backoff, then fail; a manual retry resends with a fresh budget', async () => {
    const m = await merchant();
    const w = await m.endpoint('/fail');
    const r = await m.endpoint('/redirect');
    await m.event();
    await deliverDueWebhooks(deps, w.id);
    await deliverDueWebhooks(deps, r.id);
    expect((await deliveries(r.id)).rows[0]?.last_error).toBe('HTTP 302 (redirects are not followed)');
    const first = (await deliveries(w.id)).rows[0];
    expect(first).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 500, last_error: 'HTTP 500: boom' });
    expect(first?.next_attempt_at.getTime()).toBe(clock() + RETRY_DELAYS_S[0] * 1000);
    expect(await deliverDueWebhooks(deps, w.id)).toBe(0); // not due yet

    for (const delay of RETRY_DELAYS_S) {
      clock.advance(delay * 1000);
      expect(await deliverDueWebhooks(deps, w.id)).toBe(1);
    }
    expect((await deliveries(w.id)).rows[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    clock.advance(86_400_000);
    expect(await deliverDueWebhooks(deps, w.id)).toBe(0);

    const [d] = (await m.agent.req('GET', `/v1/dashboard/webhooks/${w.id}/deliveries`)).json<{ data: { id: string }[] }>().data;
    const retry = `/v1/dashboard/webhooks/${w.id}/deliveries/${d?.id ?? ''}/retry`;
    expect((await m.agent.req('POST', retry)).json()).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await m.agent.req('POST', retry)).statusCode).toBe(409);
    expect(await deliverDueWebhooks(deps, w.id)).toBe(1);
    expect((await deliveries(w.id)).rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await m.agent.req('POST', `/v1/dashboard/webhooks/${r.id}/deliveries/${d?.id ?? ''}/retry`)).statusCode).toBe(404); // other endpoint
  });

  it('fans out to every endpoint of the same merchant and mode only; deleting an endpoint drops its deliveries', async () => {
    const m = await merchant();
    const a = await m.endpoint('/ok');
    const b = await m.endpoint('/ok');
    const live = await m.endpoint('/ok', true);
    const other = await merchant();
    const theirs = await other.endpoint('/ok');
    await m.event();
    expect((await deliveries(a.id)).rows).toHaveLength(1);
    expect((await deliveries(b.id)).rows).toHaveLength(1);
    expect((await deliveries(live.id)).rows).toHaveLength(0);
    expect((await deliveries(theirs.id)).rows).toHaveLength(0);
    expect((await other.agent.req('GET', `/v1/dashboard/webhooks/${a.id}/deliveries`)).json<{ data: unknown[] }>().data).toEqual([]);

    expect((await m.agent.req('DELETE', `/v1/dashboard/webhooks/${b.id}`)).statusCode).toBe(204);
    expect((await deliveries(b.id)).rows).toHaveLength(0);
    await expect(t.pool.query(`insert into webhook_deliveries (endpoint_id, merchant_id, event_id) select endpoint_id, merchant_id, event_id from webhook_deliveries limit 1`)).rejects.toThrow(/permission/);
  });

  it('secret rotation: both secrets sign during the grace period, then only the new one', async () => {
    const m = await merchant();
    const w = await m.endpoint('/ok');
    const url = `/v1/dashboard/webhooks/${w.id}/rotate-secret`;
    expect((await m.agent.req('POST', url, { expire_previous_in_hours: 1 })).statusCode).toBe(403); // needs TOTP
    const rot = (await m.agent.req('POST', url, { expire_previous_in_hours: 1 }, m.code())).json<{ secret: string; previous_secret_expires_at: string }>();
    expect(rot.secret).toMatch(/^whsec_/);
    expect(rot.secret).not.toBe(w.secret);
    expect(Date.parse(rot.previous_secret_expires_at)).toBe(clock() + 3_600_000);

    const e1 = await m.event();
    await deliverDueWebhooks(deps, w.id);
    const h1 = hits.find((x) => x.headers['gateway-event-id'] === e1.id) as Hit;
    const s1 = signatures(h1);
    expect(s1.v1).toEqual([hmac(rot.secret, s1.ts, h1.body), hmac(w.secret, s1.ts, h1.body)]);

    clock.advance(3_600_001);
    const e2 = await m.event();
    await deliverDueWebhooks(deps, w.id);
    const h2 = hits.find((x) => x.headers['gateway-event-id'] === e2.id) as Hit;
    const s2 = signatures(h2);
    expect(s2.v1).toEqual([hmac(rot.secret, s2.ts, h2.body)]);

    const now = (await m.agent.req('POST', url, { expire_previous_in_hours: 0 }, m.code())).json<{ previous_secret_expires_at: string | null }>();
    expect(now.previous_secret_expires_at).toBeNull();
    const a = await owner.query(`select 1 from audit_logs where action = 'webhook_endpoint.secret_rotated' and target_id = $1`, [w.id]);
    expect(a.rowCount).toBe(2);
  });

  it('SSRF guard: private addresses are refused unless explicitly allowed; nothing is sent', async () => {
    const m = await merchant();
    const w = await m.endpoint('/ok');
    const ev = await m.event();
    strict.clock.advance(clock() - strict.clock()); // same "now" as the app that created the delivery
    await deliverDueWebhooks(strict.deps, w.id);
    expect(hits.some((x) => x.headers['gateway-event-id'] === ev.id)).toBe(false);
    expect((await deliveries(w.id)).rows[0]).toMatchObject({ status: 'pending', attempts: 1, last_status_code: null, last_error: '127.0.0.1 resolves to a non-public address' });
  });

  it('finished deliveries are purged after 30 days', async () => {
    const m = await merchant();
    const w = await m.endpoint('/ok');
    await m.event();
    await deliverDueWebhooks(deps, w.id);
    clock.advance(31 * 86_400_000);
    const r = (await runMaintenanceJob(deps, 'purge-webhook-deliveries')) as { purged: number };
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect((await deliveries(w.id)).rows).toHaveLength(0);
  });
});
