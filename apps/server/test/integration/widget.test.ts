import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedOrigin } from '../../src/modules/checkout/checkout.routes.js';
import { buildTestApp, ensureLocalRegistry, merchantWithKey, ownerPool } from './helpers.js';

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

const SHOP = 'https://shop.test';

describe('embedOrigin', () => {
  it.each([
    [{ embed: '1', origin: SHOP }, SHOP],
    [{ embed: '1', origin: 'https://other.test' }, undefined],
    [{ embed: '1', origin: `${SHOP}/` }, undefined], // not an exact origin
    [{ embed: '1', origin: `${SHOP}/path` }, undefined],
    [{ embed: '1', origin: 'not a url' }, undefined],
    [{ embed: '1' }, undefined],
    [{ origin: SHOP }, undefined], // embed not requested
  ])('%j -> %s', (q, out) => {
    expect(embedOrigin(q, [SHOP])).toBe(out);
  });
});

describe('widget', () => {
  async function merchantWithOrigins(origins: string[]) {
    const m = await merchantWithKey(app, clock, owner);
    const r = await m.agent.req('PUT', '/v1/dashboard/settings/widget-origins', { widget_origins: origins });
    expect(r.statusCode).toBe(200);
    const inv = (await m.api('POST', '/v1/invoices', { amount: '5', token: 'evm-local:usdt' })).json<{ id: string }>();
    return { m, inv };
  }
  const cfgOf = (body: string) => JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(body)?.[1] ?? '{}') as { parentOrigin: string | null };

  it('the checkout can be framed only by an allowlisted origin, and posts only to it', async () => {
    const { inv } = await merchantWithOrigins([SHOP]);
    const ok = await app.inject({ url: `/checkout/${inv.id}?embed=1&origin=${encodeURIComponent(SHOP)}&utm_source=x` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-security-policy']).toContain(`frame-ancestors ${SHOP}`);
    expect(ok.headers['x-frame-options']).toBeUndefined();
    expect(cfgOf(ok.body).parentOrigin).toBe(SHOP);
    expect(ok.body).toContain('target="_top"');

    for (const url of [`/checkout/${inv.id}?embed=1&origin=${encodeURIComponent('https://evil.test')}`, `/checkout/${inv.id}`]) {
      const no = await app.inject({ url });
      expect(no.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(no.headers['x-frame-options']).toBe('DENY');
      expect(cfgOf(no.body).parentOrigin).toBeNull();
    }
  });

  it('settings: exact origins only, settings:manage, audited', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const put = (origins: string[]) => m.agent.req('PUT', '/v1/dashboard/settings/widget-origins', { widget_origins: origins });
    for (const bad of [[`${SHOP}/`], [`${SHOP}/checkout`], ['ftp://shop.test'], ['shop.test'], Array.from({ length: 11 }, (_, i) => `https://s${String(i)}.test`)]) {
      expect((await put(bad)).statusCode).toBe(400);
    }
    expect((await put([SHOP, SHOP, 'http://localhost:5173'])).json()).toEqual({ widget_origins: [SHOP, 'http://localhost:5173'] });
    expect((await m.agent.req('GET', '/v1/dashboard/settings/')).json()).toEqual({ widget_origins: [SHOP, 'http://localhost:5173'] });
    const a = await owner.query("select after from audit_logs where merchant_id = $1 and action = 'settings.widget_origins'", [m.merchantId]);
    expect(a.rows[0]?.after).toEqual({ widget_origins: [SHOP, 'http://localhost:5173'] });
  });

  it('widget.js is loadable cross-origin and only trusts the gateway frame', async () => {
    const r = await app.inject({ url: '/widget.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/javascript/);
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.body).toContain('e.origin !== base || e.source !== frame.contentWindow');
    expect(r.body).not.toMatch(/\beval\(|postMessage\([^)]*'\*'/);
  });
});
