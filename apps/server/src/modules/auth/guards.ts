// Request guards. Every protected route declares one of these in preHandler; there is no implicit access.
import { BlockList, isIPv6 } from 'node:net';
import {
  AppError,
  MERCHANT_ROLES,
  adminCan,
  roleCan,
  type AdminPermission,
  type AdminRole,
  type MerchantPermission,
  type MerchantRole,
} from '@gw/core';
import { eq } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { audit } from '../../common/audit.js';
import { safeEqual } from '../../common/crypto/random.js';
import { verifyTotp } from '../../common/crypto/totp.js';
import { withSystem, withTenant } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { adminUsers, merchantUsers } from '../../db/schema.js';
import { COOKIE, verifyToken } from './session.js';

export interface AuthedUser {
  id: string;
  merchantId: string;
  role: MerchantRole;
  mfa: boolean;
}
export interface AuthedAdmin {
  id: string;
  role: AdminRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthedUser | null;
    admin: AuthedAdmin | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Browsers always send Origin on cross-site POSTs; a present Origin must be allowlisted. */
export function checkOrigin(req: FastifyRequest, allowed: readonly string[]): void {
  const origin = req.headers.origin;
  if (origin !== undefined && !allowed.includes(origin)) throw new AppError('forbidden', 'origin not allowed');
}

/** Double-submit CSRF token + Origin allowlist for cookie-authenticated state-changing requests. */
export function checkCsrf(req: FastifyRequest, csrfCookie: string, allowedOrigins: readonly string[]): void {
  if (SAFE_METHODS.has(req.method)) return;
  checkOrigin(req, allowedOrigins);
  const header = req.headers['x-csrf-token'];
  const cookie = req.cookies[csrfCookie];
  if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) {
    throw new AppError('forbidden', 'csrf token missing or invalid');
  }
}

export function requireUser(deps: Deps): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    const token = req.cookies[COOKIE.access];
    if (!token) throw new AppError('unauthorized', 'authentication required');
    const p = await verifyToken(deps.config.JWT_SECRET, 'dashboard', token);
    const role = p.role as MerchantRole;
    if (typeof p.sub !== 'string' || typeof p.mid !== 'string' || !MERCHANT_ROLES.includes(role)) {
      throw new AppError('unauthorized', 'authentication required');
    }
    req.user = { id: p.sub, merchantId: p.mid, role, mfa: p.mfa === true };
    checkCsrf(req, COOKIE.csrf, deps.config.DASHBOARD_ORIGINS);
  };
}

export function requirePermission(permission: MerchantPermission): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user) throw new AppError('unauthorized', 'authentication required');
    if (!roleCan(req.user.role, permission)) throw new AppError('forbidden', `missing permission ${permission}`);
  };
}

/**
 * Step-up: the request must carry a fresh TOTP code in `x-totp-code`. Users without 2FA are refused.
 * The accepted time step is persisted so the same code cannot be replayed.
 */
export function requireTotp(deps: Deps): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    const user = req.user;
    if (!user) throw new AppError('unauthorized', 'authentication required');
    const code = req.headers['x-totp-code'];
    await withTenant(deps.db, user.merchantId, async (tx) => {
      const [u] = await tx.select().from(merchantUsers).where(eq(merchantUsers.id, user.id)).for('update');
      if (!u?.totpSecretEnc) throw new AppError('forbidden', 'two-factor authentication must be enabled');
      const secret = await deps.envelope.open(u.totpSecretEnc, `merchant_users.totp:${u.id}`);
      const step = typeof code === 'string' ? verifyTotp(secret, code, deps.clock(), u.totpLastStep) : null;
      if (step === null) {
        await audit(tx, { actorType: 'merchant_user', actorId: u.id, merchantId: u.merchantId, action: 'auth.step_up_failed' }, req);
        return false;
      }
      await tx.update(merchantUsers).set({ totpLastStep: step }).where(eq(merchantUsers.id, u.id));
      return true;
    }).then((ok) => {
      if (!ok) throw new AppError('forbidden', 'valid x-totp-code header required');
    });
  };
}

export function ipAllowed(ip: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const bl = new BlockList();
  for (const entry of allowlist) {
    const [addr = '', bits] = entry.split('/');
    const type = isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (bits === undefined) bl.addAddress(addr, type);
    else bl.addSubnet(addr, Number(bits), type);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  const candidate = mapped?.[1] ?? ip;
  return bl.check(candidate, isIPv6(candidate) ? 'ipv6' : 'ipv4');
}

export const ADMIN_COOKIE = { access: 'gw_admin_at', csrf: 'gw_admin_csrf' } as const;

export function requireAdminNetwork(deps: Deps): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!ipAllowed(req.ip, deps.config.ADMIN_IP_ALLOWLIST)) throw new AppError('not_found', 'route not found');
  };
}

export function requireAdmin(deps: Deps, permission: AdminPermission): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    const token = req.cookies[ADMIN_COOKIE.access];
    if (!token) throw new AppError('unauthorized', 'authentication required');
    const p = await verifyToken(deps.config.ADMIN_JWT_SECRET, 'admin', token);
    const role = p.role as AdminRole;
    if (typeof p.sub !== 'string' || !['superadmin', 'operator', 'auditor'].includes(role)) {
      throw new AppError('unauthorized', 'authentication required');
    }
    checkCsrf(req, ADMIN_COOKIE.csrf, deps.config.ADMIN_ORIGINS);
    // Admin traffic is low: re-check the account on every request so disabling an admin takes effect immediately.
    const adminId = p.sub;
    const [a] = await withSystem(deps.db, (tx) =>
      tx.select({ role: adminUsers.role, disabledAt: adminUsers.disabledAt }).from(adminUsers).where(eq(adminUsers.id, adminId)),
    );
    if (!a || a.disabledAt || a.role !== role) throw new AppError('unauthorized', 'authentication required');
    req.admin = { id: adminId, role };
    if (!adminCan(role, permission)) throw new AppError('forbidden', `missing permission ${permission}`);
  };
}
