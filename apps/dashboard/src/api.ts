// Dashboard API client. Cookies carry the session (same origin, D-029); state-changing calls echo the CSRF cookie.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BASE = '/v1/dashboard';
const NO_REFRESH = /^\/auth\/(login|signup|refresh)/;
let refreshing: Promise<boolean> | null = null;

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith('gw_csrf='))
    ?.slice('gw_csrf='.length);
}

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const csrf = method === 'GET' ? undefined : csrfToken();
  if (csrf) h['x-csrf-token'] = csrf;
  return fetch(BASE + path, { method, headers: h, credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/**
 * One refresh at a time: parallel 401s must not present the same refresh token twice, because the server treats a
 * reused refresh token as theft and revokes the whole session.
 */
function refresh(): Promise<boolean> {
  refreshing ??= send('POST', '/auth/refresh')
    .then(
      (r) => r.ok,
      () => false,
    )
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
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

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  let res = await send(method, path, body, headers);
  if (res.status === 401 && !NO_REFRESH.test(path) && (await refresh())) res = await send(method, path, body, headers);
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, (data as ErrorBody | null)?.error?.code ?? 'error', errorMessage(data as ErrorBody | null, res.status));
  return data as T;
}

/** GET a file (CSV export) with the same session refresh as api(), then hand it to the browser as a download. */
export async function download(path: string): Promise<void> {
  let res = await send('GET', path);
  if (res.status === 401 && (await refresh())) res = await send('GET', path);
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as ErrorBody | null;
    throw new ApiError(res.status, data?.error?.code ?? 'error', errorMessage(data, res.status));
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export const totpHeader = (code: string) => ({ 'x-totp-code': code.trim() });

// ---------------------------------------------------------------- response shapes

export type Role = 'owner' | 'admin' | 'developer' | 'finance' | 'read_only';

export interface Me {
  user: { id: string; email: string; email_verified: boolean; role: Role; totp_enabled: boolean; session_mfa: boolean };
  merchant: { id: string; name: string; status: string; custody_mode: string; withdrawals_enabled: boolean };
  api_origin: string;
}

export interface Invoice {
  id: string;
  status: string;
  livemode: boolean;
  amount: string;
  amount_received: string;
  token: string;
  symbol: string;
  chain: string;
  network: string;
  deposit_address: string;
  checkout_url: string;
  external_order_id: string | null;
  sub_merchant_id?: string | null;
  description: string | null;
  expires_at: string;
  created_at: string;
  history?: { from: string | null; to: string; reason: string; at: string }[];
  payments?: { tx_hash: string; from: string; amount: string; status: string; block_number: string; confirmations_required: number; confirmed_at: string | null }[];
  /** Forwarder mode (D-097): flushes that moved the funds on to the merchant wallet, fee split on-chain. */
  forwards?: { status: string; tx_hash: string | null; explorer_url: string | null; to_merchant: string | null; fee: string | null; confirmed_at: string | null }[];
}

export type ReceivingMode = 'non_custodial_xpub' | 'non_custodial_forwarder' | 'custodial';

export interface MerchantSettings {
  widget_origins: string[];
  receiving_mode: ReceivingMode;
  forwarder_available: boolean;
  /** Custody is on for this platform: the merchant may choose to have it hold their funds (D-098). */
  custodial_available: boolean;
}

export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface Balance {
  token: string;
  symbol: string | null;
  received: string;
  fees_owed: string;
  fees_charged: string;
  prepaid_fees: string;
  fee_status: 'ok' | 'low' | 'blocked' | 'not_enforced';
  /** Custodial only: received but not swept yet / withdrawable / held for withdrawals in flight. */
  pending: string;
  available: string;
  withdrawing: string;
}

export interface PayoutAddress {
  id: string;
  livemode: boolean;
  address: string;
  label: string | null;
  status: 'current' | 'pending' | 'superseded' | 'cancelled';
  activates_at: string;
  created_at: string;
}

export interface Withdrawal {
  id: string;
  object: 'withdrawal' | 'payout';
  livemode: boolean;
  /** merchant: to your own payout address; customer: a payout to one of your users (D-100). */
  kind: 'merchant' | 'customer';
  customer_ref: string | null;
  status: 'pending_approval' | 'approved' | 'sent' | 'confirmed' | 'failed' | 'rejected' | 'cancelled';
  token: string;
  symbol: string;
  amount: string;
  fee: string;
  to_address: string;
  approvals_required: number;
  approvals: number;
  tx_hash: string | null;
  reason: string | null;
  created_at: string;
  confirmed_at: string | null;
}

/** The merchant's own withdrawal limits for one token (D-100); null = no limit. */
export interface WithdrawalLimits {
  token: string;
  symbol: string;
  livemode: boolean;
  per_tx: string | null;
  per_day: string | null;
  used_24h: string;
  updated_at: string;
}

export interface FeeTopup {
  id: string;
  token: string;
  symbol: string | null;
  amount: string;
  reference: string;
  created_at: string;
}

export interface Token {
  id: string;
  symbol: string;
  name: string;
  chain_id: string;
  min_amount: string;
}

export interface ApiKey {
  id: string;
  name: string;
  kind: 'secret' | 'publishable';
  livemode: boolean;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  previous_secret_expires_at: string | null;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
}

export interface Xpub {
  id: string;
  status: 'active' | 'retired';
  xpub_hint: string;
  fingerprint: string;
  first_address: string;
  next_index: number;
  ownership_proved_at: string | null;
  retired_at: string | null;
  created_at: string;
}

export interface XpubChange {
  id: string;
  status: 'pending' | 'applied' | 'cancelled' | 'failed';
  xpub_hint: string;
  fingerprint: string;
  first_address: string;
  activates_at: string;
  created_at: string;
}

export interface XpubList {
  data: Xpub[];
  pending_change: XpubChange | null;
}

export interface XpubPreview {
  fingerprint: string;
  addresses: { index: number; address: string; path: string }[];
  ownership_challenge: { message: string; address: string; issued_at: string };
}

export interface DerivationReport {
  next_index: number;
  highest_used_index: number | null;
  wallet_gap_limit: number;
  data: { index: number; address: string; path: string; chain: string; invoice_id: string | null; invoice_status: string | null; amount_received: string | null; symbol: string | null }[];
}

/** Dashboard home (D-110). Amounts in token units, per token symbol. */
export interface Overview {
  livemode: boolean;
  days: number;
  series: { t: string; created: number; paid: number; volume: Record<string, string> }[];
  current: Period;
  previous: Period;
  statuses: Record<string, number>;
  funnel: { created: number; seen: number; paid: number; settled: number };
  open: number;
  attention: number;
  recent: { id: string; status: string; amount: string; amount_received: string; symbol: string; order_id: string | null; created_at: string }[];
  api: { t: string; requests: number; errors: number }[];
  security: { totp: boolean; email_verified: boolean; team_members: number; team_with_2fa: number; address_whitelist: boolean; ip_whitelist: boolean; api_keys: number; webhooks: number };
}
export interface Period {
  created: number;
  paid: number;
  conversion: number;
  volume: Record<string, string>;
  fees: Record<string, string>;
}

/** API key analytics (D-110). */
export interface KeyUsage {
  key_id: string;
  requests: number;
  errors: number;
  blocked: number;
  error_rate: number;
  clients: number;
  new_clients: number;
  last_ip: string | null;
  last_seen: string | null;
  spark: number[];
}
export interface KeyClient {
  ip: string;
  user_agent: string;
  first_seen: string;
  last_seen: string;
  last_route: string;
  requests: number;
  errors: number;
  blocked: number;
  new: boolean;
  in_key_allowlist: boolean | null;
  in_ip_whitelist: boolean | null;
}
export interface KeyAnalytics {
  key: { id: string; name: string; kind: string; livemode: boolean; prefix: string; scopes: string[]; ip_allowlist: string[] | null; created_at: string; last_used_at: string | null; revoked_at: string | null; expires_at: string | null };
  days: number;
  unit: 'hour' | 'day';
  series: { t: string; ok: number; errors: number; blocked: number; avg_ms: number }[];
  totals: { requests: number; errors: number; blocked: number; error_rate: number; avg_ms: number; clients: number; unique_ips: number };
  routes: { route: string; requests: number; errors: number; avg_ms: number }[];
  statuses: Record<string, number>;
  clients: KeyClient[];
  ip_whitelist_on: boolean;
}

/** Merchant whitelists (D-109). */
export interface WhitelistState {
  livemode: boolean;
  addresses: { enabled: boolean; disable_at: string | null; active: number; pending: number };
  ips: { enabled: boolean; disable_at: string | null; entries: { cidr: string; label: string }[] };
  activation_hours: number;
  disable_hours: number;
  request_ip: string;
}
export interface WhitelistedAddress {
  id: string;
  livemode: boolean;
  family: string;
  address: string;
  label: string;
  status: 'active' | 'pending' | 'removed';
  created_at: string;
  activates_at: string;
}
