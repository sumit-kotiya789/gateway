// Admin accounts (M9, D-086), under /admin/v1/admins: superadmins only (`admins:manage`). Creating, re-enabling, role
// changes and credential resets need step-up TOTP; disabling does not (it only removes access). Nobody manages their
// own account here, and an active superadmin always remains (API check + deferred DB trigger). Generated passwords
// and TOTP enrolment URIs are returned once and never stored in clear.
import { randomBytes } from 'node:crypto';
import { ADMIN_ROLES, AppError, uuidv7 } from '@gw/core';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { hashPassword } from '../../common/crypto/password.js';
import { generateTotpSecret, totpUri } from '../../common/crypto/totp.js';
import { withSystem, type Tx } from '../../common/db.js';
import { adminUsers } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { adminTotpAad, requireAdmin, requireAdminTotp } from '../auth/guards.js';

const Reason = z.string().trim().min(3).max(500);
const IdParams = z.strictObject({ id: z.uuid() });

type AdminRow = typeof adminUsers.$inferSelect;
const view = (a: AdminRow) => ({
  id: a.id,
  email: a.email,
  role: a.role,
  disabled: a.disabledAt !== null,
  disabled_at: a.disabledAt?.toISOString() ?? null,
  locked_until: a.lockedUntil?.toISOString() ?? null,
  created_at: a.createdAt.toISOString(),
});

/** New credentials: shown once to the superadmin, who hands them over out of band. */
async function credentials(deps: Deps, id: string, email: string) {
  const password = randomBytes(18).toString('base64url');
  const secret = generateTotpSecret();
  const uri = totpUri(secret, email, 'Gateway Admin');
  return {
    stored: { passwordHash: await hashPassword(password), totpSecretEnc: await deps.envelope.seal(secret, adminTotpAad(id)), totpLastStep: null },
    shown: { password, totp_uri: uri, qr_svg: await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }) },
  };
}

function actorId(req: FastifyRequest): string {
  /* v8 ignore next -- requireAdmin runs first on every route */
  if (!req.admin) throw new AppError('unauthorized', 'authentication required');
  return req.admin.id;
}

/** Locks the target (never the caller) for a change. */
async function lockedTarget(tx: Tx, req: FastifyRequest, id: string): Promise<AdminRow> {
  if (id === actorId(req)) throw new AppError('forbidden', 'you cannot change your own admin account here');
  const [a] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).for('update');
  if (!a) throw new AppError('not_found', 'admin not found');
  return a;
}

/** Refuses a change that would leave no active superadmin besides `target` (the DB trigger is the backstop). */
async function keepSuperadmin(tx: Tx, target: AdminRow): Promise<void> {
  if (target.role !== 'superadmin' || target.disabledAt) return;
  const others = await tx
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, 'superadmin'), isNull(adminUsers.disabledAt), ne(adminUsers.id, target.id)))
    .for('update');
  if (others.length === 0) throw new AppError('conflict', 'at least one active superadmin must remain');
}

export function adminUserRoutes(deps: Deps): FastifyPluginAsyncZod {
  const manage = requireAdmin(deps, 'admins:manage');
  const stepUp = [manage, requireAdminTotp(deps)];
  const record = (tx: Tx, req: FastifyRequest, action: string, target: string, before: Record<string, unknown> | undefined, after: Record<string, unknown>) =>
    audit(tx, { actorType: 'admin', actorId: actorId(req), action, targetType: 'admin_user', targetId: target, before, after }, req);

  return async (app) => {
    app.get('/', { preHandler: manage }, async () => {
      const rows = await withSystem(deps.db, (tx) => tx.select().from(adminUsers).orderBy(asc(adminUsers.createdAt)));
      return { data: rows.map(view) };
    });

    app.post(
      '/',
      {
        preHandler: stepUp,
        schema: { body: z.strictObject({ email: z.email().max(254).transform((s) => s.toLowerCase()), role: z.enum(ADMIN_ROLES), reason: Reason }) },
      },
      async (req, reply) => {
        const id = uuidv7();
        const creds = await credentials(deps, id, req.body.email);
        const out = await withSystem(deps.db, async (tx) => {
          const [exists] = await tx.select({ id: adminUsers.id }).from(adminUsers).where(sql`lower(${adminUsers.email}) = ${req.body.email}`);
          if (exists) throw new AppError('conflict', 'an admin with this email already exists');
          const [a] = await tx.insert(adminUsers).values({ id, email: req.body.email, role: req.body.role, ...creds.stored }).returning();
          /* v8 ignore next -- INSERT ... RETURNING yields the row or throws */
          if (!a) throw new Error('admin insert failed');
          await record(tx, req, 'admin.created', id, undefined, { email: a.email, role: a.role, reason: req.body.reason });
          return { ...view(a), ...creds.shown };
        });
        return reply.status(201).send(out);
      },
    );

    app.put(
      '/:id/role',
      { preHandler: stepUp, schema: { params: IdParams, body: z.strictObject({ role: z.enum(ADMIN_ROLES), reason: Reason }) } },
      async (req) =>
        withSystem(deps.db, async (tx) => {
          const a = await lockedTarget(tx, req, req.params.id);
          if (a.role === req.body.role) throw new AppError('conflict', `admin is already ${a.role}`);
          await keepSuperadmin(tx, a);
          const [next] = await tx.update(adminUsers).set({ role: req.body.role }).where(eq(adminUsers.id, a.id)).returning();
          /* v8 ignore next -- row locked above */
          if (!next) throw new Error('admin update failed');
          // The role in an issued admin token stops working at once: requireAdmin compares it with the DB.
          await record(tx, req, 'admin.role_changed', a.id, { role: a.role }, { role: next.role, reason: req.body.reason });
          return view(next);
        }),
    );

    app.post('/:id/disable', { preHandler: manage, schema: { params: IdParams, body: z.strictObject({ reason: Reason }) } }, async (req) =>
      withSystem(deps.db, async (tx) => {
        const a = await lockedTarget(tx, req, req.params.id);
        if (a.disabledAt) throw new AppError('conflict', 'admin is already disabled');
        await keepSuperadmin(tx, a);
        const [next] = await tx.update(adminUsers).set({ disabledAt: new Date(deps.clock()) }).where(eq(adminUsers.id, a.id)).returning();
        /* v8 ignore next -- row locked above */
        if (!next) throw new Error('admin update failed');
        await record(tx, req, 'admin.disabled', a.id, { disabled: false }, { disabled: true, reason: req.body.reason });
        return view(next);
      }),
    );

    app.post('/:id/enable', { preHandler: stepUp, schema: { params: IdParams, body: z.strictObject({ reason: Reason }) } }, async (req) =>
      withSystem(deps.db, async (tx) => {
        const a = await lockedTarget(tx, req, req.params.id);
        if (!a.disabledAt) throw new AppError('conflict', 'admin is not disabled');
        const [next] = await tx.update(adminUsers).set({ disabledAt: null, failedLogins: 0, lockedUntil: null }).where(eq(adminUsers.id, a.id)).returning();
        /* v8 ignore next -- row locked above */
        if (!next) throw new Error('admin update failed');
        await record(tx, req, 'admin.enabled', a.id, { disabled: true }, { disabled: false, reason: req.body.reason });
        return view(next);
      }),
    );

    /**
     * Lost or leaked password or authenticator: a new password and TOTP secret (shown once); the old ones and every
     * admin session issued so far stop working.
     */
    app.post('/:id/reset-credentials', { preHandler: stepUp, schema: { params: IdParams, body: z.strictObject({ reason: Reason }) } }, async (req) =>
      withSystem(deps.db, async (tx) => {
        const a = await lockedTarget(tx, req, req.params.id);
        const creds = await credentials(deps, a.id, a.email);
        const [next] = await tx.update(adminUsers).set({ ...creds.stored, failedLogins: 0, lockedUntil: null, sessionEpoch: a.sessionEpoch + 1 }).where(eq(adminUsers.id, a.id)).returning();
        /* v8 ignore next -- row locked above */
        if (!next) throw new Error('admin update failed');
        await record(tx, req, 'admin.credentials_reset', a.id, undefined, { reason: req.body.reason });
        return { ...view(next), ...creds.shown };
      }),
    );
  };
}
