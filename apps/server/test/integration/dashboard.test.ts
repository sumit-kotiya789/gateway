import { randomBytes } from 'node:crypto';
import { evmDeriver } from '@gw/chains';
import { uuidv7 } from '@gw/core';
import { HDKey } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/common/crypto/password.js';
import { secretAad } from '../../src/modules/webhooks/webhooks.routes.js';
import { Agent, buildTestApp, enable2fa, ensureLocalRegistry, merchantWithKey, ownerPool, randomXpub, signup, totpNow, uniqueEmail } from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
  await ensureLocalRegistry(owner);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** Owner with 2FA; `code()` returns a fresh, not-yet-used TOTP code. */
async function ownerWith2fa() {
  const s = await signup(app);
  const { secret } = await enable2fa(s.agent, clock);
  const code = () => {
    clock.advance(30_000);
    return { 'x-totp-code': totpNow(secret, clock()) };
  };
  return { ...s, code };
}

/** Adds a teammate with the given role directly in the DB (team endpoints ship later) and logs them in. */
async function teammate(merchantId: string, role: 'developer' | 'read_only') {
  const email = uniqueEmail(role);
  const password = 'teammate password 1';
  await owner.query('insert into merchant_users (id, merchant_id, email, password_hash, role) values ($1, $2, $3, $4, $5)', [
    uuidv7(),
    merchantId,
    email,
    await hashPassword(password),
    role,
  ]);
  const agent = new Agent(app);
  const r = await agent.req('POST', '/v1/dashboard/auth/login', { email, password });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.body}`);
  return agent;
}

describe('2FA setup', () => {
  it('returns a QR code for the otpauth URI', async () => {
    const s = await signup(app);
    const r = await s.agent.req('POST', '/v1/dashboard/auth/2fa/setup');
    expect(r.json().qr_svg).toMatch(/^<svg/);
  });
});

describe('xpubs', () => {
  it('preview derives the first five addresses and refuses private keys', async () => {
    const s = await ownerWith2fa();
    const xpub = randomXpub();
    const r = await s.agent.req('POST', '/v1/dashboard/xpubs/preview', { xpub });
    expect(r.statusCode).toBe(200);
    const b = r.json<{ addresses: { index: number; address: string; path: string }[] }>();
    expect(b.addresses).toHaveLength(5);
    expect(b.addresses[3]).toEqual({ index: 3, ...evmDeriver.deriveFromXpub(xpub, 3) });

    const xprv = HDKey.fromMasterSeed(randomBytes(32)).derive("m/44'/60'/0'").privateExtendedKey;
    const bad = await s.agent.req('POST', '/v1/dashboard/xpubs/preview', { xpub: xprv });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.reason).toBe('private_key');
    expect(bad.body).not.toContain(xprv);
  });

  it('registering needs a fresh TOTP code and the owner role', async () => {
    const s = await ownerWith2fa();
    expect((await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: randomXpub() })).statusCode).toBe(403);
    const dev = await teammate(s.merchantId, 'developer');
    expect((await dev.req('POST', '/v1/dashboard/xpubs/preview', { xpub: randomXpub() })).statusCode).toBe(403);
    expect((await dev.req('GET', '/v1/dashboard/xpubs/?livemode=false')).statusCode).toBe(200);
  });

  it('registers, rotates (old one retired), and new invoices derive from the new key at index 0', async () => {
    const s = await ownerWith2fa();
    const first = randomXpub();
    const second = randomXpub();
    const r1 = await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: first }, s.code());
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({ status: 'active', livemode: false, next_index: 0, first_address: evmDeriver.deriveFromXpub(first, 0).address });
    expect(r1.body).not.toContain(first);

    expect((await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: first }, s.code())).statusCode).toBe(409);
    expect((await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: second }, s.code())).statusCode).toBe(201);

    const list = (await s.agent.req('GET', '/v1/dashboard/xpubs/?livemode=false')).json<{ data: { status: string; first_address: string }[] }>();
    expect(list.data.map((x) => x.status)).toEqual(['active', 'retired']);
    expect(list.data[0]?.first_address).toBe(evmDeriver.deriveFromXpub(second, 0).address);
    expect((await s.agent.req('GET', '/v1/dashboard/xpubs/?livemode=true')).json().data).toEqual([]);

    const inv = await s.agent.req('POST', '/v1/dashboard/invoices/', { livemode: false, amount: '10', token: 'evm-local:usdt' });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().deposit_address).toBe(evmDeriver.deriveFromXpub(second, 0).address);

    const audit = await owner.query<{ after: { fingerprint: string } }>("select after from audit_logs where merchant_id = $1 and action = 'xpub.registered'", [s.merchantId]);
    expect(audit.rows).toHaveLength(2);
    expect(JSON.stringify(audit.rows)).not.toContain(second);
  });

  it('a key already registered by another merchant is refused', async () => {
    const a = await ownerWith2fa();
    const b = await ownerWith2fa();
    const xpub = randomXpub();
    expect((await a.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub }, a.code())).statusCode).toBe(201);
    expect((await b.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub }, b.code())).statusCode).toBe(409);
  });

  it('custodial merchants cannot register xpubs', async () => {
    const s = await ownerWith2fa();
    await owner.query("update merchants set custody_mode = 'custodial' where id = $1", [s.merchantId]);
    expect((await s.agent.req('POST', '/v1/dashboard/xpubs/', { livemode: false, xpub: randomXpub() }, s.code())).statusCode).toBe(409);
  });
});

describe('webhook endpoints', () => {
  it('create needs TOTP, returns the secret once, stores it encrypted', async () => {
    const s = await ownerWith2fa();
    const body = { livemode: false, url: 'https://shop.example/hooks', description: 'orders' };
    expect((await s.agent.req('POST', '/v1/dashboard/webhooks/', body)).statusCode).toBe(403);
    const r = await s.agent.req('POST', '/v1/dashboard/webhooks/', body, s.code());
    expect(r.statusCode).toBe(201);
    const { id, secret } = r.json<{ id: string; secret: string }>();
    expect(secret).toMatch(/^whsec_[0-9A-Za-z]{40}$/);

    const list = await s.agent.req('GET', '/v1/dashboard/webhooks/?livemode=false');
    expect(list.json().data).toEqual([expect.objectContaining({ id, url: body.url, description: 'orders' })]);
    expect(list.body).not.toContain(secret);
    expect((await s.agent.req('GET', '/v1/dashboard/webhooks/?livemode=true')).json().data).toEqual([]);

    const row = await owner.query<{ secret_enc: string }>('select secret_enc from webhook_endpoints where id = $1', [id]);
    const enc = row.rows[0]?.secret_enc ?? '';
    expect(enc).not.toContain(secret);
    expect(await deps.envelope.open(enc, secretAad(id))).toBe(secret);
  });

  it.each(['javascript:alert(1)', 'ftp://shop.example/x', 'https://u:p@shop.example/x', 'not a url'])('rejects url %s', async (url) => {
    const s = await ownerWith2fa();
    expect((await s.agent.req('POST', '/v1/dashboard/webhooks/', { livemode: false, url }, s.code())).statusCode).toBe(400);
  });

  it('delete is tenant-scoped', async () => {
    const a = await ownerWith2fa();
    const b = await ownerWith2fa();
    const { id } = (await a.agent.req('POST', '/v1/dashboard/webhooks/', { livemode: false, url: 'https://a.example/h' }, a.code())).json<{ id: string }>();
    expect((await b.agent.req('DELETE', `/v1/dashboard/webhooks/${id}`)).statusCode).toBe(404);
    expect((await a.agent.req('DELETE', `/v1/dashboard/webhooks/${id}`)).statusCode).toBe(204);
    expect((await a.agent.req('GET', '/v1/dashboard/webhooks/?livemode=false')).json().data).toEqual([]);
  });

  it('read_only users cannot see webhook endpoints', async () => {
    const s = await ownerWith2fa();
    const ro = await teammate(s.merchantId, 'read_only');
    expect((await ro.req('GET', '/v1/dashboard/webhooks/?livemode=false')).statusCode).toBe(403);
  });
});

describe('dashboard invoices', () => {
  it('lists per mode, shows history, cancels; tenant-scoped', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const viaApi = (await m.api('POST', '/v1/invoices', { amount: '5', token: 'evm-local:usdt' })).json<{ id: string }>();
    const created = await m.agent.req('POST', '/v1/dashboard/invoices/', { livemode: false, amount: '7.5', token: 'evm-local:usdt', description: 'test' });
    expect(created.statusCode).toBe(201);
    const inv = created.json<{ id: string; amount: string; status: string }>();
    expect(inv).toMatchObject({ amount: '7.5', status: 'pending' });

    const list = (await m.agent.req('GET', '/v1/dashboard/invoices/?livemode=false&limit=1')).json<{ data: { id: string }[]; has_more: boolean; next_cursor: string }>();
    expect(list.data.map((x) => x.id)).toEqual([inv.id]);
    expect(list.has_more).toBe(true);
    const page2 = (await m.agent.req('GET', `/v1/dashboard/invoices/?livemode=false&starting_after=${list.next_cursor}`)).json<{ data: { id: string }[] }>();
    expect(page2.data.map((x) => x.id)).toEqual([viaApi.id]);
    expect((await m.agent.req('GET', '/v1/dashboard/invoices/?livemode=true')).json().data).toEqual([]);

    const cancel = await m.agent.req('POST', `/v1/dashboard/invoices/${inv.id}/cancel`);
    expect(cancel.json().status).toBe('cancelled');
    expect((await m.agent.req('POST', `/v1/dashboard/invoices/${inv.id}/cancel`)).statusCode).toBe(409);
    const detail = (await m.agent.req('GET', `/v1/dashboard/invoices/${inv.id}`)).json<{ history: { to: string; reason: string }[] }>();
    expect(detail.history.map((h) => h.to)).toEqual(['created', 'pending', 'cancelled']);
    expect(detail.history[2]?.reason).toBe('cancelled by merchant in dashboard');

    const other = await signup(app);
    expect((await other.agent.req('GET', `/v1/dashboard/invoices/${inv.id}`)).statusCode).toBe(404);
    expect((await other.agent.req('POST', `/v1/dashboard/invoices/${inv.id}/cancel`)).statusCode).toBe(404);
  });

  it('read_only can read but not create; amount errors surface', async () => {
    const m = await merchantWithKey(app, clock, owner);
    const ro = await teammate(m.merchantId, 'read_only');
    expect((await ro.req('GET', '/v1/dashboard/invoices/?livemode=false')).statusCode).toBe(200);
    expect((await ro.req('POST', '/v1/dashboard/invoices/', { livemode: false, amount: '1', token: 'evm-local:usdt' })).statusCode).toBe(403);
    const bad = await m.agent.req('POST', '/v1/dashboard/invoices/', { livemode: false, amount: '0.001', token: 'evm-local:usdt' });
    expect(bad.json().error.code).toBe('invalid_amount');
  });

  it('needs a session and CSRF token', async () => {
    const m = await merchantWithKey(app, clock, owner);
    expect((await new Agent(app).req('GET', '/v1/dashboard/invoices/')).statusCode).toBe(401);
    const noCsrf = await m.agent.req('POST', '/v1/dashboard/invoices/', { livemode: false, amount: '1', token: 'evm-local:usdt' }, { 'x-csrf-token': 'wrong' });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('dashboard tokens', () => {
  it('filters by mode', async () => {
    const s = await signup(app);
    const test = (await s.agent.req('GET', '/v1/dashboard/tokens/?livemode=false')).json<{ data: { id: string }[] }>();
    expect(test.data.map((x) => x.id)).toContain('evm-local:usdt');
    const live = (await s.agent.req('GET', '/v1/dashboard/tokens/?livemode=true')).json<{ data: { id: string }[] }>();
    expect(live.data.map((x) => x.id)).not.toContain('evm-local:usdt');
  });
});
