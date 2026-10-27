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
  expires_at: string;
  created_at: string;
  merchant_id: string;
  merchant_name?: string;
  fee_amount?: string | null;
  history?: { from: string | null; to: string; reason: string; at: string }[];
  payments?: { tx_hash: string; from: string; amount: string; status: string; block_number: string; block_time: string }[];
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
