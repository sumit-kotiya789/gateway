// Known sign-in devices (M10, D-083). A browser that completes a sign-in gets a random token in a long-lived httpOnly
// cookie; a sign-in without a token we know for that user registers a new device and emails the user.
import { uuidv7 } from '@gw/core';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBase62, sha256Hex } from '../../common/crypto/random.js';
import type { Tx } from '../../common/db.js';
import { userDevices } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { enqueueEmail } from '../email/outbox.js';
import { templates } from '../email/templates.js';
import { cookieBase } from './session.js';

export const DEVICE_COOKIE = 'gw_dev';
const DEVICE_PATH = '/v1/dashboard/auth';
/** Browsers cap cookie lifetime at 400 days. */
const DEVICE_TTL_S = 400 * 24 * 3600;

interface DeviceUser {
  id: string;
  merchantId: string;
  email: string;
}

/**
 * Call once a sign-in has fully succeeded (after 2FA). `notify: false` registers the device silently: signup and
 * invite acceptance are the user's first sign-in, not a new one. A user's first device never triggers an email
 * (accounts that existed before devices were tracked).
 * Returns whether this sign-in came from a device we had not seen for this user.
 */
export async function rememberDevice(deps: Deps, tx: Tx, req: FastifyRequest, reply: FastifyReply, user: DeviceUser, opts: { notify: boolean }): Promise<boolean> {
  const now = new Date(deps.clock());
  const token = req.cookies[DEVICE_COOKIE];
  if (token) {
    const seen = await tx
      .update(userDevices)
      .set({ lastSeenAt: now, ip: req.ip })
      .where(and(eq(userDevices.tokenHash, sha256Hex(token)), eq(userDevices.userId, user.id)))
      .returning({ id: userDevices.id });
    if (seen.length === 1) return false;
  }
  const [known] = await tx.select({ n: count() }).from(userDevices).where(eq(userDevices.userId, user.id));
  // A token for another user (shared browser) is left alone; this user's sign-in gets its own.
  const fresh = randomBase62(43);
  const userAgent = req.headers['user-agent']?.slice(0, 512) ?? null;
  await tx.insert(userDevices).values({ id: uuidv7(), merchantId: user.merchantId, userId: user.id, tokenHash: sha256Hex(fresh), ip: req.ip, userAgent, lastSeenAt: now });
  reply.setCookie(DEVICE_COOKIE, fresh, { ...cookieBase(deps), path: DEVICE_PATH, maxAge: DEVICE_TTL_S });
  if (opts.notify && (known?.n ?? 0) > 0) {
    await enqueueEmail(deps, tx, {
      merchantId: user.merchantId,
      kind: 'new_device_login',
      to: user.email,
      ...templates.newDeviceLogin({ at: now.toISOString(), ip: req.ip, userAgent, dashboardUrl: deps.config.DASHBOARD_URL }),
    });
  }
  return true;
}
