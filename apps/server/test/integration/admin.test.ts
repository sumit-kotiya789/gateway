import { uuidv7 } from '@gw/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/common/crypto/password.js';
import { generateTotpSecret } from '../../src/common/crypto/totp.js';
import { adminTotpAad } from '../../src/modules/auth/admin-auth.routes.js';
import { ADMIN_ORIGIN, Agent, buildTestApp, ownerPool, signup, totpNow, uniqueEmail } from './helpers.js';

const t = buildTestApp();
const { app, clock, deps } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

async function createAdmin(role = 'operator') {
  const id = uuidv7();
  const email = uniqueEmail('admin');
  const password = 'admin correct horse';
  const secret = generateTotpSecret();
  await owner.query(`insert into admin_users (id, email, password_hash, role, totp_secret_enc) values ($1, $2, $3, $4, $5)`, [
    id,
    email,
    await hashPassword(password),
    role,
    await deps.envelope.seal(secret, adminTotpAad(id)),
  ]);
  return { id, email, password, secret };
}

const adminLogin = (agent: Agent, body: Record<string, unknown>) =>
  agent.req('POST', '/admin/v1/auth/login', body, { 'x-forwarded-for': `10.88.0.${Math.floor(Math.random() * 250)}` });

describe('admin auth domain', () => {
  it('requires password AND TOTP; issues admin-scoped cookies', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    const agent = new Agent(app, ADMIN_ORIGIN);
    expect((await adminLogin(agent, { email: a.email, password: a.password, code: '000000' })).statusCode).toBe(401);
    expect((await adminLogin(agent, { email: a.email, password: 'wrong wrong wrong', code: totpNow(a.secret, clock()) })).statusCode).toBe(401);
    const ok = await adminLogin(agent, { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.find((c) => c.name === 'gw_admin_at')).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/admin' });
    expect((await agent.req('GET', '/admin/v1/auth/me')).json()).toMatchObject({ id: a.id, role: 'operator' });
  });

  it('merchant session cannot reach admin routes; admin token cannot reach dashboard', async () => {
    const { agent } = await signup(app);
    const asAdmin = new Agent(app, ADMIN_ORIGIN);
    asAdmin.cookies.set('gw_admin_at', agent.cookies.get('gw_at') ?? '');
    expect((await asAdmin.req('GET', '/admin/v1/auth/me')).statusCode).toBe(401);

    const a = await createAdmin();
    clock.advance(30_000);
    const ag = new Agent(app, ADMIN_ORIGIN);
    await adminLogin(ag, { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    const cross = new Agent(app);
    cross.cookies.set('gw_at', ag.cookies.get('gw_admin_at') ?? '');
    expect((await cross.req('GET', '/v1/dashboard/auth/me')).statusCode).toBe(401);
  });

  it('login from dashboard origin is refused', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    const r = await adminLogin(new Agent(app), { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    expect(r.statusCode).toBe(403);
  });

  it('disabled admin is cut off immediately, even with a live token', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    const ag = new Agent(app, ADMIN_ORIGIN);
    await adminLogin(ag, { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    expect((await ag.req('GET', '/admin/v1/auth/me')).statusCode).toBe(200);
    await owner.query('update admin_users set disabled_at = now() where id = $1', [a.id]);
    expect((await ag.req('GET', '/admin/v1/auth/me')).statusCode).toBe(401);
  });

  it('admin login is audited', async () => {
    const a = await createAdmin();
    clock.advance(30_000);
    await adminLogin(new Agent(app, ADMIN_ORIGIN), { email: a.email, password: a.password, code: totpNow(a.secret, clock()) });
    const r = await owner.query(`select 1 from audit_logs where actor_id = $1 and action = 'admin.login'`, [a.id]);
    expect(r.rowCount).toBe(1);
  });
});

describe('admin IP allowlist', () => {
  const restricted = buildTestApp({ ADMIN_IP_ALLOWLIST: '192.0.2.0/24', TRUST_PROXY_HOPS: '1' });
  beforeAll(async () => {
    await restricted.app.ready();
  });
  afterAll(async () => {
    await restricted.close();
  });

  it('non-allowlisted IP gets 404 on every admin route', async () => {
    const r = await restricted.app.inject({ method: 'POST', url: '/admin/v1/auth/login', headers: { 'x-forwarded-for': '198.51.100.1' }, payload: {} });
    expect(r.statusCode).toBe(404);
    const ok = await restricted.app.inject({
      method: 'POST',
      url: '/admin/v1/auth/login',
      headers: { 'x-forwarded-for': '192.0.2.10', origin: ADMIN_ORIGIN },
      payload: { email: 'nobody@x.test', password: 'x', code: '000000' },
    });
    expect(ok.statusCode).toBe(401);
  });
});
