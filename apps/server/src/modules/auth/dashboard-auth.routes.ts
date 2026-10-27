import { randomBytes } from 'node:crypto';
import { AppError, uuidv7 } from '@gw/core';
import QRCode from 'qrcode';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { PASSWORD_MAX, PASSWORD_MIN, burnPasswordCheck, hashPassword, verifyPassword } from '../../common/crypto/password.js';
import { sha256Hex } from '../../common/crypto/random.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../../common/crypto/totp.js';
import { withSystem, withTenant, type Tx } from '../../common/db.js';
import { merchantUsers, merchants, recoveryCodes, sessions } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { enqueueEmail } from '../email/outbox.js';
import { templates } from '../email/templates.js';
import { TOKEN_RESEND_MS, findEmailToken, issueEmailToken, lastTokenAt, useEmailToken } from '../email/tokens.js';
import { rememberDevice } from './devices.js';
import { checkCsrf, checkOrigin, requireTotp, requireUser } from './guards.js';
import { isLocked, lockoutUntil } from './lockout.js';
import {
  COOKIE,
  clearSessionCookies,
  issueSession,
  revokeSessionFamily,
  rotateSession,
  signMfaToken,
  verifyMfaToken,
} from './session.js';

export const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

const Email = z.email().max(254).transform((s) => s.toLowerCase());
const Password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
const TotpCode = z.string().regex(/^\d{6}$/);

const totpAad = (userId: string) => `merchant_users.totp:${userId}`;
const pendingAad = (userId: string) => `merchant_users.totp_pending:${userId}`;
const normalizeRecovery = (c: string) => c.toLowerCase().replace(/[^0-9a-f]/g, '');
const INVALID = () => new AppError('unauthorized', 'invalid credentials');

/** Emails a verification link (new token; earlier ones stop working). */
async function sendVerification(deps: Deps, tx: Tx, u: { id: string; merchantId: string; email: string }): Promise<void> {
  const token = await issueEmailToken(tx, u, 'verify_email', deps.clock());
  await enqueueEmail(deps, tx, { merchantId: u.merchantId, kind: 'verify_email', to: u.email, ...templates.verifyEmail(`${deps.config.DASHBOARD_URL}/#/verify-email?token=${token}`) });
}

function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(8).toString('hex').replace(/(.{4})(?=.)/g, '$1-'));
}

export function dashboardAuthRoutes(deps: Deps): FastifyPluginAsyncZod {
  const origins = deps.config.DASHBOARD_ORIGINS;

  return async (app) => {
    app.post(
      '/signup',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: { body: z.strictObject({ merchant_name: z.string().trim().min(1).max(200), email: Email, password: Password }) },
      },
      async (req, reply) => {
        if (!deps.config.SIGNUP_ENABLED) throw new AppError('forbidden', 'signup is disabled');
        checkOrigin(req, origins);
        const { merchant_name, email, password } = req.body;
        const passwordHash = await hashPassword(password);
        const out = await withSystem(deps.db, async (tx) => {
          const exists = await tx
            .select({ id: merchantUsers.id })
            .from(merchantUsers)
            .where(sql`lower(${merchantUsers.email}) = ${email}`);
          if (exists.length > 0) throw new AppError('conflict', 'email already registered');
          const [m] = await tx.insert(merchants).values({ name: merchant_name }).returning();
          if (!m) throw new Error('merchant insert failed');
          const [u] = await tx.insert(merchantUsers).values({ merchantId: m.id, email, passwordHash, role: 'owner' }).returning();
          if (!u) throw new Error('user insert failed');
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: m.id, action: 'merchant.created', targetType: 'merchant', targetId: m.id, after: { name: m.name, custody_mode: m.custodyMode } }, req);
          await sendVerification(deps, tx, u);
          await issueSession(deps, tx, req, reply, u, false);
          await rememberDevice(deps, tx, req, reply, u, { notify: false });
          return { merchant: { id: m.id, name: m.name, custody_mode: m.custodyMode }, user: { id: u.id, email: u.email, role: u.role } };
        });
        return reply.status(201).send(out);
      },
    );

    app.post(
      '/login',
      { config: { rateLimit: AUTH_RATE_LIMIT }, schema: { body: z.strictObject({ email: Email, password: z.string().max(PASSWORD_MAX) }) } },
      async (req, reply) => {
        checkOrigin(req, origins);
        const now = deps.clock();
        // Failure state must commit, so the transaction returns a result and throws afterwards.
        const result = await withSystem(deps.db, async (tx) => {
          const [u] = await tx.select().from(merchantUsers).where(sql`lower(${merchantUsers.email}) = ${req.body.email}`).for('update');
          if (!u || u.removedAt || isLocked(u.lockedUntil, now)) return burnPasswordCheck(req.body.password);
          if (!(await verifyPassword(u.passwordHash, req.body.password))) {
            const failed = u.failedLogins + 1;
            await tx.update(merchantUsers).set({ failedLogins: failed, lockedUntil: lockoutUntil(failed, now) }).where(eq(merchantUsers.id, u.id));
            await audit(tx, { actorType: 'anonymous', merchantId: u.merchantId, action: 'auth.login_failed', targetType: 'merchant_user', targetId: u.id, after: { failed } }, req);
            return false;
          }
          await tx.update(merchantUsers).set({ failedLogins: 0, lockedUntil: null }).where(eq(merchantUsers.id, u.id));
          if (u.totpEnabledAt) return { mfa_required: true as const, mfa_token: await signMfaToken(deps, u.id) };
          await issueSession(deps, tx, req, reply, u, false);
          const newDevice = await rememberDevice(deps, tx, req, reply, u, { notify: true });
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.login', after: { mfa: false, new_device: newDevice } }, req);
          return { mfa_required: false as const };
        });
        if (result === false) throw INVALID();
        return result;
      },
    );

    app.post(
      '/login/2fa',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: {
          body: z.union([
            z.strictObject({ mfa_token: z.string().max(2048), code: TotpCode }),
            z.strictObject({ mfa_token: z.string().max(2048), recovery_code: z.string().max(64) }),
          ]),
        },
      },
      async (req, reply) => {
        checkOrigin(req, origins);
        const userId = await verifyMfaToken(deps, req.body.mfa_token);
        const now = deps.clock();
        const ok = await withSystem(deps.db, async (tx) => {
          const [u] = await tx.select().from(merchantUsers).where(eq(merchantUsers.id, userId)).for('update');
          if (!u?.totpSecretEnc || u.removedAt || isLocked(u.lockedUntil, now)) return false;
          let method: 'totp' | 'recovery_code' | null = null;
          if ('code' in req.body) {
            const secret = await deps.envelope.open(u.totpSecretEnc, totpAad(u.id));
            const step = verifyTotp(secret, req.body.code, now, u.totpLastStep);
            if (step !== null) {
              method = 'totp';
              await tx.update(merchantUsers).set({ totpLastStep: step }).where(eq(merchantUsers.id, u.id));
            }
          } else {
            const used = await tx
              .update(recoveryCodes)
              .set({ usedAt: new Date(now) })
              .where(and(eq(recoveryCodes.userId, u.id), eq(recoveryCodes.codeHash, sha256Hex(normalizeRecovery(req.body.recovery_code))), isNull(recoveryCodes.usedAt)))
              .returning({ id: recoveryCodes.id });
            if (used.length === 1) method = 'recovery_code';
          }
          if (!method) {
            const failed = u.failedLogins + 1;
            await tx.update(merchantUsers).set({ failedLogins: failed, lockedUntil: lockoutUntil(failed, now) }).where(eq(merchantUsers.id, u.id));
            await audit(tx, { actorType: 'anonymous', merchantId: u.merchantId, action: 'auth.mfa_failed', targetType: 'merchant_user', targetId: u.id, after: { failed } }, req);
            return false;
          }
          await tx.update(merchantUsers).set({ failedLogins: 0, lockedUntil: null }).where(eq(merchantUsers.id, u.id));
          await issueSession(deps, tx, req, reply, u, true);
          const newDevice = await rememberDevice(deps, tx, req, reply, u, { notify: true });
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.login', after: { mfa: true, method, new_device: newDevice } }, req);
          return true;
        });
        if (!ok) throw INVALID();
        return { mfa_required: false as const };
      },
    );

    app.post('/refresh', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
      checkCsrf(req, COOKIE.csrf, origins);
      await rotateSession(deps, req, reply);
      return reply.status(204).send();
    });

    app.post('/logout', async (req, reply) => {
      checkCsrf(req, COOKIE.csrf, origins);
      await revokeSessionFamily(deps, req);
      clearSessionCookies(deps, reply);
      return reply.status(204).send();
    });

    app.get('/me', { preHandler: requireUser(deps) }, async (req) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const u = await tx.query.merchantUsers.findFirst({ where: (t, { eq: e }) => e(t.id, user.id) });
        const m = await tx.query.merchants.findFirst({ where: (t, { eq: e }) => e(t.id, user.merchantId) });
        if (!u || !m) throw new AppError('unauthorized', 'authentication required');
        return {
          user: { id: u.id, email: u.email, email_verified: u.emailVerifiedAt !== null, role: u.role, totp_enabled: u.totpEnabledAt !== null, session_mfa: user.mfa },
          merchant: { id: m.id, name: m.name, status: m.status, custody_mode: m.custodyMode },
          // Where the hosted checkout and widget.js live (snippets in the dashboard).
          api_origin: deps.config.PUBLIC_BASE_URL,
        };
      });
    });

    app.post('/2fa/setup', { preHandler: requireUser(deps) }, async (req) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const [u] = await tx.select().from(merchantUsers).where(eq(merchantUsers.id, user.id)).for('update');
        if (!u) throw new AppError('unauthorized', 'authentication required');
        if (u.totpEnabledAt) throw new AppError('conflict', 'two-factor authentication already enabled');
        const secret = generateTotpSecret();
        await tx.update(merchantUsers).set({ totpPendingEnc: await deps.envelope.seal(secret, pendingAad(u.id)) }).where(eq(merchantUsers.id, u.id));
        await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.2fa_setup_started' }, req);
        const uri = totpUri(secret, u.email, 'Gateway');
        return { secret, otpauth_uri: uri, qr_svg: await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }) };
      });
    });

    app.post('/2fa/enable', { preHandler: requireUser(deps), schema: { body: z.strictObject({ code: TotpCode }) } }, async (req) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      const result = await withTenant(deps.db, user.merchantId, async (tx) => {
        const [u] = await tx.select().from(merchantUsers).where(eq(merchantUsers.id, user.id)).for('update');
        if (!u) throw new AppError('unauthorized', 'authentication required');
        if (u.totpEnabledAt) throw new AppError('conflict', 'two-factor authentication already enabled');
        if (!u.totpPendingEnc) throw new AppError('conflict', 'call /2fa/setup first');
        const secret = await deps.envelope.open(u.totpPendingEnc, pendingAad(u.id));
        const step = verifyTotp(secret, req.body.code, deps.clock(), null);
        if (step === null) return null;
        await tx
          .update(merchantUsers)
          .set({ totpSecretEnc: await deps.envelope.seal(secret, totpAad(u.id)), totpPendingEnc: null, totpEnabledAt: new Date(deps.clock()), totpLastStep: step })
          .where(eq(merchantUsers.id, u.id));
        const codes = newRecoveryCodes();
        await tx.insert(recoveryCodes).values(codes.map((c) => ({ id: uuidv7(), merchantId: u.merchantId, userId: u.id, codeHash: sha256Hex(normalizeRecovery(c)) })));
        await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.2fa_enabled' }, req);
        return { recovery_codes: codes };
      });
      if (!result) throw new AppError('validation_error', 'invalid code');
      return result;
    });

    /** New set of 10 recovery codes (shown once); every earlier code stops working. Needs a fresh TOTP code. */
    app.post('/2fa/recovery-codes', { preHandler: [requireUser(deps), requireTotp(deps)] }, async (req) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      return withTenant(deps.db, user.merchantId, async (tx) => {
        await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
        const codes = newRecoveryCodes();
        await tx.insert(recoveryCodes).values(codes.map((c) => ({ id: uuidv7(), merchantId: user.merchantId, userId: user.id, codeHash: sha256Hex(normalizeRecovery(c)) })));
        await audit(tx, { actorType: 'merchant_user', actorId: user.id, merchantId: user.merchantId, action: 'auth.recovery_codes_regenerated' }, req);
        return { recovery_codes: codes };
      });
    });

    // ---------------------------------------------------------------- email verification and password reset (M10)

    const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
    const INVALID_LINK = () => new AppError('validation_error', 'this link is invalid or has expired', { reason: 'invalid_token' });

    /** The link from the verification email. No session needed: the token is the proof. */
    app.post('/verify-email', { config: { rateLimit: AUTH_RATE_LIMIT }, schema: { body: z.strictObject({ token: Token }) } }, async (req, reply) => {
      checkOrigin(req, origins);
      const now = deps.clock();
      const ok = await withSystem(deps.db, async (tx) => {
        const t = await findEmailToken(tx, 'verify_email', req.body.token, now);
        if (!t) return false;
        await useEmailToken(tx, t, now);
        await tx.update(merchantUsers).set({ emailVerifiedAt: new Date(now) }).where(and(eq(merchantUsers.id, t.userId), isNull(merchantUsers.emailVerifiedAt)));
        await audit(tx, { actorType: 'merchant_user', actorId: t.userId, merchantId: t.merchantId, action: 'auth.email_verified' }, req);
        return true;
      });
      if (!ok) throw INVALID_LINK();
      return reply.status(204).send();
    });

    app.post('/verify-email/resend', { preHandler: requireUser(deps), config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
      const user = req.user;
      if (!user) throw new AppError('unauthorized', 'authentication required');
      await withTenant(deps.db, user.merchantId, async (tx) => {
        const [u] = await tx.select().from(merchantUsers).where(eq(merchantUsers.id, user.id)).for('update');
        if (!u) throw new AppError('unauthorized', 'authentication required');
        if (u.emailVerifiedAt) throw new AppError('conflict', 'email address already verified');
        const last = await lastTokenAt(tx, u.id, 'verify_email');
        if (last !== null && deps.clock() - last < TOKEN_RESEND_MS) throw new AppError('rate_limited', 'a verification email was just sent; wait a minute');
        await sendVerification(deps, tx, u);
      });
      return reply.status(202).send();
    });

    /**
     * Always 202, whether or not the address has an account (no enumeration). A reset email goes out at most once a
     * minute per account.
     */
    app.post('/password/forgot', { config: { rateLimit: AUTH_RATE_LIMIT }, schema: { body: z.strictObject({ email: Email }) } }, async (req, reply) => {
      checkOrigin(req, origins);
      await withSystem(deps.db, async (tx) => {
        const [u] = await tx.select().from(merchantUsers).where(sql`lower(${merchantUsers.email}) = ${req.body.email}`).for('update');
        if (!u || u.removedAt) return;
        const last = await lastTokenAt(tx, u.id, 'password_reset');
        if (last !== null && deps.clock() - last < TOKEN_RESEND_MS) return;
        const token = await issueEmailToken(tx, u, 'password_reset', deps.clock());
        await enqueueEmail(deps, tx, { merchantId: u.merchantId, kind: 'password_reset', to: u.email, ...templates.passwordReset(`${deps.config.DASHBOARD_URL}/#/reset-password?token=${token}`) });
        await audit(tx, { actorType: 'anonymous', merchantId: u.merchantId, action: 'auth.password_reset_requested', targetType: 'merchant_user', targetId: u.id }, req);
      });
      return reply.status(202).send();
    });

    /**
     * Sets a new password from the reset link. With 2FA on, the email alone is not enough: a current authenticator or
     * recovery code is required too. Every session is revoked; the user is told by email.
     */
    app.post(
      '/password/reset',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: {
          body: z.strictObject({ token: Token, password: Password, code: TotpCode.optional(), recovery_code: z.string().max(64).optional() }),
        },
      },
      async (req, reply) => {
        checkOrigin(req, origins);
        const now = deps.clock();
        const passwordHash = await hashPassword(req.body.password);
        // Failure state (2FA attempts) must commit, so the transaction returns a result and throws afterwards.
        const result = await withSystem(deps.db, async (tx) => {
          const t = await findEmailToken(tx, 'password_reset', req.body.token, now);
          if (!t) return 'invalid' as const;
          const [u] = await tx.select().from(merchantUsers).where(eq(merchantUsers.id, t.userId)).for('update');
          // A link sent before the user was removed from the team does not let them back in.
          if (!u || u.removedAt) return 'invalid' as const;
          if (u.totpSecretEnc) {
            if (isLocked(u.lockedUntil, now)) return 'mfa' as const;
            let ok = false;
            if (req.body.code) {
              const step = verifyTotp(await deps.envelope.open(u.totpSecretEnc, totpAad(u.id)), req.body.code, now, u.totpLastStep);
              if (step !== null) {
                ok = true;
                await tx.update(merchantUsers).set({ totpLastStep: step }).where(eq(merchantUsers.id, u.id));
              }
            } else if (req.body.recovery_code) {
              const used = await tx
                .update(recoveryCodes)
                .set({ usedAt: new Date(now) })
                .where(and(eq(recoveryCodes.userId, u.id), eq(recoveryCodes.codeHash, sha256Hex(normalizeRecovery(req.body.recovery_code))), isNull(recoveryCodes.usedAt)))
                .returning({ id: recoveryCodes.id });
              ok = used.length === 1;
            }
            if (!ok) {
              const failed = u.failedLogins + 1;
              await tx.update(merchantUsers).set({ failedLogins: failed, lockedUntil: lockoutUntil(failed, now) }).where(eq(merchantUsers.id, u.id));
              await audit(tx, { actorType: 'anonymous', merchantId: u.merchantId, action: 'auth.mfa_failed', targetType: 'merchant_user', targetId: u.id, after: { failed, flow: 'password_reset' } }, req);
              return 'mfa' as const;
            }
          }
          await useEmailToken(tx, t, now);
          // Proving control of the inbox also verifies the address.
          await tx
            .update(merchantUsers)
            .set({ passwordHash, failedLogins: 0, lockedUntil: null, emailVerifiedAt: u.emailVerifiedAt ?? new Date(now) })
            .where(eq(merchantUsers.id, u.id));
          await tx.update(sessions).set({ revokedAt: new Date(now) }).where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.password_reset', after: { mfa: u.totpSecretEnc !== null } }, req);
          await enqueueEmail(deps, tx, { merchantId: u.merchantId, kind: 'password_changed', to: u.email, ...templates.passwordChanged() });
          return 'ok' as const;
        });
        if (result === 'invalid') throw INVALID_LINK();
        if (result === 'mfa') throw new AppError('unauthorized', 'a valid authenticator or recovery code is required', { reason: 'mfa_required' });
        return reply.status(204).send();
      },
    );
  };
}
