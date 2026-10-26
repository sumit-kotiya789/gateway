import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/common/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'j'.repeat(32),
  ADMIN_JWT_SECRET: 'a'.repeat(32),
  API_KEY_PEPPER: 'p'.repeat(32),
  DATA_KEK: Buffer.alloc(32, 1).toString('base64'),
};

function issues(env: Record<string, string>): string {
  try {
    loadConfig(env);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ NODE_ENV: 'development', PORT: 3000, TRUST_PROXY_HOPS: 0, FEATURE_CUSTODIAL: false, SIGNUP_ENABLED: true });
    expect(c.DASHBOARD_ORIGINS).toEqual([]);
  });

  it('coerces and validates PORT', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).PORT).toBe(8080);
    expect(issues({ ...base, PORT: '70000' })).toMatch(/PORT/);
  });

  it('requires every secret and fails fast without echoing values', () => {
    const msg = issues({ ...base, JWT_SECRET: 'short-secret-value' });
    expect(msg).toContain('JWT_SECRET');
    expect(msg).not.toContain('short-secret-value');
    for (const k of Object.keys(base)) {
      const env = Object.fromEntries(Object.entries(base).filter(([key]) => key !== k));
      expect(issues(env)).toContain(k);
    }
  });

  it('DATA_KEK must be 32 bytes', () => {
    expect(issues({ ...base, DATA_KEK: Buffer.alloc(16).toString('base64') })).toContain('DATA_KEK');
  });

  it('admin and dashboard JWT secrets must differ', () => {
    expect(issues({ ...base, ADMIN_JWT_SECRET: base.JWT_SECRET })).toContain('ADMIN_JWT_SECRET');
  });

  it('parses origin and IP lists', () => {
    const c = loadConfig({ ...base, DASHBOARD_ORIGINS: 'http://a.test, http://b.test', ADMIN_IP_ALLOWLIST: '10.0.0.0/8,127.0.0.1' });
    expect(c.DASHBOARD_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(c.ADMIN_IP_ALLOWLIST).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(issues({ ...base, ADMIN_IP_ALLOWLIST: 'not-an-ip' })).toContain('ADMIN_IP_ALLOWLIST');
  });

  it('production requires https origins and a separate admin origin', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(issues({ ...prod, DASHBOARD_ORIGINS: 'http://a.test' })).toContain('DASHBOARD_ORIGINS');
    expect(issues({ ...prod, DASHBOARD_ORIGINS: 'https://a.test', ADMIN_ORIGINS: 'https://a.test' })).toContain('ADMIN_ORIGINS');
    const ok = {
      ...prod,
      DASHBOARD_ORIGINS: 'https://a.test',
      ADMIN_ORIGINS: 'https://admin.a.test',
      PUBLIC_BASE_URL: 'https://pay.a.test/',
      SMTP_URL: 'smtps://user:pass@smtp.a.test:465',
      DASHBOARD_URL: 'https://a.test/',
    };
    expect(issues(ok)).toBe('');
    expect(loadConfig(ok).PUBLIC_BASE_URL).toBe('https://pay.a.test'); // trailing slash trimmed
    expect(issues({ ...ok, PUBLIC_BASE_URL: 'http://pay.a.test' })).toContain('PUBLIC_BASE_URL');
    expect(issues({ ...ok, WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' })).toContain('WEBHOOK_ALLOW_PRIVATE_NETWORKS');
    expect(issues({ ...ok, SMTP_URL: '' })).toContain('SMTP_URL');
    expect(issues({ ...ok, DASHBOARD_URL: 'https://other.test' })).toContain('DASHBOARD_URL'); // not a dashboard origin
    expect(loadConfig(ok).DASHBOARD_URL).toBe('https://a.test');
  });

  it('custodial feature flag is off unless explicitly enabled', () => {
    expect(loadConfig(base).FEATURE_CUSTODIAL).toBe(false);
    expect(loadConfig({ ...base, FEATURE_CUSTODIAL: 'true' }).FEATURE_CUSTODIAL).toBe(true);
  });
});
