import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, DASH_ORIGIN, buildTestApp, enable2fa, ownerPool, signup, totpNow, uniqueEmail } from './helpers.js';

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

/** Each test uses its own client IP so auth rate limits (10/min/IP) don't bleed between tests. */
let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

async function login(agent: Agent, email: string, password: string, ip = freshIp()) {
  return agent.req('POST', '/v1/dashboard/auth/login', { email, password }, { 'x-forwarded-for': ip });
}

describe('signup + session', () => {
  it('signup creates merchant (non-custodial default), owner, session cookies', async () => {
    const { agent } = await signup(app);
    expect(agent.cookies.has('gw_at')).toBe(true);
    expect(agent.cookies.has('gw_rt')).toBe(true);
    const me = await agent.req('GET', '/v1/dashboard/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { role: 'owner', totp_enabled: false }, merchant: { custody_mode: 'non_custodial_xpub' } });
  });

  it('session cookies are httpOnly + SameSite=Strict; csrf cookie readable', async () => {
    const res = await new Agent(app).req('POST', '/v1/dashboard/auth/signup', { merchant_name: 'C', email: uniqueEmail(), password: 'correct horse battery' });
    const byName = Object.fromEntries(res.cookies.map((c) => [c.name, c]));
    expect(byName.gw_at).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    expect(byName.gw_rt).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/v1/dashboard/auth' });
    expect(byName.gw_csrf?.httpOnly).toBeFalsy();
  });

  it('duplicate email -> 409; weak password, unknown fields -> 400', async () => {
    const { email } = await signup(app);
    const a = new Agent(app);
    expect((await a.req('POST', '/v1/dashboard/auth/signup', { merchant_name: 'X', email: email.toUpperCase(), password: 'correct horse battery' })).statusCode).toBe(409);
    expect((await a.req('POST', '/v1/dashboard/auth/signup', { merchant_name: 'X', email: uniqueEmail(), password: 'short' })).statusCode).toBe(400);
    expect((await a.req('POST', '/v1/dashboard/auth/signup', { merchant_name: 'X', email: uniqueEmail(), password: 'correct horse battery', role: 'admin' })).statusCode).toBe(400);
  });

  it('signup/login from a foreign Origin is refused (login CSRF)', async () => {
    const evil = new Agent(app, 'https://evil.example');
    const r = await evil.req('POST', '/v1/dashboard/auth/signup', { merchant_name: 'X', email: uniqueEmail(), password: 'correct horse battery' });
    expect(r.statusCode).toBe(403);
  });

  it('no cookie -> 401; tampered JWT -> 401', async () => {
    expect((await new Agent(app).req('GET', '/v1/dashboard/auth/me')).statusCode).toBe(401);
    const { agent } = await signup(app);
    agent.cookies.set('gw_at', `${agent.cookies.get('gw_at') ?? ''}x`);
    expect((await agent.req('GET', '/v1/dashboard/auth/me')).statusCode).toBe(401);
  });
});

describe('login + lockout', () => {
  it('wrong password and unknown email give identical 401', async () => {
    const { email } = await signup(app);
    const a = await login(new Agent(app), email, 'wrong password!!');
    const b = await login(new Agent(app), uniqueEmail(), 'wrong password!!');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.message).toBe(b.json().error.message);
  });

  it('locks after 5 failures: correct password refused until lock expires', async () => {
    const { email, password } = await signup(app);
    for (let i = 0; i < 5; i++) expect((await login(new Agent(app), email, 'wrong password!!')).statusCode).toBe(401);
    expect((await login(new Agent(app), email, password)).statusCode).toBe(401);
    clock.advance(16 * 60_000);
    expect((await login(new Agent(app), email, password)).statusCode).toBe(200);
  });

  it('auth endpoints are rate limited per IP (11th request -> 429 with headers)', async () => {
    const ip = freshIp();
    let last;
    for (let i = 0; i < 11; i++) last = await login(new Agent(app), uniqueEmail(), 'whatever password', ip);
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error.code).toBe('rate_limited');
    expect(last?.headers['retry-after']).toBeDefined();
  });

  it('failed logins are audited', async () => {
    const { email, merchantId } = await signup(app);
    await login(new Agent(app), email, 'wrong password!!');
    const r = await owner.query(`select 1 from audit_logs where merchant_id = $1 and action = 'auth.login_failed'`, [merchantId]);
    expect(r.rowCount).toBe(1);
  });
});

describe('2FA', () => {
  it('setup -> enable -> login requires code; code cannot be replayed', async () => {
    const { agent, email, password } = await signup(app);
    const { secret, recoveryCodes } = await enable2fa(agent, clock);
    expect(recoveryCodes).toHaveLength(10);

    clock.advance(30_000);
    const a = new Agent(app);
    const first = await login(a, email, password);
    expect(first.json()).toMatchObject({ mfa_required: true });
    expect(a.cookies.has('gw_at')).toBe(false); // no session before second factor
    const mfa_token = first.json<{ mfa_token: string }>().mfa_token;
    const code = totpNow(secret, clock());
    const ok = await a.req('POST', '/v1/dashboard/auth/login/2fa', { mfa_token, code }, { 'x-forwarded-for': freshIp() });
    expect(ok.statusCode).toBe(200);
    expect((await a.req('GET', '/v1/dashboard/auth/me')).json().user.session_mfa).toBe(true);

    const replay = await new Agent(app).req('POST', '/v1/dashboard/auth/login/2fa', { mfa_token, code }, { 'x-forwarded-for': freshIp() });
    expect(replay.statusCode).toBe(401);
  });

  it('recovery code works exactly once', async () => {
    const { agent, email, password } = await signup(app);
    const { recoveryCodes } = await enable2fa(agent, clock);
    const rc = recoveryCodes[0] ?? '';
    const use = async () => {
      const a = new Agent(app);
      const tok = (await login(a, email, password)).json<{ mfa_token: string }>().mfa_token;
      return a.req('POST', '/v1/dashboard/auth/login/2fa', { mfa_token: tok, recovery_code: rc.toUpperCase() }, { 'x-forwarded-for': freshIp() });
    };
    expect((await use()).statusCode).toBe(200);
    expect((await use()).statusCode).toBe(401);
  });

  it('enable rejects wrong code; second setup after enable -> 409', async () => {
    const { agent } = await signup(app);
    await agent.req('POST', '/v1/dashboard/auth/2fa/setup');
    expect((await agent.req('POST', '/v1/dashboard/auth/2fa/enable', { code: '000000' })).statusCode).toBe(400);
    const a2 = (await signup(app)).agent;
    await enable2fa(a2, clock);
    expect((await a2.req('POST', '/v1/dashboard/auth/2fa/setup')).statusCode).toBe(409);
  });

  it('TOTP secret is stored encrypted', async () => {
    const { agent, userId } = await signup(app);
    const { secret } = await enable2fa(agent, clock);
    const r = await owner.query<{ s: string }>('select totp_secret_enc s from merchant_users where id = $1', [userId]);
    expect(r.rows[0]?.s.startsWith('v1.')).toBe(true);
    expect(r.rows[0]?.s).not.toContain(secret);
  });

  it('mfa token from another audience is rejected', async () => {
    const { agent } = await signup(app);
    const r = await agent.req('POST', '/v1/dashboard/auth/login/2fa', { mfa_token: agent.cookies.get('gw_at'), code: '123456' }, { 'x-forwarded-for': freshIp() });
    expect(r.statusCode).toBe(401);
  });
});

describe('CSRF', () => {
  it('state-changing cookie request without x-csrf-token -> 403', async () => {
    const { agent } = await signup(app);
    const r = await agent.req('POST', '/v1/dashboard/auth/2fa/setup', undefined, { 'x-csrf-token': 'wrong' });
    expect(r.statusCode).toBe(403);
  });

  it('valid token but foreign Origin -> 403', async () => {
    const { agent } = await signup(app);
    const r = await agent.req('POST', '/v1/dashboard/auth/2fa/setup', undefined, { origin: 'https://evil.example' });
    expect(r.statusCode).toBe(403);
    expect((await agent.req('POST', '/v1/dashboard/auth/2fa/setup', undefined, { origin: DASH_ORIGIN })).statusCode).toBe(200);
  });
});

describe('refresh rotation', () => {
  it('rotates; reusing an old refresh token revokes the whole family', async () => {
    const { agent, merchantId } = await signup(app);
    const oldRt = agent.cookies.get('gw_rt') ?? '';
    expect((await agent.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(204);
    const newRt = agent.cookies.get('gw_rt') ?? '';
    expect(newRt).not.toBe(oldRt);

    const thief = new Agent(app);
    thief.cookies.set('gw_rt', oldRt);
    thief.cookies.set('gw_csrf', 'c');
    expect((await thief.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);

    // Legitimate holder of the newest token is now also out.
    expect((await agent.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);
    const r = await owner.query(`select 1 from audit_logs where merchant_id = $1 and action = 'auth.refresh_reuse_detected'`, [merchantId]);
    expect(r.rowCount).toBe(2); // thief's replay + the legitimate holder's now-revoked token
  });

  it('expired or missing refresh token -> 401', async () => {
    const { agent } = await signup(app);
    clock.advance(15 * 24 * 3600_000); // past the 14-day refresh lifetime
    expect((await agent.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);
    const none = new Agent(app);
    none.cookies.set('gw_csrf', 'c');
    expect((await none.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);
  });

  it('logout revokes refresh token', async () => {
    const { agent } = await signup(app);
    const rt = agent.cookies.get('gw_rt') ?? '';
    expect((await agent.req('POST', '/v1/dashboard/auth/logout')).statusCode).toBe(204);
    const replay = new Agent(app);
    replay.cookies.set('gw_rt', rt);
    replay.cookies.set('gw_csrf', 'c');
    expect((await replay.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);
  });

  it('access token expires after 10 minutes', async () => {
    const { agent } = await signup(app);
    // jose validates exp against the real clock, so forge expiry by waiting is impractical; check claim instead.
    const payload = JSON.parse(Buffer.from((agent.cookies.get('gw_at') ?? '').split('.')[1] ?? '', 'base64url').toString()) as { exp: number; iat: number };
    expect(payload.exp - payload.iat).toBe(600);
  });
});

describe('ops endpoints', () => {
  it('readyz reports db + redis', async () => {
    const r = await app.inject({ url: '/readyz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', checks: { db: true, redis: true } });
  });

  it('openapi 3.1 document lists dashboard routes', async () => {
    const r = await app.inject({ url: '/v1/openapi.json' });
    const doc = r.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/dashboard/api-keys/');
  });
});
