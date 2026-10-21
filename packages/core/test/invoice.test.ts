import { describe, expect, it } from 'vitest';
import {
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  IllegalTransitionError,
  assertTransition,
  canTransition,
  WATCHER_TRANSITIONS,
  classifyPayment,
  planInvoice,
  type InvoiceStatus,
  type PaymentTotals,
} from '../src/index.js';

describe('invoice state machine', () => {
  const legal: [InvoiceStatus, InvoiceStatus][] = [
    ['created', 'pending'],
    ['created', 'failed'],
    ['pending', 'detected'],
    ['pending', 'expired'],
    ['pending', 'cancelled'],
    ['detected', 'confirming'],
    ['detected', 'pending'],
    ['confirming', 'paid'],
    ['confirming', 'underpaid'],
    ['confirming', 'overpaid'],
    ['confirming', 'pending'],
    ['underpaid', 'detected'],
    ['underpaid', 'paid'],
    ['paid', 'settled'],
    ['overpaid', 'settled'],
    ['expired', 'late_payment'],
    ['cancelled', 'late_payment'],
    ['late_payment', 'paid'],
  ];

  it('allows exactly the documented transitions (all 144 pairs checked)', () => {
    const allowed = new Set(legal.map(([a, b]) => `${a}>${b}`));
    for (const from of INVOICE_STATUSES) {
      for (const to of INVOICE_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it.each([
    ['pending', 'paid'], // must pass through detection + confirmation
    ['detected', 'paid'],
    ['expired', 'paid'], // late money is never auto-fulfilled
    ['cancelled', 'pending'],
    ['settled', 'paid'],
    ['paid', 'pending'], // a paid invoice never reopens
    ['pending', 'pending'],
  ] as [InvoiceStatus, InvoiceStatus][])('rejects %s -> %s', (from, to) => {
    expect(() => {
      assertTransition(from, to);
    }).toThrow(IllegalTransitionError);
  });

  it('terminal states have no exits', () => {
    expect(INVOICE_TRANSITIONS.settled).toEqual([]);
    expect(INVOICE_TRANSITIONS.failed).toEqual([]);
  });
});

describe('classifyPayment', () => {
  const E = 25_000_000n; // 25.000000 with 6 decimals

  it.each([
    [E, 'paid'],
    [E + 1n, 'overpaid'],
    [E - 125_000n, 'paid'], // exactly 0.5% short
    [E - 125_001n, 'underpaid'],
    [0n, 'underpaid'],
  ] as [bigint, string][])('received %s -> %s (0.5% tolerance)', (received, want) => {
    expect(classifyPayment(E, received, 50)).toBe(want);
  });

  it('zero tolerance means exact or more', () => {
    expect(classifyPayment(E, E - 1n, 0)).toBe('underpaid');
    expect(classifyPayment(E, E, 0)).toBe('paid');
  });

  it('tolerance rounds down (never widens): 1 unit at 0.5% has 0 tolerance', () => {
    expect(classifyPayment(1n, 0n, 50)).toBe('underpaid');
    expect(classifyPayment(199n, 199n - 0n, 50)).toBe('paid');
    expect(classifyPayment(200n, 199n, 50)).toBe('paid'); // floor(200*50/10000) = 1
    expect(classifyPayment(199n, 198n, 50)).toBe('underpaid'); // floor(199*50/10000) = 0
  });

  it('works at 18-decimal magnitudes without precision loss', () => {
    const big = 123_456_789n * 10n ** 18n;
    expect(classifyPayment(big, big - (big * 50n) / 10_000n, 50)).toBe('paid');
    expect(classifyPayment(big, big - (big * 50n) / 10_000n - 1n, 50)).toBe('underpaid');
  });

  it('rejects invalid inputs', () => {
    expect(() => classifyPayment(0n, 0n, 50)).toThrow(RangeError);
    expect(() => classifyPayment(1n, -1n, 50)).toThrow(RangeError);
    expect(() => classifyPayment(1n, 1n, 501)).toThrow(RangeError);
    expect(() => classifyPayment(1n, 1n, 1.5)).toThrow(RangeError);
  });
});

describe('planInvoice (watcher)', () => {
  const E = 100n;
  const t = (over: Partial<PaymentTotals> = {}): PaymentTotals => ({ confirmed: 0n, outstanding: 0, outstandingMined: false, allLate: false, ...over });

  it('every watcher edge is a legal transition', () => {
    for (const [from, tos] of Object.entries(WATCHER_TRANSITIONS)) {
      for (const to of tos) expect(canTransition(from as InvoiceStatus, to)).toBe(true);
    }
  });

  it.each<[InvoiceStatus, Partial<PaymentTotals>, InvoiceStatus[]]>([
    ['pending', {}, []],
    ['pending', { outstanding: 1 }, ['detected']],
    ['pending', { outstanding: 1, outstandingMined: true }, ['detected', 'confirming']],
    ['detected', { outstanding: 1, outstandingMined: true }, ['confirming']],
    ['detected', { outstanding: 1 }, []],
    ['confirming', { outstanding: 1 }, []], // a fresh top-up while confirming does not step back
    ['confirming', { confirmed: 100n }, ['paid']],
    ['confirming', { confirmed: 99n }, ['underpaid']],
    ['confirming', { confirmed: 101n }, ['overpaid']],
    ['pending', { confirmed: 100n }, ['detected', 'confirming', 'paid']], // watcher was behind
    ['detected', {}, ['pending']], // reorged away
    ['confirming', {}, ['pending']],
    ['underpaid', { confirmed: 50n, outstanding: 1 }, ['detected']], // top-up seen
    ['underpaid', { confirmed: 100n }, ['detected', 'confirming', 'paid']], // top-up confirmed
    ['underpaid', { confirmed: 50n }, []],
    ['detected', { confirmed: 50n }, ['confirming', 'underpaid']], // top-up reorged away
    ['expired', { outstanding: 1 }, []], // late funds wait for confirmation
    ['expired', { confirmed: 100n }, ['late_payment']],
    ['cancelled', { confirmed: 1n }, ['late_payment']],
    ['pending', { outstanding: 1, allLate: true }, ['expired']],
    ['pending', { confirmed: 100n, allLate: true }, ['expired', 'late_payment']],
    ['paid', { confirmed: 300n }, []], // extra funds after paid: recorded only
    ['late_payment', { confirmed: 300n }, []],
    ['settled', { outstanding: 2 }, []],
  ])('case %# from %s', (status, over, path) => {
    expect(planInvoice(status, E, 50, t(over))).toEqual(path);
  });

  it('never uses the manual underpaid -> paid shortcut', () => {
    expect(planInvoice('underpaid', E, 0, t({ confirmed: 100n }))).not.toEqual(['paid']);
  });
});
