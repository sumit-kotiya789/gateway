// Webhook signature verification: `gateway-signature: t=<unix>,v1=<hex>[,v1=<hex>]`, HMAC-SHA256 of "<t>.<raw body>"
// keyed with the endpoint secret. Several v1 values appear while a secret is being rotated; any match is accepted.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GatewayEvent } from './types.js';

export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
}

export interface VerifyOptions {
  /** Maximum age of the signature timestamp, in seconds (default 300). */
  toleranceSeconds?: number;
  /** Current time in ms (tests). */
  now?: number;
}

/**
 * Verifies a webhook and returns the parsed event. `rawBody` must be the exact bytes received: never re-serialize
 * parsed JSON. `secrets`: one secret, or several while you rotate. Throws WebhookVerificationError otherwise.
 */
export function constructEvent(rawBody: string | Uint8Array, signatureHeader: string | undefined, secrets: string | readonly string[], opts: VerifyOptions = {}): GatewayEvent {
  if (!signatureHeader) throw new WebhookVerificationError('missing gateway-signature header');
  const parts = signatureHeader.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
  });
  const tRaw = parts.find(([k]) => k === 't')?.[1] ?? '';
  const t = /^\d{1,12}$/.test(tRaw) ? Number(tRaw) : NaN;
  const now = (opts.now ?? Date.now()) / 1000;
  if (!Number.isFinite(t) || Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) {
    throw new WebhookVerificationError('signature timestamp missing or outside the tolerance');
  }
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const candidates = parts.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v)).map(([, v]) => Buffer.from(v, 'hex'));
  const ok = (typeof secrets === 'string' ? [secrets] : secrets).some((secret) => {
    const expected = createHmac('sha256', secret).update(`${String(t)}.`).update(body).digest();
    return candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected));
  });
  if (!ok) throw new WebhookVerificationError('no valid signature');
  return JSON.parse(body.toString('utf8')) as GatewayEvent;
}
