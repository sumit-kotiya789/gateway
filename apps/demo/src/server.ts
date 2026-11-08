// Demo web3 app: a small "game wallet" built on the gateway, to show (and test) the integration end to end.
//   - each player gets a permanent deposit address (POST /v1/deposit-accounts, customer_ref = the player);
//   - deposits are credited once, from verified webhooks (invoice.settled, kind deposit), with a sync on page load as a
//     fallback when webhooks cannot reach this app;
//   - with custody on, players withdraw to their own wallet (POST /v1/payouts), debited first and refunded on failure.
// The secret API key stays on this server. DEMO ONLY: the login is a name, not real authentication.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Gateway, GatewayError, WebhookVerificationError, constructEvent, type DepositAccount } from '@gw/sdk-node';
import { fromMinor, toMinor } from './money.js';
import { APP_CSS, APP_JS, PAGE } from './page.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`${k} is required`);
  return v;
};
const PORT = Number(process.env.PORT ?? 8083);
const TOKEN = env('DEMO_TOKEN', 'bsc-testnet:usdt');
const DECIMALS = Number(env('DEMO_TOKEN_DECIMALS', '18'));
const WEBHOOK_SECRET = process.env.DEMO_WEBHOOK_SECRET ?? '';
const SESSION_SECRET = process.env.DEMO_SESSION_SECRET ?? randomBytes(32).toString('hex');
const DATA = join(env('DEMO_DATA_DIR', './.demo-data'), 'demo.json');
const gateway = new Gateway({ apiKey: env('DEMO_API_KEY'), baseUrl: env('DEMO_GATEWAY_URL', 'http://localhost:3000') });

// ---------------------------------------------------------------- store (one JSON file; fine for a demo)

interface Withdrawal { id: string; payoutId: string | null; to: string; amount: string; status: string; txHash: string | null; error: string | null; refunded: boolean; createdAt: string }
interface Player { accountId: string; address: string; custodyMode: string; symbol: string; balance: string; credited: string[]; withdrawals: Withdrawal[] }
interface Store { players: Record<string, Player> }

function load(): Store {
  try {
    return JSON.parse(readFileSync(DATA, 'utf8')) as Store;
  } catch {
    return { players: {} };
  }
}
const store = load();
function save(): void {
  const dir = join(DATA, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(`${DATA}.tmp`, JSON.stringify(store, null, 2));
  renameSync(`${DATA}.tmp`, DATA);
}
const ref = (name: string) => `demo:${name}`;
const nameOf = (customerRef: string | null | undefined) => (customerRef?.startsWith('demo:') ? customerRef.slice(5) : null);
const add = (p: Player, minor: bigint) => {
  p.balance = (BigInt(p.balance) + minor).toString();
};

/** Credits a settled deposit once (by invoice id). */
function credit(p: Player, invoiceId: string, amount: string): void {
  if (p.credited.includes(invoiceId)) return;
  add(p, toMinor(amount, DECIMALS));
  p.credited.push(invoiceId);
  save();
}

/** Refunds a failed withdrawal once. */
function refund(p: Player, w: Withdrawal): void {
  if (w.refunded) return;
  add(p, toMinor(w.amount, DECIMALS));
  w.refunded = true;
  save();
}

/** Fallback when webhooks cannot reach this app: settled deposits and payout states, from the API. */
async function sync(p: Player): Promise<DepositAccount> {
  const acc = await gateway.depositAccounts.retrieve(p.accountId);
  for (const d of acc.deposits ?? []) if (d.status === 'settled') credit(p, d.invoice_id, d.amount);
  for (const w of p.withdrawals) {
    if (!w.payoutId || ['confirmed', 'failed'].includes(w.status)) continue;
    const po = await gateway.payouts.retrieve(w.payoutId);
    w.status = po.status;
    w.txHash = po.tx_hash;
    if (po.status === 'failed') refund(p, w);
  }
  save();
  return acc;
}

// ---------------------------------------------------------------- session (signed name cookie)

const sign = (v: string) => createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function userOf(req: IncomingMessage): string | null {
  const c = (req.headers.cookie ?? '').split(';').map((x) => x.trim()).find((x) => x.startsWith('demo_user='));
  if (!c) return null;
  const [name = '', mac = ''] = decodeURIComponent(c.slice('demo_user='.length)).split('.');
  const want = Buffer.from(sign(name), 'hex');
  const got = Buffer.from(mac, 'hex');
  return got.length === want.length && timingSafeEqual(got, want) ? name : null;
}

// ---------------------------------------------------------------- http

/** Writes a response; returns true so handlers can `return send(...)`. */
const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): true => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
  return true;
};
const asset = (res: ServerResponse, type: string, body: string): true => {
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
  return true;
};
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
const json = async <T>(req: IncomingMessage) => JSON.parse((await readBody(req)).toString('utf8') || '{}') as T;
const reason = (e: unknown) => (e instanceof GatewayError ? `${e.message}${(e.details as { reason?: string } | undefined)?.reason ? ` (${String((e.details as { reason?: string }).reason)})` : ''}` : (e as Error).message);

async function me(name: string) {
  const p = store.players[name];
  if (!p) return null;
  const acc = await sync(p);
  return {
    username: name,
    token: TOKEN,
    symbol: p.symbol,
    address: p.address,
    custody_mode: p.custodyMode,
    can_withdraw: p.custodyMode === 'custodial',
    balance: fromMinor(BigInt(p.balance), DECIMALS),
    deposits: (acc.deposits ?? []).map((d) => ({ id: d.invoice_id, amount: d.amount, status: d.status, credited: p.credited.includes(d.invoice_id), at: d.created_at })),
    withdrawals: [...p.withdrawals].reverse(),
  };
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://demo');
    try {
      if (req.method === 'GET' && url.pathname === '/') return asset(res, 'text/html; charset=utf-8', PAGE);
      if (req.method === 'GET' && url.pathname === '/app.js') return asset(res, 'text/javascript; charset=utf-8', APP_JS);
      if (req.method === 'GET' && url.pathname === '/app.css') return asset(res, 'text/css; charset=utf-8', APP_CSS);
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

      // The gateway's webhooks: verify on the raw body, then act once per invoice / payout.
      if (req.method === 'POST' && url.pathname === '/webhooks/gateway') {
        if (!WEBHOOK_SECRET) return send(res, 503, { error: 'DEMO_WEBHOOK_SECRET not set' });
        const raw = await readBody(req);
        const sig = req.headers['gateway-signature'];
        const ev = constructEvent(raw, typeof sig === 'string' ? sig : undefined, WEBHOOK_SECRET);
        const data = ev.data as unknown as Record<string, string | null>;
        if (ev.type === 'invoice.settled' && data.kind === 'deposit') {
          const name = nameOf(data.customer_ref);
          const p = name ? store.players[name] : undefined;
          if (p && data.invoice_id) {
            const inv = await gateway.invoices.retrieve(data.invoice_id); // amounts in token units
            credit(p, inv.id, inv.amount_received);
          }
        } else if (ev.type.startsWith('payout.')) {
          const name = nameOf(data.customer_ref);
          const w = name ? store.players[name]?.withdrawals.find((x) => x.payoutId === data.withdrawal_id) : undefined;
          const p = name ? store.players[name] : undefined;
          if (p && w) {
            w.status = data.status ?? w.status;
            w.txHash = data.tx_hash ?? w.txHash;
            if (w.status === 'failed') refund(p, w);
            save();
          }
        }
        return send(res, 200, { received: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        const { username = '' } = await json<{ username?: string }>(req);
        const name = username.trim().toLowerCase();
        if (!/^[a-z0-9_-]{3,32}$/.test(name)) return send(res, 400, { error: 'pick a name: 3-32 letters, digits, - or _' });
        if (!store.players[name]) {
          // The player's permanent address for this token: the same on every call.
          const acc = await gateway.depositAccounts.create({ customer_ref: ref(name), token: TOKEN });
          store.players[name] = { accountId: acc.id, address: acc.address, custodyMode: acc.custody_mode, symbol: acc.symbol, balance: '0', credited: [], withdrawals: [] };
          save();
        }
        return send(res, 200, { ok: true }, { 'set-cookie': `demo_user=${encodeURIComponent(`${name}.${sign(name)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'set-cookie': 'demo_user=; Path=/; Max-Age=0' });

      const name = userOf(req);
      if (url.pathname.startsWith('/api/') && !name) return send(res, 401, { error: 'log in first' });
      if (req.method === 'GET' && url.pathname === '/api/me' && name) {
        const v = await me(name);
        return v ? send(res, 200, v) : send(res, 401, { error: 'log in first' });
      }
      if (req.method === 'POST' && url.pathname === '/api/withdraw' && name) {
        const p = store.players[name];
        if (!p) return send(res, 401, { error: 'log in first' });
        if (p.custodyMode !== 'custodial') return send(res, 409, { error: 'withdrawals need custody on (this merchant receives deposits straight to its own wallet)' });
        const { to = '', amount = '' } = await json<{ to?: string; amount?: string }>(req);
        let minor: bigint;
        try {
          minor = toMinor(amount.trim(), DECIMALS);
        } catch (e) {
          return send(res, 400, { error: (e as Error).message });
        }
        if (minor <= 0n) return send(res, 400, { error: 'amount must be above zero' });
        if (minor > BigInt(p.balance)) return send(res, 400, { error: 'not enough balance' });
        // Debit first, then ask for the payout with this withdrawal's id as idempotency key; refund if refused.
        const w: Withdrawal = { id: randomUUID(), payoutId: null, to: to.trim(), amount: fromMinor(minor, DECIMALS), status: 'requested', txHash: null, error: null, refunded: false, createdAt: new Date().toISOString() };
        add(p, -minor);
        p.withdrawals.push(w);
        save();
        try {
          const po = await gateway.payouts.create({ customer_ref: ref(name), to_address: w.to, token: TOKEN, amount: w.amount }, { idempotencyKey: w.id });
          w.payoutId = po.id;
          w.status = po.status;
          save();
          return send(res, 200, { ok: true, status: po.status, fee: po.fee });
        } catch (e) {
          w.status = 'failed';
          w.error = reason(e);
          refund(p, w);
          return send(res, 400, { error: w.error });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof WebhookVerificationError) return send(res, 400, { error: e.message });
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      return send(res, 500, { error: reason(e) });
    }
  })();
});

server.listen(PORT, () => {
  process.stdout.write(`demo game wallet on http://localhost:${String(PORT)} (token ${TOKEN}; webhooks ${WEBHOOK_SECRET ? 'on' : 'off: syncing on page load'})\n`);
});
