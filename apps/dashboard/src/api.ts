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

export async function api<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  let res = await send(method, path, body, headers);
  if (res.status === 401 && !NO_REFRESH.test(path) && (await refresh())) res = await send(method, path, body, headers);
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, (data as ErrorBody | null)?.error?.code ?? 'error', errorMessage(data as ErrorBody | null, res.status));
  return data as T;
}

export const totpHeader = (code: string) => ({ 'x-totp-code': code.trim() });

// ---------------------------------------------------------------- response shapes

export type Role = 'owner' | 'admin' | 'developer' | 'finance' | 'read_only';

export interface Me {
  user: { id: string; email: string; email_verified: boolean; role: Role; totp_enabled: boolean; session_mfa: boolean };
  merchant: { id: string; name: string; status: string; custody_mode: string };
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
  description: string | null;
  expires_at: string;
  created_at: string;
  history?: { from: string | null; to: string; reason: string; at: string }[];
  payments?: { tx_hash: string; from: string; amount: string; status: string; block_number: string; confirmations_required: number; confirmed_at: string | null }[];
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
