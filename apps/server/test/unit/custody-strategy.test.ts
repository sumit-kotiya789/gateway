import type { ChainConfig, CustodyMode } from '@gw/core';
import { describe, expect, it } from 'vitest';
import { custodialStrategy, forwarderStrategy, nonCustodialXpubStrategy, strategyFor } from '../../src/modules/custody/custody.js';

describe('strategyFor', () => {
  it('maps modes to strategies', () => {
    expect(strategyFor('non_custodial_xpub', { custodialEnabled: false })).toBe(nonCustodialXpubStrategy);
    expect(strategyFor('custodial', { custodialEnabled: true })).toBe(custodialStrategy);
    expect(strategyFor('non_custodial_forwarder', { custodialEnabled: false, forwarderEnabled: true })).toBe(forwarderStrategy);
  });

  it('forwarder mode needs the deployment flag', () => {
    expect(() => strategyFor('non_custodial_forwarder', { custodialEnabled: true })).toThrow(/not enabled/);
  });

  it('fails closed on a mode the code does not know (e.g. DB enum grew first)', () => {
    expect(() => strategyFor('escrow' as CustodyMode, { custodialEnabled: true })).toThrow(/unknown custody mode escrow/);
  });

  it('non-custodial strategies advertise no withdrawals', () => {
    expect(nonCustodialXpubStrategy.supportsWithdrawals()).toBe(false);
    expect(forwarderStrategy.supportsWithdrawals()).toBe(false);
  });
});

describe('forwarder strategy (D-097)', () => {
  const chain: ChainConfig = {
    id: 'evm-x',
    family: 'evm',
    name: 'x',
    evmChainId: 1,
    rpcUrls: [],
    explorerUrl: null,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockTimeMs: 1000,
    defaultConfirmations: 1,
    reorgDepth: 1,
    finality: 'tag',
    testnet: true,
    enabled: true,
  };
  const terms = { tokenId: 'evm-x:t', tokenContract: '0x0000000000000000000000000000000000000001', amountExpected: 1n, feeBps: 100 };
  // Both refusals happen before any database access.
  const noDb = {} as never;

  it('needs the invoice terms (the address commits to them)', async () => {
    await expect(forwarderStrategy.allocateDepositAddress(noDb, { merchantId: 'm', livemode: false, chain })).rejects.toThrow(/terms/);
  });

  it('refuses a chain without a forwarder factory', async () => {
    await expect(forwarderStrategy.allocateDepositAddress(noDb, { merchantId: 'm', livemode: false, chain, terms })).rejects.toThrow(/not available on chain evm-x/);
  });
});
