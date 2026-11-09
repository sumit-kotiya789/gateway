import { describe, expect, it } from 'vitest';
import { canonicalUnits, compareUnits, effectiveTwoPersonMin, type AdminSettings } from '../../src/modules/admin/settings.js';
import { validIpEntry } from '../../src/modules/auth/guards.js';

const settings = (withdrawalTwoPersonMin: string | null) => ({ withdrawalTwoPersonMin }) as AdminSettings;

describe('console settings helpers (D-107)', () => {
  it('compareUnits is exact on decimals of any length', () => {
    expect(compareUnits('40', '100')).toBe(-1);
    expect(compareUnits('100', '100.0')).toBe(0);
    expect(compareUnits('100.000001', '100')).toBe(1);
    expect(compareUnits('99999999999999999999', '99999999999999999998.9')).toBe(1);
  });

  it('the two-admin threshold never goes above the server ceiling', () => {
    expect(effectiveTwoPersonMin(settings(null), '10000')).toBe('10000');
    expect(effectiveTwoPersonMin(settings('5000'), '10000')).toBe('5000');
    expect(effectiveTwoPersonMin(settings('10000'), '10000')).toBe('10000');
    // The env ceiling was lowered after the console value was saved: the ceiling wins.
    expect(effectiveTwoPersonMin(settings('5000'), '2500.5')).toBe('2500.5');
  });

  it('canonical units and allowlist entries', () => {
    expect(canonicalUnits('0.500000')).toBe('0.5');
    expect(canonicalUnits('10.000000')).toBe('10');
    expect(canonicalUnits('7')).toBe('7');
    for (const ok of ['203.0.113.7', '203.0.113.0/24', '0.0.0.0/0', '2001:db8::/32', '::1']) expect(validIpEntry(ok)).toBe(true);
    for (const bad of ['', 'x', '10.0.0.0/33', '10.0.0.1/8/1', '10.0.0.0/', '::1/129', '10.0.0.0/a', '300.1.1.1']) expect(validIpEntry(bad)).toBe(false);
  });
});
