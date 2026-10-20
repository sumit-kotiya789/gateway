import { hashPassword } from '../../src/common/crypto/password.js';
import { uuidv7 } from '@gw/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, buildTestApp, enable2fa, ownerPool, signup, totpNow, uniqueEmail } from './helpers.js';

const t = buildTestApp();
const { app, clock } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

/** Owner with 2FA enabled; `stepUp()` returns a fresh, never-used TOTP header. */
async function ownerWith2fa() {
  const s = await signup(app);
  const { secret } = await enable2fa(s.agent, clock);
  const stepUp = () => {
    clock.advance(30_000);
    return { 'x-totp-code': totpNow(secret, clock()) };
  };
  return { ...s, secret, stepUp };
}

async function createKey(o: Awaited<ReturnType<typeof ownerWith2fa>>, body: Record<string, unknown>) {
  return o.agent.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: false, scopes: ['read'], ...body }, o.stepUp());
}

const call = (key: string, headers: Record<string, string> = {}) =>
  app.inject({ url: '/v1/account', headers: { authorization: `Bearer ${key}`, ...headers } });

describe('API key lifecycle', () => {
  it('creation requires 2FA enabled', async () => {
    const { agent } = await signup(app);
    const r = await agent.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: false, scopes: ['read'] }, { 'x-totp-code': '123456' });
    expect(r.statusCode).toBe(403);
  });

  it('creation requires a fresh TOTP code (missing, wrong, replayed all refused)', async () => {
    const o = await ownerWith2fa();
    const body = { name: 'k', kind: 'secret', livemode: false, scopes: ['read'] };
    expect((await o.agent.req('POST', '/v1/dashboard/api-keys/', body)).statusCode).toBe(403);
    expect((await o.agent.req('POST', '/v1/dashboard/api-keys/', body, { 'x-totp-code': '000000' })).statusCode).toBe(403);
    const h = o.stepUp();
    expect((await o.agent.req('POST', '/v1/dashboard/api-keys/', body, h)).statusCode).toBe(201);
    expect((await o.agent.req('POST', '/v1/dashboard/api-keys/', body, h)).statusCode).toBe(403);
  });

  it('key shown once, stored as hash, listed by prefix only, authenticates', async () => {
    const o = await ownerWith2fa();
    const r = await createKey(o, {});
    expect(r.statusCode).toBe(201);
    const { key, prefix, id } = r.json<{ key: string; prefix: string; id: string }>();
    expect(key.startsWith(prefix)).toBe(true);

    const list = await o.agent.req('GET', '/v1/dashboard/api-keys/');
    expect(list.body).not.toContain(key);
    expect(list.body).toContain(prefix);

    const row = await owner.query<{ secret_hash: string }>('select secret_hash from api_keys where id = $1', [id]);
    expect(row.rows[0]?.secret_hash).not.toContain(key.slice(prefix.length));

    const acct = await call(key);
    expect(acct.statusCode).toBe(200);
    expect(acct.json()).toMatchObject({ merchant_id: o.merchantId, livemode: false, scopes: ['read'] });

    const audit = await owner.query<{ after: unknown }>(`select after from audit_logs where action = 'api_key.created' and target_id = $1`, [id]);
    expect(JSON.stringify(audit.rows[0]?.after)).not.toContain(key.slice(prefix.length));
  });

  it('wrong secret with valid prefix, malformed key, missing header -> 401', async () => {
    const o = await ownerWith2fa();
    const { key, prefix } = (await createKey(o, {})).json<{ key: string; prefix: string }>();
    const forged = prefix + 'A'.repeat(key.length - prefix.length);
    expect((await call(forged)).statusCode).toBe(401);
    expect((await call('sk_test_nope')).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/account' })).statusCode).toBe(401);
  });

  it('revoked key -> 401', async () => {
    const o = await ownerWith2fa();
    const { key, id } = (await createKey(o, {})).json<{ key: string; id: string }>();
    expect((await o.agent.req('DELETE', `/v1/dashboard/api-keys/${id}`)).statusCode).toBe(204);
    expect((await call(key)).statusCode).toBe(401);
    expect((await o.agent.req('DELETE', `/v1/dashboard/api-keys/${id}`)).statusCode).toBe(404);
  });

  it('expired key -> 401; past expiry rejected at creation', async () => {
    const o = await ownerWith2fa();
    const soon = new Date(clock() + 60 * 60_000).toISOString();
    const { key } = (await createKey(o, { expires_at: soon })).json<{ key: string }>();
    expect((await call(key)).statusCode).toBe(200);
    clock.advance(2 * 60 * 60_000);
    expect((await call(key)).statusCode).toBe(401);
    expect((await createKey(o, { expires_at: new Date(clock() - 1000).toISOString() })).statusCode).toBe(400);
  });

  it('IP allowlist enforced', async () => {
    const o = await ownerWith2fa();
    const { key } = (await createKey(o, { ip_allowlist: ['203.0.113.0/24'] })).json<{ key: string }>();
    expect((await call(key, { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(403);
    // inject() uses 127.0.0.1 unless trust proxy is on; the allowlist excludes it.
    expect((await call(key)).statusCode).toBe(403);
    expect((await createKey(o, { ip_allowlist: ['not-an-ip'] })).statusCode).toBe(400);
  });

  it('scope enforcement: key without read cannot read; publishable key is checkout-only', async () => {
    const o = await ownerWith2fa();
    const noRead = (await createKey(o, { scopes: ['invoices:write'] })).json<{ key: string }>().key;
    expect((await call(noRead)).statusCode).toBe(403);
    const pk = await o.agent.req('POST', '/v1/dashboard/api-keys/', { name: 'pk', kind: 'publishable', livemode: false }, o.stepUp());
    expect(pk.json()).toMatchObject({ scopes: ['checkout'] });
    expect((await call(pk.json<{ key: string }>().key)).statusCode).toBe(403);
    expect((await createKey(o, { kind: 'publishable', scopes: ['read'] })).statusCode).toBe(400);
    expect((await createKey(o, { scopes: ['checkout'] })).statusCode).toBe(400);
    expect((await createKey(o, { scopes: ['admin:everything'] })).statusCode).toBe(400);
  });

  it('suspended merchant keys stop working', async () => {
    const o = await ownerWith2fa();
    const { key } = (await createKey(o, {})).json<{ key: string }>();
    await owner.query(`update merchants set status = 'suspended' where id = $1`, [o.merchantId]);
    expect((await call(key)).statusCode).toBe(401);
  });

  it('secret API keys are rate limited per key', async () => {
    const o = await ownerWith2fa();
    const { key } = (await createKey(o, {})).json<{ key: string }>();
    const res = await call(key);
    expect(res.headers['x-ratelimit-limit']).toBe('300');
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThan(300);
  });
});

describe('tenant isolation', () => {
  it('merchant B cannot list or revoke merchant A keys', async () => {
    const a = await ownerWith2fa();
    const b = await ownerWith2fa();
    const { id, prefix } = (await createKey(a, {})).json<{ id: string; prefix: string }>();
    expect((await b.agent.req('GET', '/v1/dashboard/api-keys/')).body).not.toContain(prefix);
    expect((await b.agent.req('DELETE', `/v1/dashboard/api-keys/${id}`)).statusCode).toBe(404);
    const row = await owner.query<{ revoked_at: Date | null }>('select revoked_at from api_keys where id = $1', [id]);
    expect(row.rows[0]?.revoked_at).toBeNull();
  });

  it('audit log endpoint returns only own merchant entries', async () => {
    const a = await ownerWith2fa();
    const b = await ownerWith2fa();
    const la = (await a.agent.req('GET', '/v1/dashboard/audit-logs/?limit=100')).json<{ data: { target_id: string | null }[] }>();
    const ids = new Set(la.data.map((e) => e.target_id));
    expect(ids.has(b.merchantId)).toBe(false);
    expect(la.data.length).toBeGreaterThan(0);
  });
});

describe('RBAC', () => {
  async function member(merchantId: string, role: string) {
    const email = uniqueEmail(role);
    const password = 'correct horse battery';
    await owner.query(`insert into merchant_users (id, merchant_id, email, password_hash, role) values ($1, $2, $3, $4, $5)`, [
      uuidv7(),
      merchantId,
      email,
      await hashPassword(password),
      role,
    ]);
    const agent = new Agent(app);
    const r = await agent.req('POST', '/v1/dashboard/auth/login', { email, password }, { 'x-forwarded-for': `10.77.0.${Math.floor(Math.random() * 250)}` });
    expect(r.statusCode).toBe(200);
    return agent;
  }

  it('read_only and finance cannot manage API keys or read audit; developer can list keys', async () => {
    const o = await ownerWith2fa();
    for (const role of ['read_only', 'finance']) {
      const m = await member(o.merchantId, role);
      expect((await m.req('GET', '/v1/dashboard/api-keys/')).statusCode).toBe(403);
      expect((await m.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: false, scopes: ['read'] })).statusCode).toBe(403);
      expect((await m.req('GET', '/v1/dashboard/audit-logs/')).statusCode).toBe(403);
    }
    const dev = await member(o.merchantId, 'developer');
    expect((await dev.req('GET', '/v1/dashboard/api-keys/')).statusCode).toBe(200);
    expect((await dev.req('GET', '/v1/dashboard/audit-logs/')).statusCode).toBe(403);
  });
});
