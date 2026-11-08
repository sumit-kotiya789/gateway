import { describe, expect, it } from 'vitest';
import { Gateway, GatewayError } from '../src/index.js';

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push({ url: url.toString(), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('Gateway client', () => {
  it('refuses publishable or malformed keys', () => {
    expect(() => new Gateway({ apiKey: 'pk_test_x', baseUrl: 'http://gw' })).toThrow(/secret key/);
  });

  it('creates with an idempotency key and retries 5xx and network errors with the same key', async () => {
    const f = fakeFetch([json(503, {}), new TypeError('fetch failed'), json(201, { id: 'inv_1' })]);
    const gw = new Gateway({ apiKey: 'sk_test_abc', baseUrl: 'http://gw/', fetch: f.fn });
    expect(await gw.invoices.create({ amount: '5', token: 'nexis:usdt' })).toEqual({ id: 'inv_1' });
    expect(f.calls).toHaveLength(3);
    const keys = new Set(f.calls.map((c) => c.headers['idempotency-key']));
    expect(keys.size).toBe(1);
    expect(f.calls[0]).toMatchObject({ url: 'http://gw/v1/invoices', method: 'POST', body: JSON.stringify({ amount: '5', token: 'nexis:usdt' }) });
    expect(f.calls[0]?.headers.authorization).toBe('Bearer sk_test_abc');
  });

  it('honours retry-after on 429, gives up after maxRetries, and maps API errors', async () => {
    const f = fakeFetch([json(429, {}, { 'retry-after': '0' }), json(400, { error: { code: 'invalid_amount', message: 'bad amount', request_id: 'req_1', details: { x: 1 } } })]);
    const gw = new Gateway({ apiKey: 'sk_test_abc', baseUrl: 'http://gw', fetch: f.fn, maxRetries: 1 });
    const err = await gw.invoices.create({ amount: 'x', token: 't' }, { idempotencyKey: 'k1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_amount', message: 'bad amount', requestId: 'req_1', details: { x: 1 } });
    expect(f.calls.map((c) => c.headers['idempotency-key'])).toEqual(['k1', 'k1']);

    const g2 = new Gateway({ apiKey: 'sk_test_abc', baseUrl: 'http://gw', fetch: fakeFetch([json(500, {})]).fn, maxRetries: 0 });
    await expect(g2.balances()).rejects.toMatchObject({ status: 500, code: 'error' });
  });

  it('list passes query parameters and skips undefined', async () => {
    const f = fakeFetch([json(200, { data: [], has_more: false, next_cursor: null })]);
    await new Gateway({ apiKey: 'sk_live_abc', baseUrl: 'http://gw', fetch: f.fn }).invoices.list({ limit: 5, status: 'paid' });
    expect(f.calls[0]?.url).toBe('http://gw/v1/invoices?limit=5&status=paid');
  });

  it('deposit accounts and payouts (D-100, D-101) call their endpoints; a payout keeps the caller idempotency key', async () => {
    const f = fakeFetch([
      json(201, { id: 'da_1' }),
      json(200, { id: 'da_1' }),
      json(200, { data: [] }),
      json(201, { id: 'po_1' }),
      json(200, { id: 'po_1' }),
      json(200, { data: [] }),
    ]);
    const gw = new Gateway({ apiKey: 'sk_test_abc', baseUrl: 'http://gw', fetch: f.fn });
    await gw.depositAccounts.create({ customer_ref: 'user-1', token: 'bsc-testnet:usdt' });
    await gw.depositAccounts.retrieve('da_1');
    await gw.depositAccounts.list({ customer_ref: 'user-1' });
    await gw.payouts.create({ customer_ref: 'user-1', to_address: '0xabc', token: 'bsc-testnet:usdt', amount: '5' }, { idempotencyKey: 'wd-42' });
    await gw.payouts.retrieve('po_1');
    await gw.payouts.list({ customer_ref: 'user-1', limit: 10 });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://gw/v1/deposit-accounts',
      'GET http://gw/v1/deposit-accounts/da_1',
      'GET http://gw/v1/deposit-accounts?customer_ref=user-1',
      'POST http://gw/v1/payouts',
      'GET http://gw/v1/payouts/po_1',
      'GET http://gw/v1/payouts?customer_ref=user-1&limit=10',
    ]);
    expect(f.calls[3]?.headers['idempotency-key']).toBe('wd-42');
    expect(JSON.parse(f.calls[0]?.body ?? '{}')).toEqual({ customer_ref: 'user-1', token: 'bsc-testnet:usdt' });
  });
});
