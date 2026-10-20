import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Envelope, LocalKek } from '../../src/common/crypto/envelope.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../src/common/crypto/password.js';
import { randomBase62, safeEqual } from '../../src/common/crypto/random.js';
import { base32Decode, base32Encode, currentStep, totpAt, totpUri, verifyTotp } from '../../src/common/crypto/totp.js';
import { ipAllowed } from '../../src/modules/auth/guards.js';
import { isLocked, lockoutUntil } from '../../src/modules/auth/lockout.js';
import { generateApiKey, hashApiKey, parseApiKey } from '../../src/modules/api-keys/api-keys.js';

describe('TOTP (RFC 6238 SHA1 vectors)', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T=%i -> %s', (t, want) => {
    expect(totpAt(secret, currentStep(t * 1000), 8)).toBe(want);
  });

  it('base32 round-trips and rejects junk', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(() => base32Decode('abc1')).toThrow();
  });

  it('accepts current and ±1 step, rejects ±2', () => {
    const s = base32Encode(randomBytes(20));
    const now = 1_700_000_000_000;
    const at = (deltaSteps: number) => totpAt(base32Decode(s), currentStep(now) + BigInt(deltaSteps));
    expect(verifyTotp(s, at(0), now, null)).toBe(currentStep(now));
    expect(verifyTotp(s, at(-1), now, null)).toBe(currentStep(now) - 1n);
    expect(verifyTotp(s, at(1), now, null)).toBe(currentStep(now) + 1n);
    expect(verifyTotp(s, at(2), now, null)).toBeNull();
    expect(verifyTotp(s, at(-2), now, null)).toBeNull();
  });

  it('rejects replay of an already-used step and malformed codes', () => {
    const s = base32Encode(randomBytes(20));
    const now = 1_700_000_000_000;
    const code = totpAt(base32Decode(s), currentStep(now));
    const step = verifyTotp(s, code, now, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(s, code, now, step)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456']) expect(verifyTotp(s, bad, now, null)).toBeNull();
  });

  it('builds an otpauth URI with escaped label', () => {
    expect(totpUri('ABC', 'a b@x.io', 'Gateway')).toBe(
      'otpauth://totp/Gateway%3Aa%20b%40x.io?secret=ABC&issuer=Gateway&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('password hashing (argon2id)', () => {
  it('hashes with argon2id params and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('salts: same password, different hashes', async () => {
    expect(await hashPassword('x'.repeat(12))).not.toBe(await hashPassword('x'.repeat(12)));
  });

  it('malformed stored hash verifies false; burn check is false', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await burnPasswordCheck('x')).toBe(false);
  });
});

describe('envelope encryption', () => {
  const kek = new LocalKek('k1', randomBytes(32));
  const env = new Envelope([kek]);

  it('round-trips and never contains plaintext', async () => {
    const s = await env.seal('JBSWY3DPEHPK3PXP', 'users.totp:1');
    expect(s.startsWith('v1.k1.')).toBe(true);
    expect(s).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await env.open(s, 'users.totp:1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('fresh DEK and IV per seal', async () => {
    expect(await env.seal('x', 'a')).not.toBe(await env.seal('x', 'a'));
  });

  it('AAD binds ciphertext to its row (swap fails)', async () => {
    const s = await env.seal('secret', 'users.totp:1');
    await expect(env.open(s, 'users.totp:2')).rejects.toThrow();
  });

  it('tampering fails authentication', async () => {
    const s = await env.seal('secret', 'a');
    const parts = s.split('.');
    const payload = Buffer.from(parts[3] ?? '', 'base64url');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 1;
    parts[3] = payload.toString('base64url');
    await expect(env.open(parts.join('.'), 'a')).rejects.toThrow();
  });

  it('KEK rotation: new KEK encrypts, old KEK still decrypts; unknown KEK fails', async () => {
    const old = await env.seal('legacy', 'a');
    const rotated = new Envelope([new LocalKek('k2', randomBytes(32)), kek]);
    expect(await rotated.open(old, 'a')).toBe('legacy');
    expect((await rotated.seal('new', 'a')).startsWith('v1.k2.')).toBe(true);
    await expect(new Envelope([new LocalKek('k3', randomBytes(32))]).open(old, 'a')).rejects.toThrow(/unknown KEK/);
    await expect(env.open('v2.k1.a.b', 'a')).rejects.toThrow(/unsupported/);
  });

  it('rejects bad KEK material', () => {
    expect(() => new LocalKek('k', randomBytes(16))).toThrow();
    expect(() => new LocalKek('bad id!', randomBytes(32))).toThrow();
    expect(() => new Envelope([])).toThrow();
  });
});

describe('API key format', () => {
  it('generates parseable keys with matching prefix', () => {
    const { key, prefix } = generateApiKey('secret', true);
    expect(key).toMatch(/^sk_live_[0-9A-Za-z]{42}$/);
    expect(parseApiKey(key)).toEqual({ prefix, kind: 'secret', livemode: true });
    const pk = generateApiKey('publishable', false);
    expect(parseApiKey(pk.key)).toMatchObject({ kind: 'publishable', livemode: false });
  });

  it('rejects malformed keys', () => {
    for (const k of ['', 'sk_live_short', 'xx_live_' + 'a'.repeat(42), 'sk_prod_' + 'a'.repeat(42), 'sk_live_' + 'a'.repeat(41) + '!']) {
      expect(parseApiKey(k)).toBeNull();
    }
  });

  it('hash depends on pepper and key', () => {
    expect(hashApiKey('p1', 'k')).not.toBe(hashApiKey('p2', 'k'));
    expect(hashApiKey('p1', 'k')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('base62 output is uniform alphabet and right length', () => {
    const s = randomBase62(10_000);
    expect(s).toMatch(/^[0-9A-Za-z]{10000}$/);
    expect(new Set(s).size).toBe(62);
  });

  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('ip allowlist', () => {
  it('matches addresses, CIDRs, v4-mapped v6, and empty = allow all', () => {
    expect(ipAllowed('10.1.2.3', [])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.0.0.1', ['10.0.0.0/8', '192.168.1.5'])).toBe(false);
    expect(ipAllowed('192.168.1.5', ['192.168.1.5'])).toBe(true);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
  });
});

describe('lockout schedule', () => {
  it('locks at 5 failures, doubles, caps at 24h', () => {
    const now = 0;
    expect(lockoutUntil(4, now)).toBeNull();
    expect(lockoutUntil(5, now)?.getTime()).toBe(15 * 60_000);
    expect(lockoutUntil(6, now)?.getTime()).toBe(30 * 60_000);
    expect(lockoutUntil(50, now)?.getTime()).toBe(24 * 3600_000);
    expect(isLocked(new Date(1000), 999)).toBe(true);
    expect(isLocked(new Date(1000), 1000)).toBe(false);
    expect(isLocked(null, 0)).toBe(false);
  });
});
