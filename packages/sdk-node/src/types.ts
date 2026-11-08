// Response shapes of the merchant API (see GET /v1/openapi.json). Amounts are decimal strings in token units.

export type InvoiceStatus =
  | 'created' | 'pending' | 'detected' | 'confirming' | 'paid' | 'underpaid' | 'overpaid' | 'settled' | 'expired' | 'cancelled' | 'failed' | 'late_payment' | 'held'
  | 'partially_paid';

export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface Invoice {
  id: string;
  object: 'invoice';
  status: InvoiceStatus;
  livemode: boolean;
  amount: string;
  amount_received: string;
  token: string;
  symbol: string;
  chain: string;
  network: string;
  deposit_address: string;
  payment_uri: string | null;
  /** null for deposits (D-101). */
  checkout_url: string | null;
  /** payment: an invoice you created; deposit: one transfer to a user's permanent address (D-101). */
  kind: 'payment' | 'deposit';
  /** Deposits: the account and your user id. */
  deposit_account_id: string | null;
  customer_ref: string | null;
  external_order_id: string | null;
  description: string | null;
  metadata: Record<string, string>;
  success_url: string | null;
  cancel_url: string | null;
  payment_link_id: string | null;
  /** Marketplace seller this invoice was made for, if any. */
  sub_merchant_id: string | null;
  expires_at: string;
  status_changed_at: string;
  created_at: string;
  payments?: { tx_hash: string; log_index: number; from: string; amount: string; status: string; block_number: string }[];
}

export interface CreateInvoiceParams {
  amount: string;
  token: string;
  external_order_id?: string;
  description?: string;
  metadata?: Record<string, string>;
  expires_in?: number;
  success_url?: string;
  cancel_url?: string;
  /** Marketplace seller id (an active sub-merchant of the same mode). */
  sub_merchant?: string;
}

export interface ListInvoicesParams {
  limit?: number;
  starting_after?: string;
  status?: InvoiceStatus;
  external_order_id?: string;
  sub_merchant?: string;
}

/** Marketplace seller (sub-account). Its invoices pay into your wallet; `totals` only on retrieve. */
export interface SubMerchant {
  id: string;
  object: 'sub_merchant';
  livemode: boolean;
  name: string;
  reference: string | null;
  active: boolean;
  metadata: Record<string, string>;
  created_at: string;
  totals?: { token: string; symbol: string; invoices: number; received: string }[];
}

export interface PaymentLink {
  id: string;
  object: 'payment_link';
  url: string;
  active: boolean;
  amount: string;
  token: string;
  [key: string]: unknown;
}

export interface Balance {
  token: string;
  symbol: string | null;
  received: string;
  fees_owed: string;
  fees_charged: string;
  prepaid_fees: string;
  fee_status: 'ok' | 'low' | 'blocked' | 'not_enforced';
}

export interface GatewayEvent {
  id: string;
  object: 'event';
  type: string;
  livemode: boolean;
  created_at: string;
  data: {
    invoice_id: string;
    status: InvoiceStatus;
    previous_status: InvoiceStatus;
    token: string;
    amount_expected: string;
    amount_received: string;
    fee_amount: string | null;
    external_order_id: string | null;
    sub_merchant_id: string | null;
    /** payment or deposit (D-101); deposits name your user. */
    kind?: 'payment' | 'deposit';
    deposit_account_id?: string | null;
    customer_ref?: string | null;
    reason: string;
  };
}

/** A user's permanent deposit address for one token (D-101). */
export interface DepositAccount {
  id: string;
  object: 'deposit_account';
  livemode: boolean;
  customer_ref: string;
  token: string;
  symbol: string;
  chain: string;
  address: string;
  custody_mode: 'custodial' | 'non_custodial_xpub' | 'non_custodial_forwarder';
  /** Confirmed deposits so far, token units. */
  received: string;
  retired_at: string | null;
  created_at: string;
  /** retrieve() only, newest first. */
  deposits?: { invoice_id: string; status: InvoiceStatus; amount: string; fee: string | null; deposit_ref: string; created_at: string }[];
}

export type PayoutStatus = 'approved' | 'sent' | 'confirmed' | 'failed';

/** A payout to one of your users (custody on, D-100). */
export interface Payout {
  id: string;
  object: 'payout';
  livemode: boolean;
  kind: 'customer';
  customer_ref: string;
  status: PayoutStatus;
  token: string;
  symbol: string;
  amount: string;
  /** The flat payout fee, charged on top of the amount. */
  fee: string;
  to_address: string;
  tx_hash: string | null;
  reason: string | null;
  created_at: string;
  confirmed_at: string | null;
}

