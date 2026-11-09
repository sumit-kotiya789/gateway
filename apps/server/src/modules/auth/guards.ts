// Request guards. Every protected route declares one of these in preHandler; there is no implicit access.
import { BlockList, isIP, isIPv6 } from 'node:net';
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
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { audit } from '../../common/audit.js';
import { randomBase62, safeEqual } from '../../common/crypto/random.js';
import { verifyTotp } from '../../common/crypto/totp.js';
import { withSystem, withTenant } from '../../common/db.js';
import type { Deps } from '../../deps.js';
import { adminUsers, merchantUsers } from '../../db/schema.js';
import { loadAdminSettings, readAdminSettings, type AdminSettings } from '../admin/settings.js';
import { COOKIE, cookieBase, signToken, verifyToken } from './session.js';

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

/** The session user set by requireUser; throws if a route forgot that guard. */
export function authedUser(req: FastifyRequest): AuthedUser {
  if (!req.user) throw new AppError('unauthorized', 'authentication required');
  return req.user;
}

export function requirePermission(permission: MerchantPermission): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user) throw new AppError('unauthorized', 'authentication required');
    if (!roleCan(req.user.role, permission)) throw new AppError('forbidden', `missing permission ${permission}`);
  };
}

/**
 * Live-mode actions (live API keys, xpubs, invoices, webhooks) need the acting user's email to be verified (M10).
 * Reads `livemode` from the validated body; test mode is never gated. Runs before step-up so a refused request
 * does not burn the TOTP code.
 */
export function requireVerifiedEmailForLive(deps: Deps): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if ((req.body as { livemode?: unknown } | undefined)?.livemode !== true) return;
    const user = authedUser(req);
    const [u] = await withTenant(deps.db, user.merchantId, (tx) =>
      tx.select({ verifiedAt: merchantUsers.emailVerifiedAt }).from(merchantUsers).where(eq(merchantUsers.id, user.id)),
    );
    if (!u?.verifiedAt) throw new AppError('forbidden', 'verify your email address before using live mode', { reason: 'email_unverified' });
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

/** An IP address or CIDR the allowlist accepts: "203.0.113.7", "203.0.113.0/24", "2001:db8::/32". */
export function validIpEntry(entry: string): boolean {
  const [addr = '', bits, extra] = entry.split('/');
  const v = isIP(addr);
  if (v === 0 || extra !== undefined) return false;
  if (bits === undefined) return true;
  return /^\d{1,3}$/.test(bits) && Number(bits) <= (v === 4 ? 32 : 128);
}

export const ADMIN_COOKIE = { access: 'gw_admin_at', csrf: 'gw_admin_csrf' } as const;
export const adminTotpAad = (adminId: string) => `admin_users.totp:${adminId}`;

/**
 * Admin routes answer 404 outside the allowlists: the server's ADMIN_IP_ALLOWLIST (if set) and, when switched on, the
 * console's own allowlist (D-107). Both apply. Runs before authentication, on every admin request.
 */
export function requireAdminNetwork(deps: Deps): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!ipAllowed(req.ip, deps.config.ADMIN_IP_ALLOWLIST)) throw new AppError('not_found', 'route not found');
    const s = await readAdminSettings(deps);
    if (s.ipAllowlistEnabled && !ipAllowed(req.ip, s.ipAllowlist.map((e) => e.cidr))) throw new AppError('not_found', 'route not found');
  };
}

const ADMIN_COOKIE_PATH = '/admin';
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Sets the admin session cookies (D-106). Sliding: the token lives `session_idle_minutes` and requireAdmin renews it on
 * every request, but never past `session_max_hours` after sign-in (`ast`, carried across renewals). No refresh token
 * (D-032). The CSRF cookie keeps its value and follows the same lifetime. Seconds of real time, like the JWT's own
 * iat/exp. Returns false once the absolute limit is reached (nothing is set).
 */
export async function setAdminSession(
  deps: Deps,
  reply: FastifyReply,
  admin: { id: string; role: AdminRole; epoch: number },
  ast: number,
  settings: AdminSettings,
  csrf: string,
): Promise<boolean> {
  const ttl = Math.min(settings.sessionIdleMinutes * 60, ast + settings.sessionMaxHours * 3600 - nowSeconds());
  if (ttl <= 0) return false;
  const token = await signToken(deps.config.ADMIN_JWT_SECRET, 'admin', ttl, { role: admin.role, sv: admin.epoch, ast }, admin.id);
  const base = cookieBase(deps);
  reply.setCookie(ADMIN_COOKIE.access, token, { ...base, path: ADMIN_COOKIE_PATH, maxAge: ttl });
  reply.setCookie(ADMIN_COOKIE.csrf, csrf, { ...base, httpOnly: false, path: ADMIN_COOKIE_PATH, maxAge: ttl });
  return true;
}

export function clearAdminSession(deps: Deps, reply: FastifyReply): void {
  const base = cookieBase(deps);
  reply.clearCookie(ADMIN_COOKIE.access, { ...base, path: ADMIN_COOKIE_PATH });
  reply.clearCookie(ADMIN_COOKIE.csrf, { ...base, httpOnly: false, path: ADMIN_COOKIE_PATH });
}

export function requireAdmin(deps: Deps, permission: AdminPermission): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
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
    const [a, settings] = await withSystem(deps.db, async (tx) => {
      const [row] = await tx.select({ role: adminUsers.role, disabledAt: adminUsers.disabledAt, epoch: adminUsers.sessionEpoch }).from(adminUsers).where(eq(adminUsers.id, adminId));
      return [row, await loadAdminSettings(tx)] as const;
    });
    if (!a || a.disabledAt || a.role !== role || (p.sv ?? 0) !== a.epoch) throw new AppError('unauthorized', 'authentication required');
    // Signed in at `ast`; tokens from before D-106 carry only iat.
    const ast = typeof p.ast === 'number' ? p.ast : (p.iat ?? 0);
    const csrf = req.cookies[ADMIN_COOKIE.csrf] ?? randomBase62(32);
    if (!(await setAdminSession(deps, reply, { id: adminId, role, epoch: a.epoch }, ast, settings, csrf))) {
      throw new AppError('unauthorized', 'session expired, sign in again');
    }
    req.admin = { id: adminId, role };
    if (!adminCan(role, permission)) throw new AppError('forbidden', `missing permission ${permission}`);
  };
}

/** Admin step-up: fresh TOTP in `x-totp-code` for actions that lower a safety control (D-064). Runs after requireAdmin. */
export function requireAdminTotp(deps: Deps): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    const admin = req.admin;
    if (!admin) throw new AppError('unauthorized', 'authentication required');
    const code = req.headers['x-totp-code'];
    const ok = await withSystem(deps.db, async (tx) => {
      const [a] = await tx.select().from(adminUsers).where(eq(adminUsers.id, admin.id)).for('update');
      /* v8 ignore next -- requireAdmin just loaded this row */
      if (!a) return false;
      const secret = await deps.envelope.open(a.totpSecretEnc, adminTotpAad(a.id));
      const step = typeof code === 'string' ? verifyTotp(secret, code, deps.clock(), a.totpLastStep) : null;
      if (step === null) {
        await audit(tx, { actorType: 'admin', actorId: a.id, action: 'admin.step_up_failed' }, req);
        return false;
      }
      await tx.update(adminUsers).set({ totpLastStep: step }).where(eq(adminUsers.id, a.id));
      return true;
    });
    if (!ok) throw new AppError('forbidden', 'valid x-totp-code header required');
  };
}
