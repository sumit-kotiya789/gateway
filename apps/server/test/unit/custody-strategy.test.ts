import type { CustodyMode } from '@gw/core';
import { describe, expect, it } from 'vitest';
import { custodialStrategy, nonCustodialXpubStrategy, strategyFor } from '../../src/modules/custody/custody.js';

describe('strategyFor', () => {
  it('maps modes to strategies', () => {
    expect(strategyFor('non_custodial_xpub', { custodialEnabled: false })).toBe(nonCustodialXpubStrategy);
    expect(strategyFor('custodial', { custodialEnabled: true })).toBe(custodialStrategy);
  });

  it('fails closed on a mode the code does not know (e.g. DB enum grew first)', () => {
    expect(() => strategyFor('escrow' as CustodyMode, { custodialEnabled: true })).toThrow(/unknown custody mode escrow/);
  });

  it('non-custodial strategy advertises no withdrawals', () => {
    expect(nonCustodialXpubStrategy.supportsWithdrawals()).toBe(false);
  });
});
