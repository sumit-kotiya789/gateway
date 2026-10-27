import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gateway, GatewayError, constructEvent } from '../../../../packages/sdk-node/src/index.js';
import { signatureHeader } from '../../src/modules/webhooks/delivery.js';
import { buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool } from './helpers.js';

const t = buildTestApp();
const { app, clock } = t;
const owner = ownerPool();
let baseUrl = '';
beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
  await ensureLocalRegistry(owner);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('Node SDK against the real API', () => {
  it('invoices: create (idempotent), retrieve, list, cancel; balances and events; typed errors', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const gw = new Gateway({ apiKey: m.key, baseUrl });
    const inv = await gw.invoices.create({ amount: '7.5', token: 'evm-local:usdt', external_order_id: 'sdk-1' }, { idempotencyKey: 'sdk-key-1' });
    expect(inv).toMatchObject({ object: 'invoice', status: 'pending', amount: '7.5', livemode: false });
    expect((await gw.invoices.create({ amount: '7.5', token: 'evm-local:usdt', external_order_id: 'sdk-1' }, { idempotencyKey: 'sdk-key-1' })).id).toBe(inv.id);
    expect((await gw.invoices.retrieve(inv.id)).deposit_address).toBe(inv.deposit_address);
    expect((await gw.invoices.list({ external_order_id: 'sdk-1' })).data.map((i) => i.id)).toEqual([inv.id]);
    expect((await gw.invoices.cancel(inv.id)).status).toBe('cancelled');
    expect((await gw.events.list({ type: 'invoice.cancelled' })).data[0]?.data.invoice_id).toBe(inv.id);
    expect((await gw.balances()).livemode).toBe(false);
    const csv = await gw.exports.invoicesCsv();
    expect(csv.split('\r\n')[0]).toMatch(/^id,created_at,status,/);
    expect(csv).toContain(inv.id);
    await expect(gw.exports.paymentsCsv({ from: '2026-02-01', to: '2026-01-01' })).rejects.toMatchObject({ status: 400 });

    const err = await gw.invoices.create({ amount: '0', token: 'evm-local:usdt' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_amount' });
    expect((err as GatewayError).requestId).toBeTruthy();
    await expect(new Gateway({ apiKey: 'sk_test_wrong', baseUrl }).balances()).rejects.toMatchObject({ status: 401 });
  });

  it('verifies exactly what the gateway signs (including during secret rotation)', () => {
    const body = JSON.stringify({ id: 'evt_x', object: 'event', type: 'invoice.paid' });
    const ts = Math.floor(Date.now() / 1000);
    expect(constructEvent(body, signatureHeader(['whsec_new', 'whsec_old'], ts, body), 'whsec_old').id).toBe('evt_x');
  });
});
