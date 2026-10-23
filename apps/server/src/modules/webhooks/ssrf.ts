// SSRF guard for outbound webhooks. The URL's host is resolved once, every resolved address must be public, and the
// request then connects to that exact address (no second lookup, so DNS rebinding cannot swap in a private one).
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Non-public ranges (IANA special-purpose registries). Anything here is refused unless private networks are allowed.
// Separate lists per family: a BlockList holding ::ffff:0:0/96 matches every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  BLOCKED_V4.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96], // IPv4-mapped in hex form; the dotted form is unwrapped and checked as IPv4
  ['64:ff9b::', 96], // NAT64 can reach any IPv4, private included
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23], // IETF special purpose, incl. Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds arbitrary IPv4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(net, bits, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(ip);
  if (family === 4) return !BLOCKED_V4.check(ip, 'ipv4');
  if (family === 6) return !BLOCKED_V6.check(ip, 'ipv6');
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} resolves to a non-public address`);
    this.name = 'BlockedAddressError';
  }
}

/** Resolves `host` and returns the address to connect to. Refuses if ANY resolved address is non-public. */
export async function resolveTarget(host: string, allowPrivate: boolean): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.replace(/^\[|\]$/g, ''); // IPv6 literal in a URL
  const addrs = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await lookup(bare, { all: true, order: 'verbatim' });
  const first = addrs[0];
  if (!first) throw new Error(`${host} did not resolve`);
  if (!allowPrivate && addrs.some((a) => !isPublicAddress(a.address))) throw new BlockedAddressError(host);
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
