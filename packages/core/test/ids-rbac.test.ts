import { describe, expect, it } from 'vitest';
import { MERCHANT_ROLES, UUID_RE, adminCan, roleCan, uuidv7 } from '../src/index.js';

describe('uuidv7', () => {
  it('has v7 version and RFC variant bits', () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('encodes the timestamp in the first 48 bits and sorts by time', () => {
    const t = 1_700_000_000_000;
    expect(parseInt(uuidv7(t).replace(/-/g, '').slice(0, 12), 16)).toBe(t);
    expect(uuidv7(t) < uuidv7(t + 1)).toBe(true);
  });

  it('is unique', () => {
    const s = new Set(Array.from({ length: 10_000 }, () => uuidv7(0)));
    expect(s.size).toBe(10_000);
  });
});

describe('rbac', () => {
  // Matrix is the spec: changing a grant must change this table.
  const expected: Record<string, string[]> = {
    'api_keys:write': ['owner', 'admin', 'developer'],
    'custody:manage': ['owner'],
    'payouts:manage': ['owner'],
    'withdrawals:request': ['owner', 'finance'],
    'audit:read': ['owner', 'admin'],
    'invoices:read': [...MERCHANT_ROLES],
  };

  it.each(Object.entries(expected))('%s granted exactly to %j', (perm, roles) => {
    for (const r of MERCHANT_ROLES) {
      expect(roleCan(r, perm as Parameters<typeof roleCan>[1])).toBe(roles.includes(r));
    }
  });

  it('read_only cannot write anything', () => {
    for (const p of ['invoices:write', 'api_keys:write', 'webhooks:manage', 'refunds:write', 'team:manage'] as const) {
      expect(roleCan('read_only', p)).toBe(false);
    }
  });

  it('admin roles', () => {
    expect(adminCan('auditor', 'audit:read')).toBe(true);
    expect(adminCan('auditor', 'kill_switch:manage')).toBe(false);
    expect(adminCan('operator', 'admins:manage')).toBe(false);
    expect(adminCan('superadmin', 'admins:manage')).toBe(true);
    expect(adminCan('operator', 'invoices:resolve')).toBe(true);
    expect(adminCan('auditor', 'invoices:resolve')).toBe(false);
    expect(adminCan('operator', 'registry:enable')).toBe(false);
    expect(adminCan('superadmin', 'registry:enable')).toBe(true);
  });
});
