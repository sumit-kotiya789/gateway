import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../src/api';

type Call = { url: string; method: string; headers: Record<string, string> };

/** Fake server: `/auth/refresh` succeeds after a tick; other paths answer from `handler`. */
function fakeFetch(handler: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('document', { cookie: 'other=1; gw_csrf=tok123' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const c = { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string> };
      calls.push(c);
      if (url.endsWith('/auth/refresh')) {
        await new Promise((r) => setTimeout(r, 5));
        return new Response(null, { status: 204 });
      }
      return handler(c, calls.filter((x) => x.url === url).length);
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('sends the CSRF cookie on state-changing calls only', async () => {
    const calls = fakeFetch(() => json(200, {}));
    await api('GET', '/invoices/');
    await api('POST', '/invoices/', { a: 1 });
    expect(calls[0]?.headers['x-csrf-token']).toBeUndefined();
    expect(calls[1]?.headers).toMatchObject({ 'x-csrf-token': 'tok123', 'content-type': 'application/json' });
  });

  it('parallel 401s share ONE refresh, then each request is retried once', async () => {
    const calls = fakeFetch((_c, n) => (n === 1 ? json(401, { error: { code: 'unauthorized' } }) : json(200, { ok: true })));
    const results = await Promise.all([api('GET', '/a'), api('GET', '/b'), api('GET', '/c')]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(calls).toHaveLength(7);
  });

  it('login failures are not retried through refresh', async () => {
    const calls = fakeFetch(() => json(401, { error: { code: 'unauthorized', message: 'invalid credentials' } }));
    await expect(api('POST', '/auth/login', {})).rejects.toMatchObject({ status: 401, message: 'invalid credentials' });
    expect(calls).toHaveLength(1);
  });

  it('maps the error envelope, preferring the first validation detail', async () => {
    fakeFetch(() => json(400, { error: { code: 'validation_error', message: 'invalid request', details: [{ path: 'url', message: 'must be https' }] } }));
    const e = await api('POST', '/webhooks/', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'validation_error', message: 'url: must be https' });
  });
});
