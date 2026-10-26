// Team management (M10, D-078): invite by email, change roles, remove members. Owners can grant any role; admins can
// manage developers, finance and read-only members only. Adding or changing access needs step-up TOTP. Every merchant
// keeps an active owner (DB constraint trigger merchant_users_keep_owner).
import { randomBytes } from 'node:crypto';
import { AppError, MERCHANT_ROLES, type MerchantRole } from '@gw/core';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { PASSWORD_MAX, PASSWORD_MIN, hashPassword } from '../../common/crypto/password.js';
import { sha256Hex } from '../../common/crypto/random.js';
import { withSystem, withTenant, type Tx } from '../../common/db.js';
import { merchantUsers, merchants, sessions, teamInvites } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { AUTH_RATE_LIMIT } from '../auth/dashboard-auth.routes.js';
import { authedUser, checkOrigin, requirePermission, requireTotp, requireUser, type AuthedUser } from '../auth/guards.js';
import { issueSession } from '../auth/session.js';
import { enqueueEmail } from '../email/outbox.js';
import { templates } from '../email/templates.js';

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
const Email = z.email().max(254).transform((s) => s.toLowerCase());
const Role = z.enum(MERCHANT_ROLES);
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const IdParams = z.strictObject({ id: z.uuid() });

/** Roles an actor may grant, change or remove: owners any, admins only the non-privileged ones. */
function canManageRole(actor: MerchantRole, role: MerchantRole): boolean {
  return actor === 'owner' || (actor === 'admin' && role !== 'owner' && role !== 'admin');
}

type UserRow = typeof merchantUsers.$inferSelect;
type InviteRow = typeof teamInvites.$inferSelect;

const memberView = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  totp_enabled: u.totpEnabledAt !== null,
  email_verified: u.emailVerifiedAt !== null,
  created_at: u.createdAt.toISOString(),
});
const inviteView = (i: InviteRow) => ({ id: i.id, email: i.email, role: i.role, expires_at: i.expiresAt.toISOString(), created_at: i.createdAt.toISOString() });

async function revokeSessions(tx: Tx, userId: string, now: number): Promise<void> {
  await tx.update(sessions).set({ revokedAt: new Date(now) }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** A member of the actor's merchant the actor may manage (not themselves, role within reach), row-locked. */
async function managedMember(tx: Tx, actor: AuthedUser, id: string): Promise<UserRow> {
  const [u] = await tx
    .select()
    .from(merchantUsers)
    .where(and(eq(merchantUsers.id, id), eq(merchantUsers.merchantId, actor.merchantId), isNull(merchantUsers.removedAt)))
    .for('update');
  if (!u) throw new AppError('not_found', 'member not found');
  if (u.id === actor.id) throw new AppError('conflict', 'you cannot change your own membership');
  if (!canManageRole(actor.role, u.role)) throw new AppError('forbidden', `only an owner can manage ${u.role} members`);
  return u;
}

/** Fails when this would leave the merchant without an active owner (the DB trigger is the backstop). */
async function assertAnotherOwner(tx: Tx, merchantId: string, leaving: UserRow): Promise<void> {
  if (leaving.role !== 'owner') return;
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(merchantUsers)
    .where(and(eq(merchantUsers.merchantId, merchantId), eq(merchantUsers.role, 'owner'), isNull(merchantUsers.removedAt)));
  if ((r?.n ?? 0) <= 1) throw new AppError('conflict', 'the merchant must keep at least one owner');
}

export function teamDashboardRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', requireUser(deps));

    app.get('/', { preHandler: requirePermission('account:read') }, async (req) => {
      const user = authedUser(req);
      return withTenant(deps.db, user.merchantId, async (tx) => {
        const members = await tx
          .select()
          .from(merchantUsers)
          .where(and(eq(merchantUsers.merchantId, user.merchantId), isNull(merchantUsers.removedAt)))
          .orderBy(asc(merchantUsers.createdAt));
        const invites = await tx
          .select()
          .from(teamInvites)
          .where(
            and(
              eq(teamInvites.merchantId, user.merchantId),
              isNull(teamInvites.acceptedAt),
              isNull(teamInvites.revokedAt),
              gt(teamInvites.expiresAt, new Date(deps.clock())),
            ),
          )
          .orderBy(asc(teamInvites.createdAt));
        return { members: members.map(memberView), invites: invites.map(inviteView) };
      });
    });

    app.post(
      '/invites',
      { preHandler: [requirePermission('team:manage'), requireTotp(deps)], schema: { body: z.strictObject({ email: Email, role: Role }) } },
      async (req, reply) => {
        const actor = authedUser(req);
        const { email, role } = req.body;
        if (!canManageRole(actor.role, role)) throw new AppError('forbidden', `only an owner can invite ${role} members`);
        // System context: email addresses are unique across all merchants, so the check must see every tenant.
        const invite = await withSystem(deps.db, async (tx) => {
          const [existing] = await tx.select().from(merchantUsers).where(sql`lower(${merchantUsers.email}) = ${email}`);
          if (existing && (existing.removedAt === null || existing.merchantId !== actor.merchantId)) {
            throw new AppError('conflict', 'this email address already has an account');
          }
          const [m] = await tx.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, actor.merchantId));
          /* v8 ignore next -- invariant: the session's merchant exists */
          if (!m) throw new AppError('not_found', 'merchant not found');
          const token = randomBytes(32).toString('base64url');
          const now = deps.clock();
          // An open invite for the same address fails on team_invites_open_uq (409).
          const [i] = await tx
            .insert(teamInvites)
            .values({ merchantId: actor.merchantId, email, role, tokenHash: sha256Hex(token), invitedBy: actor.id, expiresAt: new Date(now + INVITE_TTL_MS) })
            .returning();
          /* v8 ignore next -- invariant: INSERT ... RETURNING yields the row or throws */
          if (!i) throw new Error('invite insert failed');
          await enqueueEmail(deps, tx, {
            merchantId: actor.merchantId,
            kind: 'team_invite',
            to: email,
            ...templates.teamInvite({ merchantName: m.name, role, url: `${deps.config.DASHBOARD_URL}/#/accept-invite?token=${token}` }),
          });
          await audit(tx, { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'team.invited', targetType: 'team_invite', targetId: i.id, after: { email, role } }, req);
          return i;
        });
        return reply.status(201).send(inviteView(invite));
      },
    );

    app.delete('/invites/:id', { preHandler: requirePermission('team:manage'), schema: { params: IdParams } }, async (req, reply) => {
      const actor = authedUser(req);
      await withTenant(deps.db, actor.merchantId, async (tx) => {
        const [i] = await tx
          .select()
          .from(teamInvites)
          .where(and(eq(teamInvites.id, req.params.id), eq(teamInvites.merchantId, actor.merchantId)))
          .for('update');
        if (!i || i.acceptedAt || i.revokedAt) throw new AppError('not_found', 'open invite not found');
        if (!canManageRole(actor.role, i.role)) throw new AppError('forbidden', `only an owner can revoke ${i.role} invites`);
        await tx.update(teamInvites).set({ revokedAt: new Date(deps.clock()) }).where(eq(teamInvites.id, i.id));
        await audit(tx, { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'team.invite_revoked', targetType: 'team_invite', targetId: i.id }, req);
      });
      return reply.status(204).send();
    });

    /** Role change. The member is signed out so the new role applies at their next sign-in. */
    app.post(
      '/members/:id/role',
      { preHandler: [requirePermission('team:manage'), requireTotp(deps)], schema: { params: IdParams, body: z.strictObject({ role: Role }) } },
      async (req) => {
        const actor = authedUser(req);
        const role = req.body.role;
        if (!canManageRole(actor.role, role)) throw new AppError('forbidden', `only an owner can grant the ${role} role`);
        return withTenant(deps.db, actor.merchantId, async (tx) => {
          const u = await managedMember(tx, actor, req.params.id);
          if (u.role === role) throw new AppError('conflict', `member is already ${role}`);
          await assertAnotherOwner(tx, actor.merchantId, u);
          const [next] = await tx.update(merchantUsers).set({ role }).where(eq(merchantUsers.id, u.id)).returning();
          /* v8 ignore next -- row locked above */
          if (!next) throw new Error('member update failed');
          await revokeSessions(tx, u.id, deps.clock());
          await audit(tx, { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'team.role_changed', targetType: 'merchant_user', targetId: u.id, before: { role: u.role }, after: { role } }, req);
          return memberView(next);
        });
      },
    );

    /** Removal: signed out everywhere, cannot sign in again. Their API keys stay (keys belong to the merchant). */
    app.delete('/members/:id', { preHandler: [requirePermission('team:manage'), requireTotp(deps)], schema: { params: IdParams } }, async (req, reply) => {
      const actor = authedUser(req);
      await withTenant(deps.db, actor.merchantId, async (tx) => {
        const u = await managedMember(tx, actor, req.params.id);
        await assertAnotherOwner(tx, actor.merchantId, u);
        const now = deps.clock();
        await tx.update(merchantUsers).set({ removedAt: new Date(now) }).where(eq(merchantUsers.id, u.id));
        await revokeSessions(tx, u.id, now);
        const [m] = await tx.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, actor.merchantId));
        await enqueueEmail(deps, tx, { merchantId: actor.merchantId, kind: 'team_removed', to: u.email, ...templates.memberRemoved({ merchantName: m?.name ?? '' }) });
        await audit(tx, { actorType: 'merchant_user', actorId: actor.id, merchantId: actor.merchantId, action: 'team.member_removed', targetType: 'merchant_user', targetId: u.id, before: { role: u.role } }, req);
      });
      return reply.status(204).send();
    });
  };
}

/** Public invite endpoints (the token is the credential), mounted under /v1/dashboard/auth/invite. */
export function inviteAuthRoutes(deps: Deps): FastifyPluginAsyncZod {
  const origins = deps.config.DASHBOARD_ORIGINS;

  /** The open, unexpired invite for `token` (row-locked), or a 400. */
  async function openInvite(tx: Tx, token: string): Promise<InviteRow> {
    const [i] = await tx.select().from(teamInvites).where(eq(teamInvites.tokenHash, sha256Hex(token))).for('update');
    if (!i || i.acceptedAt || i.revokedAt || i.expiresAt.getTime() <= deps.clock()) {
      throw new AppError('validation_error', 'this invitation is invalid or has expired', { reason: 'invalid_token' });
    }
    return i;
  }

  return async (app) => {
    app.post('/preview', { config: { rateLimit: AUTH_RATE_LIMIT }, schema: { body: z.strictObject({ token: Token }) } }, async (req) => {
      checkOrigin(req, origins);
      return withSystem(deps.db, async (tx) => {
        const i = await openInvite(tx, req.body.token);
        const [m] = await tx.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, i.merchantId));
        return { merchant_name: m?.name ?? '', email: i.email, role: i.role, expires_at: i.expiresAt.toISOString() };
      });
    });

    /**
     * Accepting sets the password and signs the new member in. The address is verified (the link proved the inbox). A
     * member removed earlier from the same merchant is reactivated with the invited role.
     */
    app.post(
      '/accept',
      { config: { rateLimit: AUTH_RATE_LIMIT }, schema: { body: z.strictObject({ token: Token, password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) }) } },
      async (req, reply) => {
        checkOrigin(req, origins);
        const passwordHash = await hashPassword(req.body.password);
        const out = await withSystem(deps.db, async (tx) => {
          const i = await openInvite(tx, req.body.token);
          const now = new Date(deps.clock());
          const [existing] = await tx.select().from(merchantUsers).where(sql`lower(${merchantUsers.email}) = ${i.email}`).for('update');
          if (existing && (existing.removedAt === null || existing.merchantId !== i.merchantId)) {
            throw new AppError('conflict', 'this email address already has an account');
          }
          const fields = { role: i.role, passwordHash, emailVerifiedAt: now, failedLogins: 0, lockedUntil: null, removedAt: null };
          const [u] = existing
            ? await tx.update(merchantUsers).set(fields).where(eq(merchantUsers.id, existing.id)).returning()
            : await tx.insert(merchantUsers).values({ merchantId: i.merchantId, email: i.email, ...fields }).returning();
          /* v8 ignore next -- invariant: INSERT/UPDATE ... RETURNING yields the row or throws */
          if (!u) throw new Error('member upsert failed');
          await tx.update(teamInvites).set({ acceptedAt: now }).where(eq(teamInvites.id, i.id));
          await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: i.merchantId, action: 'team.invite_accepted', targetType: 'team_invite', targetId: i.id, after: { role: i.role, reactivated: Boolean(existing) } }, req);
          await issueSession(deps, tx, req, reply, u, false);
          return { user: { id: u.id, email: u.email, role: u.role } };
        });
        return reply.status(201).send(out);
      },
    );
  };
}
