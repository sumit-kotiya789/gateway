import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signatureHeader } from '../../src/modules/webhooks/delivery.js';
import { BlockedAddressError, isPublicAddress, resolveTarget } from '../../src/modules/webhooks/ssrf.js';

describe('webhook SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1', // mapped, hex form
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::a00:1', // NAT64 to 10.0.0.1
    '2002:a00:1::1', // 6to4 to 10.0.0.1
    '2001:db8::1',
    'not-an-ip',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it('refuses hosts resolving to private addresses unless allowed; IP literals skip DNS', async () => {
    await expect(resolveTarget('localhost', false)).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(resolveTarget('127.0.0.1', false)).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(resolveTarget('[::1]', false)).rejects.toBeInstanceOf(BlockedAddressError);
    expect(await resolveTarget('127.0.0.1', true)).toEqual({ address: '127.0.0.1', family: 4 });
    expect(await resolveTarget('[::1]', true)).toEqual({ address: '::1', family: 6 });
    expect(await resolveTarget('8.8.8.8', false)).toEqual({ address: '8.8.8.8', family: 4 });
  });
});

describe('webhook signature', () => {
  it('signs "<t>.<body>" with each secret', () => {
    const body = '{"id":"evt"}';
    const mac = (k: string) => createHmac('sha256', k).update(`1700000000.${body}`).digest('hex');
    expect(signatureHeader(['whsec_a'], 1_700_000_000, body)).toBe(`t=1700000000,v1=${mac('whsec_a')}`);
    expect(signatureHeader(['whsec_a', 'whsec_b'], 1_700_000_000, body)).toBe(`t=1700000000,v1=${mac('whsec_a')},v1=${mac('whsec_b')}`);
  });
});
