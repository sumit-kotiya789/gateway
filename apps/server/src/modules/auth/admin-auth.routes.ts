// Admin auth domain: separate table, JWT secret, audience, cookies and origin. Password AND TOTP required; only a
// development config (ADMIN_LOGIN_TOTP_DISABLED, refused in production) lets login skip the TOTP code. Sessions slide
// within the idle and absolute limits from the console settings (D-106; see setAdminSession).
import { AppError } from '@gw/core';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { PASSWORD_MAX, burnPasswordCheck, verifyPassword } from '../../common/crypto/password.js';
import { randomBase62 } from '../../common/crypto/random.js';
import { verifyTotp } from '../../common/crypto/totp.js';
import { withSystem } from '../../common/db.js';
import { adminUsers } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { AUTH_RATE_LIMIT } from './dashboard-auth.routes.js';
import { loadAdminSettings } from '../admin/settings.js';
import { adminTotpAad, checkOrigin, clearAdminSession, requireAdmin, setAdminSession } from './guards.js';
import { isLocked, lockoutUntil } from './lockout.js';

const TotpCode = z.string().regex(/^\d{6}$/);

export function adminAuthRoutes(deps: Deps): FastifyPluginAsyncZod {
  const totpRequired = !deps.config.ADMIN_LOGIN_TOTP_DISABLED;
  return async (app) => {
    // Public: tells the console whether to ask for a TOTP code at login.
    app.get('/options', () => ({ totp_required: totpRequired }));

    app.post(
      '/login',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: {
          body: z.strictObject({
            email: z.email().max(254).transform((s) => s.toLowerCase()),
            password: z.string().max(PASSWORD_MAX),
            code: totpRequired ? TotpCode : TotpCode.optional(),
          }),
        },
      },
      async (req, reply) => {
        checkOrigin(req, deps.config.ADMIN_ORIGINS);
        const now = deps.clock();
        const signedIn = await withSystem(deps.db, async (tx) => {
          const [a] = await tx.select().from(adminUsers).where(sql`lower(${adminUsers.email}) = ${req.body.email}`).for('update');
          if (!a || a.disabledAt || isLocked(a.lockedUntil, now)) return burnPasswordCheck(req.body.password);
          const pwOk = await verifyPassword(a.passwordHash, req.body.password);
          let step = a.totpLastStep;
          if (totpRequired) {
            const secret = await deps.envelope.open(a.totpSecretEnc, adminTotpAad(a.id));
            step = verifyTotp(secret, req.body.code ?? '', now, a.totpLastStep);
          }
          if (!pwOk || (totpRequired && step === null)) {
            const failed = a.failedLogins + 1;
            await tx.update(adminUsers).set({ failedLogins: failed, lockedUntil: lockoutUntil(failed, now) }).where(eq(adminUsers.id, a.id));
            await audit(tx, { actorType: 'anonymous', action: 'admin.login_failed', targetType: 'admin_user', targetId: a.id, after: { failed } }, req);
            return false;
          }
          await tx.update(adminUsers).set({ failedLogins: 0, lockedUntil: null, totpLastStep: step }).where(eq(adminUsers.id, a.id));
          await audit(tx, { actorType: 'admin', actorId: a.id, action: 'admin.login', ...(totpRequired ? {} : { after: { mfa: 'skipped' } }) }, req);
          return { admin: a, settings: await loadAdminSettings(tx) };
        });
        if (!signedIn) throw new AppError('unauthorized', 'invalid credentials');
        const { admin, settings } = signedIn;
        // Sliding session (D-106): renewed by every request, signed out when idle or at the absolute limit.
        const csrf = randomBase62(32);
        await setAdminSession(deps, reply, { id: admin.id, role: admin.role, epoch: admin.sessionEpoch }, Math.floor(Date.now() / 1000), settings, csrf);
        return { admin: { id: admin.id, email: admin.email, role: admin.role }, csrf_token: csrf };
      },
    );

    app.post('/logout', { preHandler: requireAdmin(deps, 'admin:read') }, async (req, reply) => {
      const admin = req.admin;
      if (admin) await withSystem(deps.db, (tx) => audit(tx, { actorType: 'admin', actorId: admin.id, action: 'admin.logout' }, req));
      clearAdminSession(deps, reply);
      return reply.status(204).send();
    });

    app.get('/me', { preHandler: requireAdmin(deps, 'admin:read') }, async (req) => req.admin);
  };
}
