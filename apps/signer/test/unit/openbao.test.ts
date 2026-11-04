import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSignerConfig } from '../../src/config.js';
import { Keyring, PATHS } from '../../src/keys.js';
import { OpenBaoSeed, type OpenBaoSettings } from '../../src/openbao.js';
import { LocalFileSeed } from '../../src/seed.js';
import { createSeed, seedSource } from '../../src/sources.js';

/** In-process stand-in for OpenBao: AppRole login, one Transit key (real AES-GCM), token revocation. */
class FakeOpenBao {
  readonly roleId = 'role-1';
  readonly secretId = 'secret-1';
  private readonly key = randomBytes(32);
  private readonly tokens = new Set<string>();
  readonly calls: string[] = [];
  /** Per endpoint: answer 200 with this body instead, or drop the connection. */
  override: Partial<Record<'login' | 'encrypt' | 'decrypt' | 'revoke', object | 'drop'>> = {};
  private server: Server | null = null;
  addr = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        if (body === 'drop') {
          req.socket.destroy();
          return;
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === null ? '' : JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    this.addr = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => { r(); }));
  }

  get liveTokens(): number {
    return this.tokens.size;
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, string>;
    const token = req.headers['x-vault-token'];
    this.calls.push(req.url ?? '');
    const name = ({ '/v1/auth/approle/login': 'login', '/v1/transit/encrypt/gateway-signer': 'encrypt', '/v1/transit/decrypt/gateway-signer': 'decrypt', '/v1/auth/token/revoke-self': 'revoke' } as const)[req.url ?? ''];
    const o = name === undefined ? undefined : this.override[name];
    if (o !== undefined) return { status: 200, body: o };
    if (req.url === '/v1/auth/approle/login') {
      if (body.role_id !== this.roleId || body.secret_id !== this.secretId) return { status: 400, body: { errors: ['invalid role or secret ID'] } };
      const t = `s.${randomBytes(8).toString('hex')}`;
      this.tokens.add(t);
      return { status: 200, body: { auth: { client_token: t } } };
    }
    if (typeof token !== 'string' || !this.tokens.has(token)) return { status: 403, body: { errors: ['permission denied'] } };
    if (req.url === '/v1/auth/token/revoke-self') {
      this.tokens.delete(token);
      return { status: 204, body: null };
    }
    if (req.url === '/v1/transit/encrypt/gateway-signer') {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', this.key, iv);
      const ct = Buffer.concat([c.update(Buffer.from(body.plaintext ?? '', 'base64')), c.final(), c.getAuthTag()]);
      return { status: 200, body: { data: { ciphertext: `vault:v1:${Buffer.concat([iv, ct]).toString('base64')}` } } };
    }
    if (req.url === '/v1/transit/decrypt/gateway-signer') {
      try {
        const raw = Buffer.from((body.ciphertext ?? '').replace(/^vault:v1:/, ''), 'base64');
        const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12), { authTagLength: 16 });
        d.setAuthTag(raw.subarray(raw.length - 16));
        const pt = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
        return { status: 200, body: { data: { plaintext: pt.toString('base64') } } };
      } catch {
        return { status: 400, body: { errors: ['cipher: message authentication failed'] } };
      }
    }
    return { status: 404, body: { errors: [] } };
  }
}

const bao = new FakeOpenBao();
let dir = '';
let settings: OpenBaoSettings;
beforeAll(async () => {
  await bao.start();
  dir = await mkdtemp(join(tmpdir(), 'openbao-'));
  await writeFile(join(dir, 'secret-id'), `${bao.secretId}\n`);
  settings = { addr: bao.addr, mount: 'transit', key: 'gateway-signer', roleId: bao.roleId, secretIdFile: join(dir, 'secret-id') };
});
afterAll(() => bao.stop());

describe('openbao seed source', () => {
  it('round-trips through Transit: the file holds only ciphertext, every token is revoked, never overwrites', async () => {
    const path = join(dir, 'seed.json');
    const mnemonic = await OpenBaoSeed.create(path, settings);
    expect(mnemonic.split(' ')).toHaveLength(24);
    const file = await readFile(path, 'utf8');
    expect(JSON.parse(file)).toMatchObject({ v: 1, source: 'openbao', key: 'gateway-signer', ciphertext: expect.stringMatching(/^vault:v1:/) as unknown });
    expect(file).not.toContain(mnemonic.split(' ')[0] ?? 'x');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const seed = await new OpenBaoSeed(path, settings).load();
    expect(new Keyring(seed).address(PATHS.hot.live)).toBe(Keyring.fromMnemonic(mnemonic).address(PATHS.hot.live));
    expect(bao.liveTokens).toBe(0);
    await expect(OpenBaoSeed.create(path, settings)).rejects.toThrow(/EEXIST/);
    expect(bao.liveTokens).toBe(0);
  });

  it('refuses a wrong secret id, a tampered ciphertext, a file for another key or of another kind; errors carry no secrets', async () => {
    const path = join(dir, 'seed2.json');
    await OpenBaoSeed.create(path, settings);
    await writeFile(join(dir, 'wrong-secret'), 'not-the-secret');
    const wrong = new OpenBaoSeed(path, { ...settings, secretIdFile: join(dir, 'wrong-secret') });
    const err = await wrong.load().then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe('OpenBao login failed (HTTP 400)');

    const sealed = JSON.parse(await readFile(path, 'utf8')) as { ciphertext: string };
    const raw = Buffer.from(sealed.ciphertext.slice('vault:v1:'.length), 'base64');
    raw[20] = (raw[20] ?? 0) ^ 1;
    await writeFile(join(dir, 'tampered.json'), JSON.stringify({ ...sealed, ciphertext: `vault:v1:${raw.toString('base64')}` }));
    await expect(new OpenBaoSeed(join(dir, 'tampered.json'), settings).load()).rejects.toThrow('OpenBao decrypt failed (HTTP 400)');
    expect(bao.liveTokens).toBe(0); // revoked even when decrypt fails

    await expect(new OpenBaoSeed(path, { ...settings, key: 'other-key' }).load()).rejects.toThrow(/another Transit key/);
    await writeFile(join(dir, 'local.json'), JSON.stringify({ v: 1, iv: 'x', tag: 'y', ct: 'z' }));
    await expect(new OpenBaoSeed(join(dir, 'local.json'), settings).load()).rejects.toThrow(/not an OpenBao seed file/);
    // OpenBao down: nothing is opened.
    await expect(new OpenBaoSeed(path, { ...settings, addr: 'http://127.0.0.1:1' }).load()).rejects.toThrow();
  });

  it('malformed answers are refused: no token, no ciphertext, no plaintext, not a mnemonic; a failed revoke is harmless', async () => {
    const path = join(dir, 'seed3.json');
    await OpenBaoSeed.create(path, settings);
    const load = () => new OpenBaoSeed(path, settings).load();
    try {
      bao.override = { decrypt: { data: { plaintext: Buffer.from('not a mnemonic').toString('base64') } } };
      await expect(load()).rejects.toThrow(/valid mnemonic/);
      bao.override = { decrypt: { data: {} } };
      await expect(load()).rejects.toThrow('OpenBao decrypt returned no plaintext');
      bao.override = { login: { auth: {} } };
      await expect(load()).rejects.toThrow('OpenBao login failed (HTTP 200)');
      bao.override = { encrypt: { data: { ciphertext: 'plain text' } } };
      await expect(OpenBaoSeed.create(join(dir, 'never.json'), settings)).rejects.toThrow('OpenBao encrypt returned no ciphertext');
      await expect(stat(join(dir, 'never.json'))).rejects.toThrow(/ENOENT/);
      // OpenBao drops the revoke: the seed is still loaded (the token expires on its own TTL).
      bao.override = { revoke: 'drop' };
      expect((await load()).length).toBe(64);
    } finally {
      bao.override = {};
    }
    // A CA file is read and used for https; plain http (tests) ignores it.
    await writeFile(join(dir, 'ca.pem'), 'unused for http');
    expect((await new OpenBaoSeed(path, { ...settings, caFile: join(dir, 'ca.pem') }).load()).length).toBe(64);
  });
});

describe('seed source settings', () => {
  const base = { SIGNER_DATABASE_URL: 'postgres://s:p@localhost:5432/db', SIGNER_HMAC_SECRET: 'h'.repeat(32), SIGNER_SEED_FILE: '/tmp/seed.json' };
  const tls = { SIGNER_TLS_CERT_FILE: '/c', SIGNER_TLS_KEY_FILE: '/k', SIGNER_TLS_CLIENT_CA_FILE: '/ca' };
  const openbao = { SIGNER_SEED_SOURCE: 'openbao', SIGNER_OPENBAO_ADDR: 'https://openbao.internal:8200', SIGNER_OPENBAO_ROLE_ID: 'role-1', SIGNER_OPENBAO_SECRET_ID_FILE: '/run/secret-id' };

  it('openbao needs its address, role and secret id file; production needs https; errors name keys only', () => {
    expect(() => loadSignerConfig({ ...base, SIGNER_SEED_SOURCE: 'openbao' })).toThrow(/SIGNER_OPENBAO_ADDR.*SIGNER_OPENBAO_ROLE_ID.*SIGNER_OPENBAO_SECRET_ID_FILE/);
    const prod = { ...base, ...openbao, ...tls, NODE_ENV: 'production' };
    expect(loadSignerConfig(prod).SEED).toEqual({
      source: 'openbao',
      file: '/tmp/seed.json',
      openbao: { addr: 'https://openbao.internal:8200', mount: 'transit', key: 'gateway-signer', roleId: 'role-1', secretIdFile: '/run/secret-id' },
    });
    expect(() => loadSignerConfig({ ...prod, SIGNER_OPENBAO_ADDR: 'http://openbao.internal:8200' })).toThrow(/SIGNER_OPENBAO_ADDR: must be https in production/);
    expect(() => loadSignerConfig({ ...prod, SIGNER_OPENBAO_TRANSIT_KEY: '../sys' })).toThrow(/SIGNER_OPENBAO_TRANSIT_KEY/);
    expect(() => loadSignerConfig({ ...prod, SIGNER_OPENBAO_ADDR: 'ftp://openbao.internal' })).toThrow(/SIGNER_OPENBAO_ADDR/);
    expect(loadSignerConfig({ ...prod, SIGNER_OPENBAO_CA_FILE: '/ca.pem', SIGNER_OPENBAO_TRANSIT_MOUNT: 'kms/transit' }).SEED).toMatchObject({ openbao: { caFile: '/ca.pem', mount: 'kms/transit' } });
    // Production refuses only the local file; the KEK is not needed for openbao.
    expect(() => loadSignerConfig({ ...base, ...tls, NODE_ENV: 'production', SIGNER_SEED_KEK: randomBytes(32).toString('base64') })).toThrow(/local-file is refused in production/);
    const msg = (() => {
      try {
        loadSignerConfig({ ...prod, SIGNER_OPENBAO_ADDR: 'http://secret-host:8200' });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(msg).not.toContain('secret-host');
  });

  it('picks the configured source', async () => {
    const local = loadSignerConfig({ ...base, SIGNER_SEED_KEK: randomBytes(32).toString('base64') });
    expect(seedSource(local.SEED)).toBeInstanceOf(LocalFileSeed);
    const cfg = loadSignerConfig({ ...base, ...openbao, SIGNER_SEED_FILE: join(dir, 'via-config.json'), SIGNER_OPENBAO_ADDR: bao.addr, SIGNER_OPENBAO_ROLE_ID: bao.roleId, SIGNER_OPENBAO_SECRET_ID_FILE: join(dir, 'secret-id') });
    expect(seedSource(cfg.SEED)).toBeInstanceOf(OpenBaoSeed);
    const mnemonic = await createSeed(cfg.SEED);
    expect(new Keyring(await seedSource(cfg.SEED).load()).address(PATHS.gas.test)).toBe(Keyring.fromMnemonic(mnemonic).address(PATHS.gas.test));
    const localPath = join(dir, 'local-via-config.json');
    const localCfg = loadSignerConfig({ ...base, SIGNER_SEED_FILE: localPath, SIGNER_SEED_KEK: randomBytes(32).toString('base64') });
    const words = await createSeed(localCfg.SEED);
    expect(new Keyring(await seedSource(localCfg.SEED).load()).address(PATHS.gas.test)).toBe(Keyring.fromMnemonic(words).address(PATHS.gas.test));
  });
});
