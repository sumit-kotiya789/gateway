import { networkOf, tokenLogo } from '@gw/networks';
import { describe, expect, it } from 'vitest';
import { registrySeed } from '../../src/db/seed-registry.js';

describe('registry seed data', () => {
  it('base seed: BSC testnet is the test network (D-096); mainnet off until launch; Nexis retired', () => {
    const s = registrySeed({});
    expect(s.chains.map((c) => [c.id, c.enabled])).toEqual([
      ['bsc', false],
      ['eth', false],
      ['polygon', false],
      ['bsc-testnet', true],
      ['nexis', false],
    ]);
    expect(s.tokens.map((t) => t.id)).toEqual(['bsc:usdt', 'eth:usdt', 'polygon:usdt', 'nexis:usdt']);
    expect(s.tokens[0]).toMatchObject({ contractAddress: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 });
  });

  it('Ethereum and Polygon PoS (D-112): mainnets, seeded off, official Tether contracts with 6 decimals', () => {
    const s = registrySeed({});
    expect(s.chains.find((c) => c.id === 'eth')).toMatchObject({
      family: 'evm',
      evmChainId: 1,
      testnet: false,
      enabled: false,
      nativeSymbol: 'ETH',
      finality: 'tag',
      explorerUrl: 'https://etherscan.io',
    });
    expect(s.chains.find((c) => c.id === 'polygon')).toMatchObject({
      family: 'evm',
      evmChainId: 137,
      testnet: false,
      enabled: false,
      nativeSymbol: 'POL',
      finality: 'tag',
      reorgDepth: 128,
      explorerUrl: 'https://polygonscan.com',
    });
    expect(s.tokens.find((t) => t.id === 'eth:usdt')).toMatchObject({ chainId: 'eth', symbol: 'USDT', contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, minAmount: 10_000n });
    expect(s.tokens.find((t) => t.id === 'polygon:usdt')).toMatchObject({ chainId: 'polygon', symbol: 'USDT', contractAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, minAmount: 10_000n });
    expect(s.tokens.find((t) => t.id === 'polygon:usdt')?.confirmationTiers).toEqual([
      { min_amount: (10_000n * 10n ** 6n).toString(), confirmations: 128 },
      { min_amount: (100_000n * 10n ** 6n).toString(), confirmations: 256 },
    ]);
    // Mainnet RPCs: the operator's provider first, then independent witnesses (confirmation quorum).
    for (const id of ['eth', 'polygon']) expect(s.chains.find((c) => c.id === id)?.rpcUrls.length).toBeGreaterThanOrEqual(3);
  });

  it('every mainnet chain has an official name, tag and logo; every mainnet token the official mark (D-112)', () => {
    const s = registrySeed({});
    for (const c of s.chains.filter((x) => !x.testnet)) expect(networkOf(c.id)?.native, c.id).toBe(c.nativeSymbol);
    for (const t of s.tokens.filter((x) => s.chains.find((c) => c.id === x.chainId)?.testnet === false)) expect(tokenLogo(t.id), t.id).toBe('USDT');
  });

  it('Nexis is a test chain (test keys only) with its mock USDT', () => {
    const s = registrySeed({});
    expect(s.chains.find((c) => c.id === 'nexis')).toMatchObject({ family: 'evm', evmChainId: 5567, testnet: true, nativeSymbol: 'NXC' });
    expect(s.tokens.find((t) => t.id === 'nexis:usdt')).toMatchObject({
      chainId: 'nexis',
      contractAddress: '0x3FF21b3856Cf144747C9e12262aab690820515f1',
      decimals: 18,
    });
  });

  it('testnet sastaUSDT only when its deployed mock address is configured', () => {
    const s = registrySeed({ BSC_TESTNET_USDT_ADDRESS: '0x0000000000000000000000000000000000000001' });
    expect(s.chains.find((c) => c.id === 'bsc-testnet')).toMatchObject({ evmChainId: 97, testnet: true });
    expect(s.tokens.find((t) => t.id === 'bsc-testnet:usdt')).toMatchObject({
      chainId: 'bsc-testnet',
      symbol: 'sastaUSDT',
      contractAddress: '0x0000000000000000000000000000000000000001',
      decimals: 18,
    });
  });

  it('local chain needs its RPC; local token needs both RPC and address', () => {
    expect(registrySeed({ EVM_LOCAL_USDT_ADDRESS: '0x01' }).chains.some((c) => c.id === 'evm-local')).toBe(false);
    const s = registrySeed({ EVM_LOCAL_RPC_URL: 'http://x', EVM_LOCAL_USDT_ADDRESS: '0x0000000000000000000000000000000000000002' });
    expect(s.chains.find((c) => c.id === 'evm-local')).toMatchObject({ evmChainId: 31337, testnet: true });
    expect(s.tokens.some((t) => t.id === 'evm-local:usdt')).toBe(true);
    expect(registrySeed({ EVM_LOCAL_RPC_URL: 'http://x' }).tokens.some((t) => t.id === 'evm-local:usdt')).toBe(false);
  });

  it('forwarder factories (D-097) come from env, per chain; a malformed one is refused', () => {
    expect(registrySeed({}).chains.map((c) => c.forwarderFactory ?? null)).toEqual([null, null, null, null, null]);
    const f = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    const s = registrySeed({ BSC_TESTNET_FORWARDER_FACTORY: f, BSC_FORWARDER_FACTORY: ' ', POLYGON_FORWARDER_FACTORY: f, EVM_LOCAL_RPC_URL: 'http://x', EVM_LOCAL_FORWARDER_FACTORY: f });
    expect(Object.fromEntries(s.chains.map((c) => [c.id, c.forwarderFactory ?? null]))).toEqual({ bsc: null, eth: null, polygon: f, 'bsc-testnet': f, nexis: null, 'evm-local': f });
    expect(() => registrySeed({ BSC_TESTNET_FORWARDER_FACTORY: '0x1234' })).toThrow(/BSC_TESTNET_FORWARDER_FACTORY is not an address/);
  });

  it('tiers are minor-unit strings: 10k USDT -> 30 conf, 100k -> 60', () => {
    const tiers = registrySeed({}).tokens[0]?.confirmationTiers as { min_amount: string; confirmations: number }[];
    expect(tiers).toEqual([
      { min_amount: (10_000n * 10n ** 18n).toString(), confirmations: 30 },
      { min_amount: (100_000n * 10n ** 18n).toString(), confirmations: 60 },
    ]);
  });
});
