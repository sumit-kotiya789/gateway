// Admin console API client. Same origin as /admin/v1 (D-029); state-changing calls echo the admin CSRF cookie.
// No refresh tokens for admins (D-032): any 401 means "sign in again".

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BASE = '/admin/v1';
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith('gw_admin_csrf='))
    ?.slice('gw_admin_csrf='.length);
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

function errorMessage(b: ErrorBody | null, status: number): string {
  const e = b?.error;
  const first = Array.isArray(e?.details) ? (e.details[0] as { path?: string; message?: string } | undefined) : undefined;
  if (first?.message) return first.path ? `${first.path}: ${first.message}` : first.message;
  return e?.message ?? `request failed (${String(status)})`;
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const csrf = method === 'GET' ? undefined : csrfToken();
  if (csrf) h['x-csrf-token'] = csrf;
  const res = await fetch(BASE + path, { method, headers: h, credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (res.status === 401 && path !== '/auth/login') onUnauthorized();
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, (data as ErrorBody | null)?.error?.code ?? 'error', errorMessage(data as ErrorBody | null, res.status));
  return data as T;
}

export const totpHeader = (code: string) => ({ 'x-totp-code': code.trim() });

// ---------------------------------------------------------------- response shapes

export type AdminRole = 'superadmin' | 'operator' | 'auditor';
export interface Admin {
  id: string;
  role: AdminRole;
}

export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export const RISK_FLAGS = ['under_review', 'high_risk', 'payouts_frozen'] as const;

export interface Merchant {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  custody_mode: string;
  fee_bps: number;
  fee_fixed: string;
  fee_grace: string;
  payout_fee: string;
  underpay_tolerance_bps: number;
  risk_flags: string[];
  created_at: string;
}

export interface MerchantDetail extends Merchant {
  users: { id: string; email: string; role: string; totp_enabled: boolean; locked_until: string | null; created_at: string }[];
  balances: {
    livemode: boolean;
    data: { token: string; symbol: string | null; received: string; fees_charged: string; prepaid_fees: string; fee_status: string }[];
  }[];
}

export interface FeeTopup {
  id: string;
  livemode: boolean;
  token: string;
  symbol: string | null;
  amount: string;
  reference: string;
  created_at: string;
}

export interface Invoice {
  id: string;
  status: string;
  livemode: boolean;
  custody_mode: string;
  amount: string;
  amount_received: string;
  symbol: string;
  network: string;
  deposit_address: string;
  external_order_id: string | null;
  sub_merchant_id?: string | null;
  expires_at: string;
  created_at: string;
  merchant_id: string;
  merchant_name?: string;
  fee_amount?: string | null;
  history?: { from: string | null; to: string; reason: string; at: string }[];
  payments?: { tx_hash: string; from: string; amount: string; status: string; block_number: string; block_time: string }[];
}

/** Console settings (D-106, D-107): the one place to manage platform behaviour. */
export interface AdminSettings {
  attention_statuses: ('late_payment' | 'underpaid' | 'held')[];
  session_idle_minutes: number;
  session_max_hours: number;
  ip_allowlist_enabled: boolean;
  ip_allowlist: { cidr: string; label: string }[];
  /** The caller's address as the server sees it: what the allowlist is checked against. */
  request_ip: string;
  /** Whole token units; null = the server ceiling. */
  withdrawal_two_person_min: string | null;
  withdrawal_two_person_effective: string;
  signup_enabled: boolean;
  merchant_defaults: { fee_bps: number; fee_fixed: string; fee_grace: string; payout_fee: string; underpay_tolerance_bps: number };
  /** Merchant whitelists (D-109): hours until a new live payout address works, and until a switch-off applies. */
  whitelist_activation_hours: number;
  whitelist_disable_hours: number;
  updated_by: string | null;
  updated_at: string | null;
  /** Outer limits from the server environment; the console works inside them. */
  platform: { withdrawal_two_person_max: string; signup_allowed: boolean; admin_ip_allowlist_env: number };
}

export interface Registry {
  chains: { id: string; name: string; family: string; testnet: boolean; enabled: boolean }[];
  tokens: { id: string; chain_id: string; symbol: string; name: string; enabled: boolean }[];
}

export interface AuditRow {
  seq: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  merchant_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  before: unknown;
  after: unknown;
}

export interface AdminAccount {
  id: string;
  email: string;
  role: AdminRole;
  disabled: boolean;
  disabled_at: string | null;
  locked_until: string | null;
  created_at: string;
}

/** Returned once by create and reset-credentials: hand over out of band, never stored. */
export interface AdminCredentials extends AdminAccount {
  password: string;
  totp_uri: string;
  qr_svg: string;
}

/** Forwarder flush (D-097). */
export interface Forward {
  id: string;
  merchant_id: string;
  invoice_id: string;
  livemode: boolean;
  chain: string;
  token: string;
  symbol: string;
  forwarder_address: string;
  amount: string;
  to_merchant: string | null;
  fee: string | null;
  status: string;
  tx_hash: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  confirmed_at: string | null;
}

export interface CustodyOverview {
  custodial_enabled: boolean;
  forwarder_enabled: boolean;
  signer: { paused: boolean; reason: string | null; updated_at: string | null };
  wallets: { livemode: boolean; family: string; kind: 'hot' | 'gas' | 'cold' | 'fee'; address: string; derivation_path: string | null }[];
  balances: Record<string, string | boolean | null>[];
  open_sweeps: number;
  forwards: { open: number; failed_24h: number };
  withdrawals: Partial<Record<'pending_approval' | 'approved' | 'sent', number>>;
}

/** Hot wallet policy per mode and token (D-105). Amounts in token units; null = off. */
export interface HotWalletPolicy {
  livemode: boolean;
  token: string;
  symbol: string;
  state: 'low' | 'above_cap' | 'ok' | null;
  max_balance: string | null;
  low_balance: string | null;
  hot_address: string | null;
  last_balance: string | null;
  last_checked_at: string | null;
  low_alert_at: string | null;
  updated_by: string;
  updated_at: string;
}

export interface TreasuryTransfer {
  id: string;
  livemode: boolean;
  token: string;
  direction: 'to_cold' | 'to_hot';
  /** Created by the hot wallet policy (D-105), not proposed by an admin. */
  auto: boolean;
  amount: string;
  cold_address: string;
  hot_address: string;
  status: string;
  requested_by: string;
  approved_by: string | null;
  reason: string;
  tx_hash: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AdminWithdrawal {
  id: string;
  livemode: boolean;
  status: string;
  /** merchant: to its own payout address; customer: a payout to one of its users (D-100). */
  kind: 'merchant' | 'customer';
  customer_ref: string | null;
  token: string;
  symbol: string;
  amount: string;
  fee: string;
  to_address: string;
  approvals_required: number;
  approvals: number;
  approved_by: string[];
  merchant_id: string;
  merchant_name: string;
  requested_by: string;
  last_error: string | null;
  tx_hash: string | null;
  created_at: string;
}
