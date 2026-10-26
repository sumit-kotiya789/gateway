// Single-use emailed tokens (verification, password reset). 256 random bits; only the SHA-256 is stored.
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { sha256Hex } from '../../common/crypto/random.js';
import type { Tx } from '../../common/db.js';
import { emailTokens } from '../../db/schema.js';

export type TokenPurpose = 'verify_email' | 'password_reset';
type TokenRow = typeof emailTokens.$inferSelect;

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = { verify_email: 48 * 3600_000, password_reset: 3600_000 };
/** A new token of the same purpose is refused this soon after the previous one (mail bombing). */
export const TOKEN_RESEND_MS = 60_000;

/** Latest token of a purpose for a user, used or not (for the resend throttle). */
export async function lastTokenAt(tx: Tx, userId: string, purpose: TokenPurpose): Promise<number | null> {
  const [r] = await tx
    .select({ at: emailTokens.createdAt })
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)))
    .orderBy(desc(emailTokens.createdAt))
    .limit(1);
  return r ? r.at.getTime() : null;
}

/** Issues a fresh token and invalidates any earlier unused one of the same purpose. Returns the raw token. */
export async function issueEmailToken(tx: Tx, user: { id: string; merchantId: string }, purpose: TokenPurpose, now: number): Promise<string> {
  await tx
    .update(emailTokens)
    .set({ usedAt: new Date(now) })
    .where(and(eq(emailTokens.userId, user.id), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt)));
  const token = randomBytes(32).toString('base64url');
  // createdAt from the app clock: the resend throttle compares it with the same clock.
  await tx.insert(emailTokens).values({
    merchantId: user.merchantId,
    userId: user.id,
    purpose,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(now + TOKEN_TTL_MS[purpose]),
    createdAt: new Date(now),
  });
  return token;
}

/** The unused, unexpired token row for `token` (row-locked), or null. Does not consume it. */
export async function findEmailToken(tx: Tx, purpose: TokenPurpose, token: string, now: number): Promise<TokenRow | null> {
  const [row] = await tx
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.tokenHash, sha256Hex(token)), eq(emailTokens.purpose, purpose)))
    .for('update');
  if (!row || row.usedAt || row.expiresAt.getTime() <= now) return null;
  return row;
}

export async function useEmailToken(tx: Tx, row: TokenRow, now: number): Promise<void> {
  await tx.update(emailTokens).set({ usedAt: new Date(now) }).where(eq(emailTokens.id, row.id));
}
