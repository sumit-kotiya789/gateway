// MONEY-CRITICAL
// Invoice lifecycle. Every status change in the system goes through `assertTransition`; the database enforces the
// same table with a trigger (see migration *_invoices_security.sql). Keep both in sync: a test compares them.

export const INVOICE_STATUSES = [
  'created',
  'pending',
  'detected',
  'confirming',
  'paid',
  'underpaid',
  'overpaid',
  'settled',
  'expired',
  'cancelled',
  'failed',
  'late_payment',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  created: ['pending', 'failed'],
  pending: ['detected', 'expired', 'cancelled'],
  // Back to pending = the only transfer was reorged away before confirmation.
  detected: ['confirming', 'pending'],
  confirming: ['paid', 'underpaid', 'overpaid', 'pending'],
  // Top-up seen (detected), or merchant accepts the shortfall (paid).
  underpaid: ['detected', 'paid'],
  paid: ['settled'],
  overpaid: ['settled'],
  // Funds arriving after expiry/cancel are recorded, never auto-fulfilled.
  expired: ['late_payment'],
  cancelled: ['late_payment'],
  // Manual resolution only (admin / merchant decision).
  late_payment: ['paid'],
  settled: [],
  failed: [],
};

/** Statuses in which funds sent to the deposit address are still expected. */
export const OPEN_STATUSES: readonly InvoiceStatus[] = ['pending', 'detected', 'confirming', 'underpaid'];

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: InvoiceStatus,
    readonly to: InvoiceStatus,
  ) {
    super(`illegal invoice transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export const DEFAULT_UNDERPAY_TOLERANCE_BPS = 50; // 0.5%
export const MAX_UNDERPAY_TOLERANCE_BPS = 500; // 5%

/**
 * Classifies a confirmed total against the expected amount. Integer math only.
 * Tolerance = floor(expected * bps / 10000): rounding never widens the tolerance.
 *   received >  expected                    -> overpaid (full amount credited, flagged, refundable)
 *   expected - tolerance <= received <= exp -> paid
 *   received <  expected - tolerance        -> underpaid
 */
export function classifyPayment(expected: bigint, received: bigint, toleranceBps: number): 'paid' | 'underpaid' | 'overpaid' {
  if (expected <= 0n) throw new RangeError('expected amount must be positive');
  if (received < 0n) throw new RangeError('received amount cannot be negative');
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > MAX_UNDERPAY_TOLERANCE_BPS) {
    throw new RangeError(`tolerance must be an integer in [0, ${MAX_UNDERPAY_TOLERANCE_BPS}] bps`);
  }
  if (received > expected) return 'overpaid';
  const tolerance = (expected * BigInt(toleranceBps)) / 10_000n;
  return received >= expected - tolerance ? 'paid' : 'underpaid';
}

/** On-chain payment state of one invoice, as the watcher sees it (orphaned payments excluded). */
export interface PaymentTotals {
  /** Sum of confirmed payments, minor units. Never decreases. */
  confirmed: bigint;
  /** Payments seen but not yet confirmed. */
  outstanding: number;
  /** Some outstanding payment already has at least one confirmation. */
  outstandingMined: boolean;
  /** There are payments and every one is in a block timestamped after the invoice's expiry. */
  allLate: boolean;
}

/**
 * Edges the watcher may take on its own. Manual edges are excluded on purpose: underpaid -> paid (merchant accepts the
 * shortfall) and late_payment -> paid (manual resolution) must never happen automatically.
 */
export const WATCHER_TRANSITIONS: Readonly<Partial<Record<InvoiceStatus, readonly InvoiceStatus[]>>> = {
  pending: ['detected', 'expired'],
  detected: ['confirming', 'pending'],
  confirming: ['paid', 'underpaid', 'overpaid', 'pending'],
  underpaid: ['detected'],
  expired: ['late_payment'],
  cancelled: ['late_payment'],
};

function watcherTarget(status: InvoiceStatus, expected: bigint, toleranceBps: number, t: PaymentTotals): InvoiceStatus {
  // Funds after expiry/cancel are recorded once confirmed, never auto-fulfilled.
  if (status === 'expired' || status === 'cancelled') return t.confirmed > 0n ? 'late_payment' : status;
  if (!OPEN_STATUSES.includes(status)) return status; // paid, overpaid, settled, late_payment, failed: watcher only records
  if (t.outstanding > 0) return t.outstandingMined || status === 'confirming' ? 'confirming' : 'detected';
  if (t.confirmed === 0n) return 'pending'; // everything seen was reorged away
  return classifyPayment(expected, t.confirmed, toleranceBps);
}

function watcherPath(from: InvoiceStatus, to: InvoiceStatus): InvoiceStatus[] {
  if (from === to) return [];
  const prev = new Map<InvoiceStatus, InvoiceStatus>();
  const queue: InvoiceStatus[] = [from];
  while (queue.length > 0) {
    const s = queue.shift() as InvoiceStatus;
    for (const n of WATCHER_TRANSITIONS[s] ?? []) {
      if (n === from || prev.has(n)) continue;
      prev.set(n, s);
      if (n === to) {
        const path: InvoiceStatus[] = [];
        for (let c: InvoiceStatus | undefined = to; c !== undefined && c !== from; c = prev.get(c)) path.unshift(c);
        return path;
      }
      queue.push(n);
    }
  }
  throw new IllegalTransitionError(from, to);
}

/**
 * The ordered status changes that bring an invoice in line with its payments. Empty = nothing to do.
 * A pending invoice whose only payments arrived after its deadline is expired first, so they end up as late_payment.
 */
export function planInvoice(status: InvoiceStatus, expected: bigint, toleranceBps: number, t: PaymentTotals): InvoiceStatus[] {
  const seen = t.outstanding > 0 || t.confirmed > 0n;
  if (status === 'pending' && seen && t.allLate) return ['expired', ...watcherPath('expired', watcherTarget('expired', expected, toleranceBps, t))];
  return watcherPath(status, watcherTarget(status, expected, toleranceBps, t));
}
