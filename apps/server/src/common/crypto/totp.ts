// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) on node:crypto. Replay-protected via last accepted time step.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PERIOD_S = 30n;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function totpAt(secret: Buffer, step: bigint, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(step);
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = (h[h.length - 1] ?? 0) & 0xf;
  const bin = h.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function currentStep(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000)) / PERIOD_S;
}

/**
 * Returns the matched time step, or null. Accepts ±1 step of drift.
 * A step at or below `lastStep` is rejected (replay of an already-used code).
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: bigint | null): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const now = currentStep(nowMs);
  let matched: bigint | null = null;
  for (const step of [now - 1n, now, now + 1n]) {
    // Evaluate all candidates to keep timing independent of which one matches.
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code)) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (lastStep !== null && matched <= lastStep) return null;
  return matched;
}
