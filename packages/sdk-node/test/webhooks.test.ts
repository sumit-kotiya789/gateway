import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebhookVerificationError, constructEvent } from '../src/index.js';

// Same format as the gateway (D-071); the server's own signer is checked against the SDK in apps/server sdk.test.ts.
const signatureHeader = (secrets: string[], ts: number, b: string) =>
  [`t=${String(ts)}`, ...secrets.map((s) => `v1=${createHmac('sha256', s).update(`${String(ts)}.${b}`).digest('hex')}`)].join(',');

const body = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', livemode: false, created_at: '2026-10-26T00:00:00.000Z', data: { status: 'paid' } });
const now = 1_790_000_000_000;
const t = Math.floor(now / 1000);

describe('constructEvent', () => {
  it('accepts a valid signature and returns the event', () => {
    expect(constructEvent(body, signatureHeader(['whsec_a'], t, body), 'whsec_a', { now }).type).toBe('invoice.paid');
    expect(constructEvent(Buffer.from(body), signatureHeader(['whsec_a'], t, body), 'whsec_a', { now }).id).toBe('evt_1');
  });

  it('accepts during rotation: either secret, either signature', () => {
    const h = signatureHeader(['whsec_new', 'whsec_old'], t, body);
    expect(constructEvent(body, h, 'whsec_old', { now }).id).toBe('evt_1');
    expect(constructEvent(body, h, ['whsec_x', 'whsec_new'], { now }).id).toBe('evt_1');
  });

  it.each([
    ['wrong secret', () => constructEvent(body, signatureHeader(['whsec_a'], t, body), 'whsec_b', { now })],
    ['tampered body', () => constructEvent(`${body} `, signatureHeader(['whsec_a'], t, body), 'whsec_a', { now })],
    ['too old', () => constructEvent(body, signatureHeader(['whsec_a'], t - 301, body), 'whsec_a', { now })],
    ['from the future', () => constructEvent(body, signatureHeader(['whsec_a'], t + 301, body), 'whsec_a', { now })],
    ['missing header', () => constructEvent(body, undefined, 'whsec_a', { now })],
    ['no timestamp', () => constructEvent(body, 'v1=00', 'whsec_a', { now })],
    ['garbage', () => constructEvent(body, 't=abc,v1=zz', 'whsec_a', { now })],
  ])('rejects: %s', (_name, fn) => {
    expect(fn).toThrow(WebhookVerificationError);
  });

  it('custom tolerance', () => {
    const h = signatureHeader(['whsec_a'], t - 600, body);
    expect(constructEvent(body, h, 'whsec_a', { now, toleranceSeconds: 900 }).id).toBe('evt_1');
  });
});
