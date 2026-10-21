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
import { withSystem, withTenant } from '../../common/db.js';
import { merchantUsers, merchants, recoveryCodes } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { checkCsrf, checkOrigin, requireUser } from './guards.js';
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
          await issueSession(deps, tx, req, reply, u, false);
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
          if (!u || isLocked(u.lockedUntil, now)) return burnPasswordCheck(req.body.password);
          if (!(await verifyPassword(u.passwordHash, req.body.password))) {
            const failed = u.failedLogins + 1;
            await tx.update(merchantUsers).set({ failedLogins: failed, lockedUntil: lockoutUntil(failed, now) }).where(eq(merchantUsers.id, u.id));
            await audit(tx, { actorType: 'anonymous', merchantId: u.merchantId, action: 'auth.login_failed', targetType: 'merchant_user', targetId: u.id, after: { failed } }, req);
            return false;
          }
          await tx.update(merchantUsers).set({ failedLogins: 0, lockedUntil: null }).where(eq(merchantUsers.id, u.id));
          if (u.totpEnabledAt) return { mfa_required: true as const, mfa_token: await signMfaToken(deps, u.id) };
          await issueSession(deps, tx, req, reply, u, false);
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.login', after: { mfa: false } }, req);
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
          if (!u?.totpSecretEnc || isLocked(u.lockedUntil, now)) return false;
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
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.login', after: { mfa: true, method } }, req);
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
          user: { id: u.id, email: u.email, role: u.role, totp_enabled: u.totpEnabledAt !== null, session_mfa: user.mfa },
          merchant: { id: m.id, name: m.name, status: m.status, custody_mode: m.custodyMode },
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
  };
}
