import type { MerchantRole } from '@gw/core';
import { AppError, uuidv7 } from '@gw/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { audit } from '../../common/audit.js';
import { randomBase62, sha256Hex } from '../../common/crypto/random.js';
import { withSystem, type Tx } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { sessions } from '../../db/schema.js';

export const ACCESS_TTL_S = 600;
const REFRESH_TTL_MS = 14 * 24 * 3600_000;
const FAMILY_TTL_MS = 30 * 24 * 3600_000;
const MFA_TOKEN_TTL_S = 300;

export const COOKIE = { access: 'gw_at', refresh: 'gw_rt', csrf: 'gw_csrf' } as const;
const REFRESH_PATH = '/v1/dashboard/auth';
const ISSUER = 'gateway';

export interface UserClaims {
  sub: string;
  mid: string;
  role: MerchantRole;
  mfa: boolean;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signToken(secret: string, audience: string, ttlS: number, claims: Record<string, unknown>, sub: string) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlS}s`)
    .sign(key(secret));
}

export async function verifyToken(secret: string, audience: string, token: string) {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: ISSUER, audience, algorithms: ['HS256'] });
    return payload;
  } catch {
    throw new AppError('unauthorized', 'authentication required');
  }
}

export const signMfaToken = (deps: Deps, userId: string) => signToken(deps.config.JWT_SECRET, 'mfa', MFA_TOKEN_TTL_S, {}, userId);

export async function verifyMfaToken(deps: Deps, token: string): Promise<string> {
  const p = await verifyToken(deps.config.JWT_SECRET, 'mfa', token);
  if (!p.sub) throw new AppError('unauthorized', 'authentication required');
  return p.sub;
}

export function cookieBase(deps: Deps) {
  return { httpOnly: true, sameSite: 'strict' as const, secure: deps.config.NODE_ENV === 'production' };
}

interface SessionUser {
  id: string;
  merchantId: string;
  role: MerchantRole;
}

/** Creates a refresh-token row (new family unless given) and sets access, refresh and CSRF cookies. */
export async function issueSession(
  deps: Deps,
  tx: Tx,
  req: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
  mfa: boolean,
  family?: { id: string; expiresAt: Date },
): Promise<string> {
  const refresh = randomBase62(48);
  const sessionId = uuidv7();
  const now = deps.clock();
  const familyExpiresAt = family?.expiresAt ?? new Date(now + FAMILY_TTL_MS);
  const expiresAt = new Date(Math.min(now + REFRESH_TTL_MS, familyExpiresAt.getTime()));
  await tx.insert(sessions).values({
    id: sessionId,
    merchantId: user.merchantId,
    userId: user.id,
    familyId: family?.id ?? uuidv7(),
    tokenHash: sha256Hex(refresh),
    mfa,
    expiresAt,
    familyExpiresAt,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 512) ?? null,
  });
  const access = await signToken(
    deps.config.JWT_SECRET,
    'dashboard',
    ACCESS_TTL_S,
    { mid: user.merchantId, role: user.role, mfa },
    user.id,
  );
  const base = cookieBase(deps);
  reply.setCookie(COOKIE.access, access, { ...base, path: '/', maxAge: ACCESS_TTL_S });
  reply.setCookie(COOKIE.refresh, refresh, { ...base, path: REFRESH_PATH, expires: expiresAt });
  reply.setCookie(COOKIE.csrf, randomBase62(32), { ...base, httpOnly: false, path: '/' });
  return sessionId;
}

export function clearSessionCookies(deps: Deps, reply: FastifyReply): void {
  const base = cookieBase(deps);
  reply.clearCookie(COOKIE.access, { ...base, path: '/' });
  reply.clearCookie(COOKIE.refresh, { ...base, path: REFRESH_PATH });
  reply.clearCookie(COOKIE.csrf, { ...base, httpOnly: false, path: '/' });
}

/**
 * Refresh-token rotation with reuse detection. Presenting an already-rotated or revoked token revokes
 * the whole family (stolen-token signal) and is audited.
 */
export async function rotateSession(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[COOKIE.refresh];
  if (!token) throw new AppError('unauthorized', 'authentication required');
  const reused = await withSystem(deps.db, async (tx) => {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256Hex(token)))
      .for('update');
    if (!row) throw new AppError('unauthorized', 'authentication required');
    const now = new Date(deps.clock());
    if (row.revokedAt || row.replacedBy) {
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
      await audit(
        tx,
        { actorType: 'merchant_user', actorId: row.userId, merchantId: row.merchantId, action: 'auth.refresh_reuse_detected', targetType: 'session_family', targetId: row.familyId },
        req,
      );
      return true;
    }
    if (row.expiresAt <= now) throw new AppError('unauthorized', 'authentication required');
    const user = await tx.query.merchantUsers.findFirst({ where: (u, { eq: e }) => e(u.id, row.userId) });
    if (!user) throw new AppError('unauthorized', 'authentication required');
    const newId = await issueSession(deps, tx, req, reply, user, row.mfa, { id: row.familyId, expiresAt: row.familyExpiresAt });
    await tx.update(sessions).set({ replacedBy: newId }).where(eq(sessions.id, row.id));
    return false;
  });
  if (reused) {
    clearSessionCookies(deps, reply);
    throw new AppError('unauthorized', 'authentication required');
  }
}

export async function revokeSessionFamily(deps: Deps, req: FastifyRequest): Promise<void> {
  const token = req.cookies[COOKIE.refresh];
  if (!token) return;
  await withSystem(deps.db, async (tx) => {
    const [row] = await tx.select().from(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
    if (!row) return;
    await tx
      .update(sessions)
      .set({ revokedAt: new Date(deps.clock()) })
      .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
    await audit(tx, { actorType: 'merchant_user', actorId: row.userId, merchantId: row.merchantId, action: 'auth.logout' }, req);
  });
}
