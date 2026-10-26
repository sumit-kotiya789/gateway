// Response shapes of the merchant API (see GET /v1/openapi.json). Amounts are decimal strings in token units.

export type InvoiceStatus =
  | 'created' | 'pending' | 'detected' | 'confirming' | 'paid' | 'underpaid' | 'overpaid' | 'settled' | 'expired' | 'cancelled' | 'failed' | 'late_payment';

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
  checkout_url: string;
  external_order_id: string | null;
  description: string | null;
  metadata: Record<string, string>;
  success_url: string | null;
  cancel_url: string | null;
  payment_link_id: string | null;
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
}

export interface ListInvoicesParams {
  limit?: number;
  starting_after?: string;
  status?: InvoiceStatus;
  external_order_id?: string;
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
    reason: string;
  };
}
