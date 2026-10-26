import { randomBytes } from 'node:crypto';
import { evmDeriver } from '@gw/chains';
import { uuidv7 } from '@gw/core';
import { HDKey } from 'viem/accounts';
import { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/common/config.js';
import { Envelope, LocalKek } from '../../src/common/crypto/envelope.js';
import { hashPassword } from '../../src/common/crypto/password.js';
import { base32Decode, currentStep, generateTotpSecret, totpAt } from '../../src/common/crypto/totp.js';
import { createDb } from '../../src/common/db.js';
import { createLogger } from '../../src/common/logger.js';
import type { Deps } from '../../src/deps.js';
import { adminTotpAad } from '../../src/modules/auth/guards.js';

export const DASH_ORIGIN = 'http://dash.test';
export const ADMIN_ORIGIN = 'http://admin.test';

export function testEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('pgAppUrl'),
    REDIS_URL: inject('redisUrl'),
    JWT_SECRET: 'j'.repeat(40),
    ADMIN_JWT_SECRET: 'a'.repeat(40),
    API_KEY_PEPPER: 'p'.repeat(40),
    DATA_KEK: randomBytes(32).toString('base64'),
    DASHBOARD_ORIGINS: DASH_ORIGIN,
    ADMIN_ORIGINS: ADMIN_ORIGIN,
    TRUST_PROXY_HOPS: '1',
    ...overrides,
  };
}

/** Controllable clock: tests advance time to get fresh TOTP steps and expire tokens. */
export function makeClock(start = Date.now()) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms: number) => {
    t += ms;
  };
  return clock;
}

export function buildTestApp(env: Record<string, string> = {}) {
  const config = loadConfig(testEnv(env));
  const { db, pool } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  const clock = makeClock();
  const deps: Deps = {
    config,
    db,
    redis,
    envelope: new Envelope([new LocalKek(config.DATA_KEK_ID, Buffer.from(config.DATA_KEK, 'base64'))]),
    clock,
    log: createLogger('silent'),
  };
  const app = buildApp(deps.log, deps);
  const close = async () => {
    await app.close();
    await pool.end();
    redis.disconnect();
  };
  return { app, deps, db, pool, redis, clock, close };
}

export function ownerPool() {
  return new pg.Pool({ connectionString: inject('pgOwnerUrl'), max: 2 });
}

export function totpNow(secretB32: string, nowMs: number): string {
  return totpAt(base32Decode(secretB32), currentStep(nowMs));
}

export const uniqueEmail = (tag = 'u') => `${tag}-${randomBytes(6).toString('hex')}@example.test`;

/** Minimal cookie jar over app.inject. */
export class Agent {
  readonly cookies = new Map<string, string>();
  /** Each agent is a distinct client IP, so per-IP auth rate limits don't couple unrelated tests. */
  readonly ip = `10.${String(1 + Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}.${String(1 + Math.floor(Math.random() * 250))}`;
  constructor(
    private readonly app: ReturnType<typeof buildApp>,
    private readonly origin = DASH_ORIGIN,
  ) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = this.cookies.get('gw_csrf') ?? this.cookies.get('gw_admin_csrf');
    const res = await this.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: {
        origin: this.origin,
        'x-forwarded-for': this.ip,
        ...(cookie ? { cookie } : {}),
        ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...headers,
      },
    });
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now()) || c.maxAge === 0) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }
}

/** Signs up a fresh merchant + owner and returns a logged-in agent. */
export async function signup(app: ReturnType<typeof buildApp>, name = 'Acme') {
  const agent = new Agent(app);
  const email = uniqueEmail('owner');
  const password = 'correct horse battery';
  const res = await agent.req('POST', '/v1/dashboard/auth/signup', { merchant_name: name, email, password });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const b = res.json<{ merchant: { id: string }; user: { id: string } }>();
  return { agent, email, password, merchantId: b.merchant.id, userId: b.user.id };
}

/** Enables TOTP for the agent's user; returns the secret and recovery codes. */
export async function enable2fa(agent: Agent, clock: ReturnType<typeof makeClock>) {
  const setup = await agent.req('POST', '/v1/dashboard/auth/2fa/setup');
  const { secret } = setup.json<{ secret: string }>();
  const en = await agent.req('POST', '/v1/dashboard/auth/2fa/enable', { code: totpNow(secret, clock()) });
  if (en.statusCode !== 200) throw new Error(`2fa enable failed: ${en.body}`);
  return { secret, recoveryCodes: en.json<{ recovery_codes: string[] }>().recovery_codes };
}

/** Shared local mock-USDT token row (same address in every test file: token identity is immutable). */
export const LOCAL_USDT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/** Registry rows for the local chain + token. Idempotent across test files. */
export async function ensureLocalRegistry(owner: pg.Pool): Promise<void> {
  await owner.query(`insert into chains (id, family, name, evm_chain_id, rpc_urls, native_symbol, native_decimals, block_time_ms,
      default_confirmations, reorg_depth, finality, testnet, enabled)
    values ('evm-local', 'evm', 'Local Anvil', 31337, $1, 'ETH', 18, 1000, 2, 16, 'tag', true, true)
    on conflict do nothing`, [['${EVM_LOCAL_RPC_URL}']]);
  await owner.query(`insert into tokens (id, chain_id, symbol, name, contract_address, decimals, min_confirmations, min_amount, enabled)
    values ('evm-local:usdt', 'evm-local', 'USDT', 'Local mock USDT', $1, 18, 2, 10000000000000000, true)
    on conflict do nothing`, [LOCAL_USDT]);
}

/** Random account-level xpub (fresh key every call). */
export function randomXpub(): string {
  return HDKey.fromMasterSeed(randomBytes(32)).derive("m/44'/60'/0'").publicExtendedKey;
}

/**
 * Merchant ready for the merchant API: signed-up owner with 2FA, an API key with the given scopes/mode,
 * and an active EVM xpub for that mode.
 */
export async function merchantWithKey(
  app: ReturnType<typeof buildApp>,
  clock: ReturnType<typeof makeClock>,
  owner: pg.Pool,
  opts: { livemode?: boolean; scopes?: string[]; name?: string } = {},
) {
  const s = await signup(app, opts.name ?? 'Shop');
  const { secret } = await enable2fa(s.agent, clock);
  const livemode = opts.livemode ?? false;
  const xpub = randomXpub();
  await owner.query(`insert into merchant_xpubs (id, merchant_id, family, livemode, xpub, key_fingerprint) values ($1, $2, 'evm', $3, $4, $5)`, [
    uuidv7(),
    s.merchantId,
    livemode,
    xpub,
    evmDeriver.keyFingerprint(xpub),
  ]);
  const mintKey = async (scopes: string[], mode = livemode) => {
    clock.advance(30_000);
    const r = await s.agent.req('POST', '/v1/dashboard/api-keys/', { name: 'k', kind: 'secret', livemode: mode, scopes }, { 'x-totp-code': totpNow(secret, clock()) });
    if (r.statusCode !== 201) throw new Error(`key creation failed: ${r.body}`);
    return r.json<{ key: string }>().key;
  };
  const key = await mintKey(opts.scopes ?? ['read', 'invoices:write']);
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}, k = key) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${k}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  return { ...s, key, xpub, secret, api, mintKey };
}

/** Inserts an admin user directly (owner connection) and returns its credentials. */
export async function createAdmin(owner: pg.Pool, deps: Deps, role = 'operator') {
  const id = uuidv7();
  const email = uniqueEmail('admin');
  const password = 'admin correct horse';
  const secret = generateTotpSecret();
  await owner.query(`insert into admin_users (id, email, password_hash, role, totp_secret_enc) values ($1, $2, $3, $4, $5)`, [
    id,
    email,
    await hashPassword(password),
    role,
    await deps.envelope.seal(secret, adminTotpAad(id)),
  ]);
  return { id, email, password, secret };
}

/** Logged-in admin console agent. `stepUp()` returns a fresh x-totp-code header (moves the clock one TOTP step). */
export async function adminAgent(t: ReturnType<typeof buildTestApp>, owner: pg.Pool, role: 'superadmin' | 'operator' | 'auditor' = 'operator') {
  const a = await createAdmin(owner, t.deps, role);
  const stepUp = () => {
    t.clock.advance(30_000);
    return { 'x-totp-code': totpNow(a.secret, t.clock()) };
  };
  const agent = new Agent(t.app, ADMIN_ORIGIN);
  const r = await agent.req('POST', '/admin/v1/auth/login', { email: a.email, password: a.password, code: stepUp()['x-totp-code'] });
  if (r.statusCode !== 200) throw new Error(`admin login failed: ${r.body}`);
  return { ...a, agent, stepUp };
}
