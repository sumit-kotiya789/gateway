import { describe, expect, it } from 'vitest';
import { LOGOS, NETWORKS, chainOf, logoUri, networkOf, tokenLabel, tokenLogo } from '../src/index.js';

describe('networks (D-112)', () => {
  it('official marks for real tokens and native coins only', () => {
    expect(tokenLogo('bsc:usdt')).toBe('USDT');
    expect(tokenLogo('eth:usdt')).toBe('USDT');
    expect(tokenLogo('polygon:usdt')).toBe('USDT');
    expect(tokenLogo('nexis:usdt')).toBeNull();
    expect(tokenLogo('bsc-testnet:usdt')).toBeNull();
    expect(tokenLogo('POL')).toBe('POL');
    expect(tokenLogo('toString')).toBeNull();
    for (const n of Object.values(NETWORKS)) expect(LOGOS[n.logo], n.id).toBeDefined();
  });

  it('names tokens by symbol and network tag', () => {
    expect(chainOf('polygon:usdt')).toBe('polygon');
    expect(chainOf('eth')).toBe('eth');
    expect(tokenLabel('bsc:usdt', 'USDT')).toBe('USDT · BEP-20');
    expect(tokenLabel('eth:usdt', 'USDT')).toBe('USDT · ERC-20');
    expect(tokenLabel('polygon:usdt', 'USDT')).toBe('USDT · Polygon');
    expect(tokenLabel('nexis:usdt', 'USDT')).toBe('USDT');
    expect(networkOf('constructor')).toBeUndefined();
    expect(NETWORKS.eth?.name).toBe('Ethereum');
    expect(NETWORKS.polygon?.standard).toBeNull();
  });

  it('logos are self-contained round SVGs with nothing active in them', () => {
    for (const [k, svg] of Object.entries(LOGOS)) {
      expect(svg, k).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 24 24">.*<\/svg>$/);
      expect(svg, k).toContain('<circle cx="12" cy="12" r="12"/>');
      expect(svg, k).not.toMatch(/<script|\bon\w+=|href=|<image|<foreignObject|<style/i);
    }
    expect(logoUri('USDT')).toMatch(/^data:image\/svg\+xml,%3Csvg/);
    expect(logoUri('USDT')).toBe(logoUri('USDT'));
  });
});
