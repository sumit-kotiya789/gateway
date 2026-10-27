import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSignerConfig } from '../../src/config.js';
import { Keyring, PATHS } from '../../src/keys.js';
import { LocalFileSeed } from '../../src/seed.js';
import { authHeader, parseIntent, verifyAuth } from '../../src/server.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const base = {
  SIGNER_DATABASE_URL: 'postgres://s:p@localhost:5432/db',
  SIGNER_HMAC_SECRET: 'h'.repeat(32),
  SIGNER_SEED_FILE: '/tmp/seed.json',
  SIGNER_SEED_KEK: randomBytes(32).toString('base64'),
};

describe('keys', () => {
  it('derives the well-known test accounts (BIP44, same as Anvil/Hardhat)', () => {
    const k = Keyring.fromMnemonic(MNEMONIC);
    expect(k.address("m/44'/60'/0'/0/0")).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(k.address("m/44'/60'/0'/0/1")).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(k.xpub(PATHS.deposits.test)).toMatch(/^xpub/);
    expect(() => k.account('m/44/../0')).toThrow(/invalid derivation path/);
    // Roles never share a key.
    const all = [PATHS.hot.live, PATHS.hot.test, PATHS.gas.live, PATHS.gas.test].map((p) => k.address(p));
    expect(new Set(all).size).toBe(4);
  });
});

describe('seed file', () => {
  it('round-trips under the right KEK; a wrong KEK or tampering fails without detail; never overwrites', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-'));
    const path = join(dir, 'seed.json');
    const kek = randomBytes(32);
    const mnemonic = await LocalFileSeed.create(path, kek);
    expect(mnemonic.split(' ')).toHaveLength(24);
    const file = await readFile(path, 'utf8');
    expect(file).not.toContain(mnemonic.split(' ')[0] ?? 'x');
    expect(new Keyring(await new LocalFileSeed(path, kek).load()).address(PATHS.hot.test)).toBe(Keyring.fromMnemonic(mnemonic).address(PATHS.hot.test));
    await expect(new LocalFileSeed(path, randomBytes(32)).load()).rejects.toThrow(/cannot be opened/);
    const sealed = JSON.parse(file) as { ct: string };
    sealed.ct = Buffer.from(Buffer.from(sealed.ct, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
    await writeFile(join(dir, 'bad.json'), JSON.stringify(sealed));
    await expect(new LocalFileSeed(join(dir, 'bad.json'), kek).load()).rejects.toThrow(/cannot be opened/);
    await expect(LocalFileSeed.create(path, kek)).rejects.toThrow(/EEXIST/);
    // Another file version, or a sealed value that is not a mnemonic, is refused.
    await writeFile(join(dir, 'v2.json'), JSON.stringify({ ...(JSON.parse(file) as object), v: 2 }));
    await expect(new LocalFileSeed(join(dir, 'v2.json'), kek).load()).rejects.toThrow(/cannot be opened/);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', kek, iv);
    c.setAAD(Buffer.from('gateway-signer-seed:v1'));
    const ct = Buffer.concat([c.update('not a mnemonic', 'utf8'), c.final()]);
    await writeFile(join(dir, 'junk.json'), JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }));
    await expect(new LocalFileSeed(join(dir, 'junk.json'), kek).load()).rejects.toThrow(/valid mnemonic/);
  });
});

describe('request authentication', () => {
  const secret = 's'.repeat(32);
  const body = JSON.stringify({ kind: 'sweep', id: '01890000-0000-7000-8000-000000000001' });
  it('accepts a fresh HMAC of the exact body only', () => {
    const h = authHeader(secret, body, 1_000);
    expect(verifyAuth(secret, body, h, 1_030)).toBe(true);
    expect(verifyAuth(secret, body, h, 1_061)).toBe(false); // stale
    expect(verifyAuth(secret, `${body} `, h, 1_000)).toBe(false); // body changed
    expect(verifyAuth('x'.repeat(32), body, h, 1_000)).toBe(false); // other secret
    expect(verifyAuth(secret, body, undefined, 1_000)).toBe(false);
    expect(verifyAuth(secret, body, 't=1000,v1=zz', 1_000)).toBe(false);
  });
  it('intents: known kind, uuid id, nothing else', () => {
    expect(parseIntent(body)).toEqual({ kind: 'sweep', id: '01890000-0000-7000-8000-000000000001' });
    expect(parseIntent(JSON.stringify({ kind: 'raw_tx', id: '01890000-0000-7000-8000-000000000001' }))).toBeNull();
    expect(parseIntent(JSON.stringify({ kind: 'sweep', id: 'x' }))).toBeNull();
    expect(parseIntent(JSON.stringify({ kind: 'sweep', id: '01890000-0000-7000-8000-000000000001', to: '0xabc' }))).toBeNull();
    expect(parseIntent('{')).toBeNull();
  });
});

describe('signer config', () => {
  it('development defaults; production refuses the local seed file and plain HTTP', () => {
    const c = loadSignerConfig(base);
    expect(c).toMatchObject({ SIGNER_PORT: 3100, SIGNER_PAUSED: false, SIGNER_LIMITS: {} });
    const prod = () => loadSignerConfig({ ...base, NODE_ENV: 'production' });
    expect(prod).toThrow(/KMS seed source is required/);
    expect(prod).toThrow(/mTLS/);
  });
  it('limits and cold addresses are validated; errors never echo values', () => {
    const c = loadSignerConfig({ ...base, SIGNER_LIMITS: '{"bsc:usdt":{"per_tx":"5000","per_day":"20000"}}', SIGNER_COLD_ADDRESSES: '0x' + 'A'.repeat(40) });
    expect(c.SIGNER_LIMITS['bsc:usdt']).toEqual({ per_tx: '5000', per_day: '20000' });
    expect(c.SIGNER_COLD_ADDRESSES).toEqual(['0x' + 'a'.repeat(40)]);
    expect(() => loadSignerConfig({ ...base, SIGNER_LIMITS: '{"bsc:usdt":{"per_tx":"-1"}}' })).toThrow(/SIGNER_LIMITS/);
    expect(() => loadSignerConfig({ ...base, SIGNER_COLD_ADDRESSES: 'not-an-address' })).toThrow(/SIGNER_COLD_ADDRESSES/);
    const msg = (() => {
      try {
        loadSignerConfig({ ...base, SIGNER_HMAC_SECRET: 'short-secret' });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(msg).toContain('SIGNER_HMAC_SECRET');
    expect(msg).not.toContain('short-secret');
  });
});
