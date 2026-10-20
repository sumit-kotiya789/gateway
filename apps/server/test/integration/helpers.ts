import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/common/config.js';
import { Envelope, LocalKek } from '../../src/common/crypto/envelope.js';
import { base32Decode, currentStep, totpAt } from '../../src/common/crypto/totp.js';
import { createDb } from '../../src/common/db.js';
import { createLogger } from '../../src/common/logger.js';
import type { Deps } from '../../src/deps.js';

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
  };
  const app = buildApp(createLogger('silent'), deps);
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

  async req(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
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
