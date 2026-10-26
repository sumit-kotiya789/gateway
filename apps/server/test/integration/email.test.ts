import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEmailJob } from '../../src/main-worker.js';
import { EMAIL_MAX_ATTEMPTS, deliverDueEmails } from '../../src/modules/email/outbox.js';
import type { EmailMessage, Mailer } from '../../src/modules/email/mailer.js';
import { Agent, adminAgent, buildTestApp, enable2fa, ownerPool, signup, totpNow } from './helpers.js';

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

const inbox: EmailMessage[] = [];
const mailer: Mailer = {
  send: async (m) => {
    inbox.push(m);
  },
};

/** Runs the outbox until an email to `to` with `subject` arrived (other test files enqueue emails concurrently). */
async function mailTo(to: string, subject: RegExp): Promise<EmailMessage> {
  for (let i = 0; i < 50; i++) {
    const found = inbox.find((m) => m.to === to && subject.test(m.subject));
    if (found) return found;
    await runEmailJob(deps, mailer);
  }
  throw new Error(`no email to ${to} matching ${String(subject)}`);
}
const tokenIn = (m: EmailMessage) => /token=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1] ?? '';
const kinds = async (merchantId: string) =>
  (await owner.query<{ kind: string }>('select kind from email_outbox where merchant_id = $1 order by created_at', [merchantId])).rows.map((r) => r.kind);

describe('email verification', () => {
  it('signup emails a link; the stored email is encrypted and erased once sent; the link works once', async () => {
    const s = await signup(app, 'Acme', { verified: false });
    const row = await owner.query<{ payload_enc: string }>("select payload_enc from email_outbox where merchant_id = $1 and kind = 'verify_email'", [s.merchantId]);
    expect(row.rows[0]?.payload_enc).not.toContain(s.email);

    const mail = await mailTo(s.email, /Confirm your email/);
    expect(mail.text).toContain('http://dash.test/#/verify-email?token=');
    const after = await owner.query<{ status: string; payload_enc: string | null }>("select status, payload_enc from email_outbox where merchant_id = $1 and kind = 'verify_email'", [s.merchantId]);
    expect(after.rows[0]).toEqual({ status: 'sent', payload_enc: null });

    expect((await s.agent.req('GET', '/v1/dashboard/auth/me')).json().user.email_verified).toBe(false);
    const anon = new Agent(app);
    expect((await anon.req('POST', '/v1/dashboard/auth/verify-email', { token: tokenIn(mail) })).statusCode).toBe(204);
    expect((await s.agent.req('GET', '/v1/dashboard/auth/me')).json().user.email_verified).toBe(true);
    const again = await anon.req('POST', '/v1/dashboard/auth/verify-email', { token: tokenIn(mail) });
    expect(again.json().error.details.reason).toBe('invalid_token');
  });

  it('live mode needs a verified email (step-up code not burned); test mode does not', async () => {
    const s = await signup(app, 'Acme', { verified: false });
    const { secret } = await enable2fa(s.agent, clock);
    clock.advance(30_000);
    const code = { 'x-totp-code': totpNow(secret, clock()) };
    const live = await s.agent.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: true, scopes: ['read'] }, code);
    expect(live.statusCode).toBe(403);
    expect(live.json().error.details.reason).toBe('email_unverified');
    for (const [url, body] of [
      ['/v1/dashboard/invoices/', { livemode: true, amount: '1', token: 'nope:usdt' }],
      ['/v1/dashboard/webhooks/', { livemode: true, url: 'https://example.com/hook' }],
      ['/v1/dashboard/xpubs/', { livemode: true, xpub: 'x' }],
    ] as const) {
      expect((await s.agent.req('POST', url, body, code)).json().error.details.reason).toBe('email_unverified');
    }
    // The same code still works: the refused requests never reached step-up.
    expect((await s.agent.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: false, scopes: ['read'] }, code)).statusCode).toBe(201);

    await anonVerify(s.email);
    clock.advance(30_000);
    const ok = await s.agent.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: true, scopes: ['read'] }, { 'x-totp-code': totpNow(secret, clock()) });
    expect(ok.statusCode).toBe(201);
  });

  it('resend is throttled, and a new link replaces the old one', async () => {
    const s = await signup(app, 'Acme', { verified: false });
    const first = await mailTo(s.email, /Confirm your email/);
    expect((await s.agent.req('POST', '/v1/dashboard/auth/verify-email/resend')).statusCode).toBe(429);
    clock.advance(61_000);
    expect((await s.agent.req('POST', '/v1/dashboard/auth/verify-email/resend')).statusCode).toBe(202);
    inbox.splice(inbox.indexOf(first), 1);
    const second = await mailTo(s.email, /Confirm your email/);
    const anon = new Agent(app);
    expect((await anon.req('POST', '/v1/dashboard/auth/verify-email', { token: tokenIn(first) })).statusCode).toBe(400);
    expect((await anon.req('POST', '/v1/dashboard/auth/verify-email', { token: tokenIn(second) })).statusCode).toBe(204);
    expect((await s.agent.req('POST', '/v1/dashboard/auth/verify-email/resend')).statusCode).toBe(409);
  });
});

async function anonVerify(email: string) {
  const mail = await mailTo(email, /Confirm your email/);
  const r = await new Agent(app).req('POST', '/v1/dashboard/auth/verify-email', { token: tokenIn(mail) });
  expect(r.statusCode).toBe(204);
}

describe('password reset', () => {
  const forgot = (email: string) => new Agent(app).req('POST', '/v1/dashboard/auth/password/forgot', { email });
  const reset = (body: Record<string, unknown>) => new Agent(app).req('POST', '/v1/dashboard/auth/password/reset', body);

  it('unknown addresses get the same 202 and no email', async () => {
    const r = await forgot('nobody-here@example.test');
    expect(r.statusCode).toBe(202);
    expect(await owner.query("select 1 from email_tokens t join merchant_users u on u.id = t.user_id where u.email = 'nobody-here@example.test'")).toMatchObject({ rowCount: 0 });
  });

  it('resets the password once, revokes every session, verifies the email, and says so by email', async () => {
    const s = await signup(app, 'Acme', { verified: false });
    expect((await forgot(s.email.toUpperCase())).statusCode).toBe(202);
    expect((await forgot(s.email)).statusCode).toBe(202); // throttled: still one email
    const mail = await mailTo(s.email, /Reset your password/);
    expect(mail.text).toContain('http://dash.test/#/reset-password?token=');
    expect((await owner.query("select 1 from email_tokens where user_id = $1 and purpose = 'password_reset'", [s.userId])).rowCount).toBe(1);

    expect((await reset({ token: tokenIn(mail), password: 'short' })).statusCode).toBe(400);
    expect((await reset({ token: tokenIn(mail), password: 'a brand new password' })).statusCode).toBe(204);
    expect((await s.agent.req('POST', '/v1/dashboard/auth/refresh')).statusCode).toBe(401); // old session revoked
    expect((await reset({ token: tokenIn(mail), password: 'another new password' })).json().error.details.reason).toBe('invalid_token');

    const login = await new Agent(app).req('POST', '/v1/dashboard/auth/login', { email: s.email, password: 'a brand new password' });
    expect(login.json()).toEqual({ mfa_required: false });
    expect((await owner.query<{ v: boolean }>('select email_verified_at is not null v from merchant_users where id = $1', [s.userId])).rows[0]?.v).toBe(true);
    await mailTo(s.email, /password was changed/);
    expect(await kinds(s.merchantId)).toEqual(expect.arrayContaining(['password_reset', 'password_changed']));
  });

  it('expires after an hour', async () => {
    const s = await signup(app);
    await forgot(s.email);
    const mail = await mailTo(s.email, /Reset your password/);
    clock.advance(3600_000 + 1000);
    expect((await reset({ token: tokenIn(mail), password: 'a brand new password' })).statusCode).toBe(400);
  });

  it('with 2FA on, the email alone is not enough: an authenticator or recovery code is required', async () => {
    const s = await signup(app);
    const { secret, recoveryCodes } = await enable2fa(s.agent, clock);
    clock.advance(61_000);
    await forgot(s.email);
    const mail = await mailTo(s.email, /Reset your password/);
    const base = { token: tokenIn(mail), password: 'a brand new password' };
    expect((await reset(base)).json().error.details.reason).toBe('mfa_required');
    expect((await reset({ ...base, code: '000000' })).statusCode).toBe(401);
    clock.advance(30_000);
    expect((await reset({ ...base, code: totpNow(secret, clock()) })).statusCode).toBe(204); // token was not consumed by the failures

    clock.advance(61_000);
    await forgot(s.email);
    inbox.splice(inbox.indexOf(mail), 1);
    const mail2 = await mailTo(s.email, /Reset your password/);
    expect((await reset({ token: tokenIn(mail2), password: 'yet another password', recovery_code: recoveryCodes[0] })).statusCode).toBe(204);
  });
});

describe('outbox delivery', () => {
  it('retries with backoff, then gives up and erases the payload', async () => {
    const s = await signup(app, 'Acme', { verified: false });
    await owner.query("update email_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending' and merchant_id <> $1", [s.merchantId]);
    const failing: Mailer = {
      send: async () => {
        throw Object.assign(new Error('smtp down for <user@example.test>'), { code: 'ECONNREFUSED' });
      },
    };
    const row = async () =>
      (await owner.query<{ status: string; attempts: number; last_error: string; payload_enc: string | null }>("select status, attempts, last_error, payload_enc from email_outbox where merchant_id = $1", [s.merchantId])).rows[0];
    for (let i = 1; i <= EMAIL_MAX_ATTEMPTS; i++) {
      await owner.query('update email_outbox set next_attempt_at = now() where merchant_id = $1 and status = $2', [s.merchantId, 'pending']);
      clock.advance(1000);
      await deliverDueEmails(deps, failing);
      expect((await row())?.attempts).toBe(i);
    }
    expect(await row()).toEqual({ status: 'failed', attempts: EMAIL_MAX_ATTEMPTS, last_error: 'ECONNREFUSED', payload_enc: null });
    await expect(owner.query("update email_outbox set status = 'pending' where merchant_id = $1", [s.merchantId])).rejects.toThrow(/final/);
  });
});

describe('notices', () => {
  it('admin 2FA reset tells the user by email', async () => {
    const s = await signup(app);
    await enable2fa(s.agent, clock);
    const op = await adminAgent(t, owner);
    const r = await op.agent.req('POST', `/admin/v1/merchants/${s.merchantId}/users/${s.userId}/reset-2fa`, { reason: 'lost phone, id checked' }, op.stepUp());
    expect(r.statusCode).toBe(204);
    await mailTo(s.email, /Two-factor authentication was reset/);
  });
});
