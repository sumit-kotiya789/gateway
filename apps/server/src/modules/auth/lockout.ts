export const LOCKOUT_THRESHOLD = 5;
const BASE_MS = 15 * 60_000;
const MAX_MS = 24 * 3600_000;

/** After 5 consecutive failures: 15 min lock, doubling per further failure, capped at 24 h. */
export function lockoutUntil(failedLogins: number, nowMs: number): Date | null {
  if (failedLogins < LOCKOUT_THRESHOLD) return null;
  const ms = Math.min(BASE_MS * 2 ** (failedLogins - LOCKOUT_THRESHOLD), MAX_MS);
  return new Date(nowMs + ms);
}

export function isLocked(lockedUntil: Date | null, nowMs: number): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > nowMs;
}
