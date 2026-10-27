import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, Agent, adminAgent, buildTestApp, ownerPool, totpNow, uniqueEmail } from './helpers.js';

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

const secretOf = (uri: string) => new URL(uri).searchParams.get('secret') ?? '';
async function loginWith(email: string, password: string, secret: string) {
  const agent = new Agent(app, ADMIN_ORIGIN);
  clock.advance(30_000);
  const r = await agent.req('POST', '/admin/v1/auth/login', { email, password, code: totpNow(secret, clock()) });
  return { agent, status: r.statusCode };
}

describe('admin accounts', () => {
  it('only superadmins manage admins; creating needs step-up and returns credentials once', async () => {
    const op = await adminAgent(t, owner, 'operator');
    expect((await op.agent.req('GET', '/admin/v1/admins/')).statusCode).toBe(403);
    const sa = await adminAgent(t, owner, 'superadmin');
    const email = uniqueEmail('newadmin');
    const body = { email, role: 'auditor', reason: 'new compliance hire' };
    expect((await sa.agent.req('POST', '/admin/v1/admins/', body)).statusCode).toBe(403); // no TOTP
    const r = await sa.agent.req('POST', '/admin/v1/admins/', body, sa.stepUp());
    expect(r.statusCode).toBe(201);
    const created = r.json<{ id: string; role: string; password: string; totp_uri: string }>();
    expect(created.role).toBe('auditor');
    expect(created.totp_uri).toMatch(/^otpauth:\/\/totp\//);
    // The password and TOTP secret are not stored in clear and the list never shows them.
    const row = await owner.query<{ password_hash: string; totp_secret_enc: string }>('select password_hash, totp_secret_enc from admin_users where id = $1', [created.id]);
    expect(row.rows[0]?.password_hash).not.toContain(created.password);
    expect(row.rows[0]?.totp_secret_enc).not.toContain(secretOf(created.totp_uri));
    const list = await sa.agent.req('GET', '/admin/v1/admins/');
    expect(list.body).not.toContain(created.password);
    expect(list.json<{ data: { id: string }[] }>().data.map((a) => a.id)).toContain(created.id);

    expect((await loginWith(email, created.password, secretOf(created.totp_uri))).status).toBe(200);
    expect((await sa.agent.req('POST', '/admin/v1/admins/', { ...body, email: email.toUpperCase() }, sa.stepUp())).statusCode).toBe(409);
    const audit = await owner.query("select actor_id, after from audit_logs where action = 'admin.created' and target_id = $1", [created.id]);
    expect(audit.rows[0]).toMatchObject({ actor_id: sa.id, after: { role: 'auditor', reason: 'new compliance hire' } });
  });

  it('role change takes effect at once on the open session; disable cuts off, enable needs step-up', async () => {
    const sa = await adminAgent(t, owner, 'superadmin');
    const target = await adminAgent(t, owner, 'operator');
    expect((await target.agent.req('GET', '/admin/v1/merchants')).statusCode).toBe(200);

    const role = await sa.agent.req('PUT', `/admin/v1/admins/${target.id}/role`, { role: 'auditor', reason: 'moved to audit' }, sa.stepUp());
    expect(role.json()).toMatchObject({ role: 'auditor' });
    expect((await target.agent.req('GET', '/admin/v1/merchants')).statusCode).toBe(401); // token role no longer matches

    const again = await adminAgent(t, owner, 'operator');
    expect((await sa.agent.req('POST', `/admin/v1/admins/${again.id}/disable`, { reason: 'left the company' })).json()).toMatchObject({ disabled: true });
    expect((await again.agent.req('GET', '/admin/v1/merchants')).statusCode).toBe(401);
    expect((await loginWith(again.email, again.password, again.secret)).status).toBe(401);
    expect((await sa.agent.req('POST', `/admin/v1/admins/${again.id}/enable`, { reason: 'rehired' })).statusCode).toBe(403);
    expect((await sa.agent.req('POST', `/admin/v1/admins/${again.id}/enable`, { reason: 'rehired' }, sa.stepUp())).json()).toMatchObject({ disabled: false });
    expect((await loginWith(again.email, again.password, again.secret)).status).toBe(200);
  });

  it('credential reset: old password, authenticator and sessions stop working; new ones work', async () => {
    const sa = await adminAgent(t, owner, 'superadmin');
    const target = await adminAgent(t, owner, 'operator');
    const r = await sa.agent.req('POST', `/admin/v1/admins/${target.id}/reset-credentials`, { reason: 'lost phone, id checked' }, sa.stepUp());
    expect(r.statusCode).toBe(200);
    const fresh = r.json<{ password: string; totp_uri: string }>();
    expect((await target.agent.req('GET', '/admin/v1/merchants')).statusCode).toBe(401);
    expect((await loginWith(target.email, target.password, target.secret)).status).toBe(401);
    expect((await loginWith(target.email, fresh.password, target.secret)).status).toBe(401);
    expect((await loginWith(target.email, fresh.password, secretOf(fresh.totp_uri))).status).toBe(200);
    await expect(owner.query('update admin_users set session_epoch = 0 where id = $1', [target.id])).rejects.toThrow(/cannot go down/);
  });

  it('nobody manages their own account; an active superadmin always remains', async () => {
    const sa = await adminAgent(t, owner, 'superadmin');
    expect((await sa.agent.req('POST', `/admin/v1/admins/${sa.id}/disable`, { reason: 'testing self' })).statusCode).toBe(403);
    expect((await sa.agent.req('PUT', `/admin/v1/admins/${sa.id}/role`, { role: 'operator', reason: 'testing self' }, sa.stepUp())).statusCode).toBe(403);
    expect((await sa.agent.req('POST', `/admin/v1/admins/${sa.id}/reset-credentials`, { reason: 'testing self' }, sa.stepUp())).statusCode).toBe(403);
    expect((await sa.agent.req('POST', '/admin/v1/admins/00000000-0000-7000-8000-000000000000/disable', { reason: 'missing one' })).statusCode).toBe(404);

    // DB backstop: disabling every superadmin in one transaction fails at commit (rolled back).
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query("update admin_users set disabled_at = now() where role = 'superadmin'");
      await expect(c.query('commit')).rejects.toThrow(/no active superadmin/);
    } finally {
      c.release();
    }
    expect((await sa.agent.req('GET', '/admin/v1/admins/')).statusCode).toBe(200);
  });
});
