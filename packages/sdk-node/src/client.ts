// Merchant API client. Zero dependencies (global fetch, Node >= 18). POSTs that create something send an
// Idempotency-Key (generated unless given), so retries after a timeout or 5xx never create duplicates.
import { randomUUID } from 'node:crypto';
import type { Balance, CreateInvoiceParams, GatewayEvent, Invoice, ListInvoicesParams, Page, PaymentLink } from './types.js';

export class GatewayError extends Error {
  override readonly name = 'GatewayError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface GatewayOptions {
  /** Secret key: sk_live_… or sk_test_…. Never use it in a browser. */
  apiKey: string;
  /** Your gateway's API origin, e.g. https://pay.example.com */
  baseUrl: string;
  /** Per-request timeout in ms (default 30 s). */
  timeoutMs?: number;
  /** Retries for network errors, 429 and 5xx (default 2; idempotent requests only). */
  maxRetries?: number;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined>;

export class Gateway {
  readonly invoices;
  readonly paymentLinks;
  readonly events;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: GatewayOptions) {
    if (!/^sk_(live|test)_/.test(opts.apiKey)) throw new Error('Gateway: apiKey must be a secret key (sk_live_… or sk_test_…)');
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    const r = this.request.bind(this);
    this.invoices = {
      create: (params: CreateInvoiceParams, o: { idempotencyKey?: string } = {}) => r<Invoice>('POST', '/v1/invoices', { body: params, idempotencyKey: o.idempotencyKey ?? randomUUID() }),
      retrieve: (id: string) => r<Invoice>('GET', `/v1/invoices/${encodeURIComponent(id)}`),
      list: (params: ListInvoicesParams = {}) => r<Page<Invoice>>('GET', '/v1/invoices', { query: { ...params } }),
      cancel: (id: string) => r<Invoice>('POST', `/v1/invoices/${encodeURIComponent(id)}/cancel`, { idempotencyKey: randomUUID() }),
    };
    this.paymentLinks = {
      create: (params: { amount: string; token: string; [k: string]: unknown }, o: { idempotencyKey?: string } = {}) =>
        r<PaymentLink>('POST', '/v1/payment-links', { body: params, idempotencyKey: o.idempotencyKey ?? randomUUID() }),
      retrieve: (id: string) => r<PaymentLink>('GET', `/v1/payment-links/${encodeURIComponent(id)}`),
      list: (params: { limit?: number; starting_after?: string } = {}) => r<Page<PaymentLink>>('GET', '/v1/payment-links', { query: { ...params } }),
    };
    this.events = {
      retrieve: (id: string) => r<GatewayEvent>('GET', `/v1/events/${encodeURIComponent(id)}`),
      list: (params: { limit?: number; starting_after?: string; type?: string } = {}) => r<Page<GatewayEvent>>('GET', '/v1/events', { query: { ...params } }),
    };
  }

  balances(): Promise<{ livemode: boolean; data: Balance[] }> {
    return this.request('GET', '/v1/balances');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, o: { body?: unknown; query?: Query; idempotencyKey?: string } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
    // GETs are naturally idempotent; POSTs only with a key.
    const retries = method === 'GET' || o.idempotencyKey ? (this.opts.maxRetries ?? 2) : 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : backoff(attempt));
        continue;
      }
      const text = await res.text();
      const data: unknown = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const e = (data as { error?: { code?: string; message?: string; request_id?: string; details?: unknown } } | undefined)?.error;
        throw new GatewayError(res.status, e?.code ?? 'error', e?.message ?? `HTTP ${String(res.status)}`, e?.request_id ?? res.headers.get('x-request-id'), e?.details);
      }
      return data as T;
    }
  }
}

const backoff = (attempt: number) => 500 * 2 ** attempt + Math.floor(Math.random() * 250);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
