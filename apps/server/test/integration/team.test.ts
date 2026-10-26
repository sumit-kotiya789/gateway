import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVITE_TTL_MS } from '../../src/modules/team/team.routes.js';
import { Agent, buildTestApp, enable2fa, ownerPool, signup, totpNow, uniqueEmail } from './helpers.js';

const t = buildTestApp({ DASHBOARD_URL: 'http://dash.test' });
const { app, clock, deps } = t;
const owner = ownerPool();
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const T = '/v1/dashboard/team';
type Member = { id: string; email: string; role: string; email_verified: boolean };

/** Signed-up user with 2FA; `code()` is a fresh step-up header. */
async function withTotp(agent: Agent) {
  const { secret } = await enable2fa(agent, clock);
  return () => {
    clock.advance(30_000);
    return { 'x-totp-code': totpNow(secret, clock()) };
  };
}
async function ownerAccount() {
  const s = await signup(app, 'Team Co');
  return { ...s, code: await withTotp(s.agent) };
}

/** The invite link from the encrypted outbox (decrypted with this app's key; no worker involved). */
async function inviteToken(merchantId: string, email: string): Promise<string> {
  const rows = await owner.query<{ id: string; payload_enc: string }>(
    "select id, payload_enc from email_outbox where merchant_id = $1 and kind = 'team_invite' order by created_at desc",
    [merchantId],
  );
  for (const r of rows.rows) {
    const msg = JSON.parse(await deps.envelope.open(r.payload_enc, `email_outbox:${r.id}`)) as { to: string; text: string };
    if (msg.to === email) return /token=([A-Za-z0-9_-]{43})/.exec(msg.text)?.[1] ?? '';
  }
  throw new Error(`no invite to ${email}`);
}

/** Owner invites `email` as `role`; the invitee accepts and is signed in. */
async function join(o: Awaited<ReturnType<typeof ownerAccount>>, role: string, email = uniqueEmail(role)) {
  const inv = await o.agent.req('POST', `${T}/invites`, { email, role }, o.code());
  expect(inv.statusCode).toBe(201);
  const agent = new Agent(app);
  const acc = await agent.req('POST', '/v1/dashboard/auth/invite/accept', { token: await inviteToken(o.merchantId, email), password: 'member password 1' });
  expect(acc.statusCode).toBe(201);
  return { agent, email, id: acc.json<{ user: { id: string } }>().user.id, inviteId: inv.json<{ id: string }>().id };
}

describe('invites', () => {
  it('owner invites; preview names the merchant; accepting signs in a verified member; the link works once', async () => {
    const o = await ownerAccount();
    const email = uniqueEmail('dev');
    expect((await o.agent.req('POST', `${T}/invites`, { email, role: 'developer' })).statusCode).toBe(403); // step-up
    const r = await o.agent.req('POST', `${T}/invites`, { email: email.toUpperCase(), role: 'developer' }, o.code());
    expect(r.json()).toMatchObject({ email, role: 'developer' });
    const token = await inviteToken(o.merchantId, email);
    const anon = new Agent(app);
    expect((await anon.req('POST', '/v1/dashboard/auth/invite/preview', { token })).json()).toMatchObject({ merchant_name: 'Team Co', email, role: 'developer' });
    expect((await o.agent.req('GET', T)).json<{ invites: unknown[] }>().invites).toHaveLength(1);

    expect((await anon.req('POST', '/v1/dashboard/auth/invite/accept', { token, password: 'member password 1' })).statusCode).toBe(201);
    const me = (await anon.req('GET', '/v1/dashboard/auth/me')).json<{ user: { role: string; email_verified: boolean }; merchant: { id: string } }>();
    expect(me).toMatchObject({ user: { role: 'developer', email_verified: true }, merchant: { id: o.merchantId } });
    expect((await new Agent(app).req('POST', '/v1/dashboard/auth/invite/accept', { token, password: 'member password 2' })).json().error.details.reason).toBe('invalid_token');

    const team = (await o.agent.req('GET', T)).json<{ members: Member[]; invites: unknown[] }>();
    expect(team.members.map((m) => [m.email, m.role])).toEqual([
      [o.email, 'owner'],
      [email, 'developer'],
    ]);
    expect(team.invites).toEqual([]);
    const audit = await owner.query<{ action: string }>("select action from audit_logs where merchant_id = $1 and action like 'team.%' order by seq", [o.merchantId]);
    expect(audit.rows.map((a) => a.action)).toEqual(['team.invited', 'team.invite_accepted']);
  });

  it('who may invite whom: admins only non-privileged roles; developers nobody', async () => {
    const o = await ownerAccount();
    const admin = await join(o, 'admin');
    const adminCode = await withTotp(admin.agent);
    expect((await admin.agent.req('POST', `${T}/invites`, { email: uniqueEmail(), role: 'owner' }, adminCode())).statusCode).toBe(403);
    expect((await admin.agent.req('POST', `${T}/invites`, { email: uniqueEmail(), role: 'admin' }, adminCode())).statusCode).toBe(403);
    expect((await admin.agent.req('POST', `${T}/invites`, { email: uniqueEmail(), role: 'finance' }, adminCode())).statusCode).toBe(201);
    const dev = await join(o, 'developer');
    const devCode = await withTotp(dev.agent);
    expect((await dev.agent.req('POST', `${T}/invites`, { email: uniqueEmail(), role: 'read_only' }, devCode())).statusCode).toBe(403);
    expect((await dev.agent.req('GET', T)).statusCode).toBe(200); // everyone sees the team
  });

  it('existing accounts, duplicate open invites, revoked and expired invites are refused', async () => {
    const o = await ownerAccount();
    const other = await signup(app);
    expect((await o.agent.req('POST', `${T}/invites`, { email: other.email, role: 'developer' }, o.code())).statusCode).toBe(409);
    const email = uniqueEmail();
    const first = await o.agent.req('POST', `${T}/invites`, { email, role: 'developer' }, o.code());
    expect((await o.agent.req('POST', `${T}/invites`, { email, role: 'finance' }, o.code())).statusCode).toBe(409);
    const token = await inviteToken(o.merchantId, email);
    expect((await o.agent.req('DELETE', `${T}/invites/${first.json<{ id: string }>().id}`)).statusCode).toBe(204);
    expect((await new Agent(app).req('POST', '/v1/dashboard/auth/invite/accept', { token, password: 'member password 1' })).statusCode).toBe(400);

    const email2 = uniqueEmail();
    await o.agent.req('POST', `${T}/invites`, { email: email2, role: 'developer' }, o.code());
    const token2 = await inviteToken(o.merchantId, email2);
    clock.advance(INVITE_TTL_MS + 1000);
    expect((await new Agent(app).req('POST', '/v1/dashboard/auth/invite/preview', { token: token2 })).statusCode).toBe(400);
    // Who was invited, with which role, never changes, even for an open invite.
    await expect(owner.query("update team_invites set role = 'owner' where email = $1", [email2])).rejects.toThrow(/immutable/);
  });
});

describe('members', () => {
  it('role change signs the member out; limits on self, owners and admins', async () => {
    const o = await ownerAccount();
    const dev = await join(o, 'developer');
    const r = await o.agent.req('POST', `${T}/members/${dev.id}/role`, { role: 'admin' }, o.code());
    expect(r.json()).toMatchObject({ role: 'admin' });
    expect((await dev.agent.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);
    expect((await o.agent.req('POST', `${T}/members/${dev.id}/role`, { role: 'admin' }, o.code())).statusCode).toBe(409); // unchanged

    const admin = await join(o, 'admin');
    const adminCode = await withTotp(admin.agent);
    expect((await admin.agent.req('POST', `${T}/members/${dev.id}/role`, { role: 'developer' }, adminCode())).statusCode).toBe(403); // admin vs admin
    expect((await admin.agent.req('POST', `${T}/members/${o.userId}/role`, { role: 'developer' }, adminCode())).statusCode).toBe(403); // admin vs owner
    expect((await o.agent.req('POST', `${T}/members/${o.userId}/role`, { role: 'admin' }, o.code())).statusCode).toBe(409); // self
    expect((await o.agent.req('POST', `${T}/members/00000000-0000-7000-8000-000000000000/role`, { role: 'admin' }, o.code())).statusCode).toBe(404);
  });

  it('the last owner cannot be demoted or removed; with two owners one can go', async () => {
    const o = await ownerAccount();
    const second = await join(o, 'owner');
    const secondCode = await withTotp(second.agent);
    expect((await second.agent.req('POST', `${T}/members/${o.userId}/role`, { role: 'admin' }, secondCode())).statusCode).toBe(200);
    // `second` is now the only active owner: the API refuses to remove or demote them (assertAnotherOwner) and so does
    // the database, whatever the application does.
    expect((await second.agent.req('DELETE', `${T}/members/${second.id}`, undefined, secondCode())).statusCode).toBe(409); // self
    // The demoted first owner still holds a (≤10 min) access token claiming `owner`: the API checks the DB, not the claim.
    const removeLast = await o.agent.req('DELETE', `${T}/members/${second.id}`, undefined, o.code());
    expect(removeLast.statusCode).toBe(409);
    expect(removeLast.json().error.message).toMatch(/at least one owner/);
    await expect(owner.query('update merchant_users set removed_at = now() where id = $1', [second.id])).rejects.toThrow(/no active owner/);
    await expect(owner.query("update merchant_users set role = 'admin' where id = $1", [second.id])).rejects.toThrow(/no active owner/);
  });

  it('removal: signed out, cannot sign in or reset the password; a re-invite reactivates the account', async () => {
    const o = await ownerAccount();
    const dev = await join(o, 'developer');
    expect((await o.agent.req('DELETE', `${T}/members/${dev.id}`, undefined, o.code())).statusCode).toBe(204);
    expect((await dev.agent.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401);
    expect((await new Agent(app).req('POST', '/v1/dashboard/auth/login', { email: dev.email, password: 'member password 1' })).statusCode).toBe(401);
    expect((await o.agent.req('GET', T)).json<{ members: Member[] }>().members.map((m) => m.email)).not.toContain(dev.email);
    expect((await owner.query("select 1 from email_outbox where merchant_id = $1 and kind = 'team_removed'", [o.merchantId])).rowCount).toBe(1);
    expect((await o.agent.req('DELETE', `${T}/members/${dev.id}`, undefined, o.code())).statusCode).toBe(404);

    // Another merchant cannot invite the removed address; this merchant can, and accepting reactivates the same row.
    const other = await ownerAccount();
    expect((await other.agent.req('POST', `${T}/invites`, { email: dev.email, role: 'developer' }, other.code())).statusCode).toBe(409);
    const back = await join(o, 'finance', dev.email);
    expect(back.id).toBe(dev.id);
    expect((await new Agent(app).req('POST', '/v1/dashboard/auth/login', { email: dev.email, password: 'member password 1' })).json()).toEqual({ mfa_required: false });
  });
});
