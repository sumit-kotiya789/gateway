// Marketplace sellers (M9, D-095): API, dashboard, invoice tagging, DB guards and seller-scoped webhook fan-out.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool, totpNow } from './helpers.js';

const t = buildTestApp();
const { app, clock } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

type Seller = { id: string; object: string; name: string; reference: string | null; active: boolean; livemode: boolean; totals?: unknown[] };
type Inv = { id: string; sub_merchant_id: string | null };
const TOKEN = 'evm-local:usdt';

describe('sub-merchants', () => {
  it('API: create (idempotent), unique reference, list, get with totals, update, deactivate', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const body = { name: 'Alice Ceramics', reference: 'seller-1', metadata: { tier: 'gold' } };
    const r = await m.api('POST', '/v1/sub-merchants', body, { 'idempotency-key': 'seller-1' });
    expect(r.statusCode).toBe(201);
    const s = r.json<Seller>();
    expect(s).toMatchObject({ object: 'sub_merchant', name: 'Alice Ceramics', reference: 'seller-1', active: true, livemode: false });
    expect((await m.api('POST', '/v1/sub-merchants', body, { 'idempotency-key': 'seller-1' })).json<Seller>().id).toBe(s.id);
    expect((await m.api('POST', '/v1/sub-merchants', { ...body, name: 'Other' })).statusCode).toBe(409); // reference taken
    const bob = (await m.api('POST', '/v1/sub-merchants', { name: 'Bob' })).json<Seller>();

    expect((await m.api('GET', '/v1/sub-merchants')).json<{ data: Seller[] }>().data.map((x) => x.id)).toEqual([bob.id, s.id]);
    expect((await m.api('GET', '/v1/sub-merchants?reference=seller-1')).json<{ data: Seller[] }>().data.map((x) => x.id)).toEqual([s.id]);
    expect((await m.api('GET', `/v1/sub-merchants/${s.id}`)).json<Seller>()).toMatchObject({ id: s.id, totals: [] });

    expect((await m.api('PATCH', `/v1/sub-merchants/${s.id}`, { name: 'Alice C.', active: false })).json<Seller>()).toMatchObject({ name: 'Alice C.', active: false, reference: 'seller-1' });
    expect((await m.api('POST', '/v1/invoices', { amount: '5', token: TOKEN, sub_merchant: s.id })).statusCode).toBe(409); // deactivated
    await m.api('PATCH', `/v1/sub-merchants/${s.id}`, { active: true });

    // Another merchant cannot see or use this seller.
    const other = await merchantWithKey(app, clock, owner);
    expect((await other.api('GET', `/v1/sub-merchants/${s.id}`)).statusCode).toBe(404);
    expect((await other.api('PATCH', `/v1/sub-merchants/${s.id}`, { active: false })).statusCode).toBe(404);
    expect((await other.api('POST', '/v1/invoices', { amount: '5', token: TOKEN, sub_merchant: s.id })).statusCode).toBe(400);
    // Read-only keys cannot write.
    const ro = await m.mintKey(['read']);
    expect((await m.api('POST', '/v1/sub-merchants', { name: 'X' }, {}, ro)).statusCode).toBe(403);
  });

  it('invoices name their seller, list by seller; the DB keeps the seller in the same merchant and mode, and immutable', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const s1 = (await m.api('POST', '/v1/sub-merchants', { name: 'One' })).json<Seller>();
    const inv = (await m.api('POST', '/v1/invoices', { amount: '5', token: TOKEN, sub_merchant: s1.id })).json<Inv>();
    expect(inv.sub_merchant_id).toBe(s1.id);
    const own = (await m.api('POST', '/v1/invoices', { amount: '6', token: TOKEN })).json<Inv>();
    expect(own.sub_merchant_id).toBeNull();
    expect((await m.api('GET', `/v1/invoices?sub_merchant=${s1.id}`)).json<{ data: Inv[] }>().data.map((x) => x.id)).toEqual([inv.id]);

    const other = await merchantWithKey(app, clock, owner);
    const foreign = (await other.api('POST', '/v1/sub-merchants', { name: 'Foreign' })).json<Seller>();
    // Even the table owner cannot point an invoice at another merchant's seller, or change an invoice's seller.
    await expect(owner.query('update invoices set sub_merchant_id = $1 where id = $2', [foreign.id, own.id])).rejects.toThrow();
    await expect(owner.query('update invoices set sub_merchant_id = null where id = $1', [inv.id])).rejects.toThrow(/immutable/);
    await expect(owner.query('update sub_merchants set merchant_id = $1 where id = $2', [other.merchantId, s1.id])).rejects.toThrow(/immutable/);
  });

  it('events carry the seller; a seller-scoped endpoint gets only that seller events', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const s1 = (await m.api('POST', '/v1/sub-merchants', { name: 'One' })).json<Seller>();
    const s2 = (await m.api('POST', '/v1/sub-merchants', { name: 'Two' })).json<Seller>();
    const endpoint = async (sub?: string) => {
      clock.advance(30_000);
      const r = await m.agent.req(
        'POST',
        '/v1/dashboard/webhooks/',
        { livemode: false, url: `https://example.com/${sub ?? 'all'}`, ...(sub ? { sub_merchant_id: sub } : {}) },
        { 'x-totp-code': totpNow(m.secret, clock()) },
      );
      expect(r.statusCode).toBe(201);
      return r.json<{ id: string; sub_merchant_id: string | null }>();
    };
    const all = await endpoint();
    const only1 = await endpoint(s1.id);
    expect(only1.sub_merchant_id).toBe(s1.id);
    // A seller of another merchant (or mode) is refused.
    const other = await merchantWithKey(app, clock, owner);
    const foreign = (await other.api('POST', '/v1/sub-merchants', { name: 'Foreign' })).json<Seller>();
    clock.advance(30_000);
    expect(
      (await m.agent.req('POST', '/v1/dashboard/webhooks/', { livemode: false, url: 'https://example.com/x', sub_merchant_id: foreign.id }, { 'x-totp-code': totpNow(m.secret, clock()) })).statusCode,
    ).toBe(404);

    const cancelled = async (sub?: string) => {
      const inv = (await m.api('POST', '/v1/invoices', { amount: '5', token: TOKEN, ...(sub ? { sub_merchant: sub } : {}) })).json<Inv>();
      await m.api('POST', `/v1/invoices/${inv.id}/cancel`);
      const ev = (await m.api('GET', '/v1/events?limit=1')).json<{ data: { id: string; data: { sub_merchant_id: string | null } }[] }>().data[0];
      if (!ev) throw new Error('no event');
      const d = await owner.query<{ endpoint_id: string }>('select endpoint_id from webhook_deliveries where event_id = $1 order by endpoint_id', [ev.id]);
      return { seller: ev.data.sub_merchant_id, endpoints: d.rows.map((x) => x.endpoint_id).sort() };
    };
    expect(await cancelled(s1.id)).toEqual({ seller: s1.id, endpoints: [all.id, only1.id].sort() });
    expect(await cancelled(s2.id)).toEqual({ seller: s2.id, endpoints: [all.id] });
    expect(await cancelled()).toEqual({ seller: null, endpoints: [all.id] });
  });

  it('dashboard: list, create and update per mode, audited', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const r = await m.agent.req('POST', '/v1/dashboard/sub-merchants/', { livemode: false, name: 'Dash seller', reference: 'd-1' });
    expect(r.statusCode).toBe(201);
    const s = r.json<Seller>();
    expect((await m.agent.req('GET', '/v1/dashboard/sub-merchants/?livemode=false')).json<{ data: Seller[] }>().data.map((x) => x.id)).toEqual([s.id]);
    expect((await m.agent.req('GET', '/v1/dashboard/sub-merchants/?livemode=true')).json<{ data: Seller[] }>().data).toEqual([]);
    expect((await m.agent.req('GET', `/v1/dashboard/sub-merchants/${s.id}?livemode=false`)).json<Seller>()).toMatchObject({ id: s.id, totals: [] });
    expect((await m.agent.req('PATCH', `/v1/dashboard/sub-merchants/${s.id}`, { livemode: false, active: false })).json<Seller>()).toMatchObject({ active: false });
    expect((await m.agent.req('PATCH', `/v1/dashboard/sub-merchants/${s.id}`, { livemode: true, active: true })).statusCode).toBe(404); // other mode
    const a = await owner.query<{ action: string }>(`select action from audit_logs where target_id = $1 order by seq`, [s.id]);
    expect(a.rows.map((x) => x.action)).toEqual(['sub_merchant.created', 'sub_merchant.updated']);
  });
});
