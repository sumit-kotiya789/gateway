// Server-rendered public pages (hosted checkout, payment links). No framework: every interpolation goes through esc(),
// data for scripts travels as JSON in a <script type="application/json"> block, and the CSP allows only this
// response's nonce for scripts and styles.
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Markup that is already safe. Only `html` and `raw` create it. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Explicitly trusted markup (our own SVG, our own script, escaped JSON). Every use is a review point. */
export function raw(trusted: string): SafeHtml {
  return new SafeHtml(trusted);
}

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  throw new TypeError(`cannot render ${typeof v} into HTML`);
}

/** Escape-by-default templating: every interpolation is HTML-escaped unless it is SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** JSON safe to embed inside <script type="application/json">: no `<` can close the tag. */
export function jsonForHtml(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

// i18n-ready: all user-facing strings in one table per locale.
export const STRINGS = {
  en: {
    pay: 'Pay',
    sendExactly: 'Send exactly',
    toAddress: 'to this address',
    copy: 'Copy',
    copied: 'Copied',
    network: 'Network',
    warning: (symbol: string, network: string) => `Send only ${symbol} on ${network}. Other tokens or networks will be lost.`,
    expiresIn: 'Expires in',
    payWithWallet: 'Pay with browser wallet',
    testMode: 'TEST MODE: testnet funds only',
    received: 'Received',
    remaining: 'Remaining',
    status: {
      pending: 'Waiting for payment',
      detected: 'Payment detected, waiting for confirmations',
      confirming: 'Confirming payment',
      paid: 'Payment complete',
      overpaid: 'Payment complete (overpaid)',
      settled: 'Payment complete',
      underpaid: 'Partial payment received: send the remaining amount',
      expired: 'This invoice has expired. Do not send funds.',
      cancelled: 'This invoice was cancelled. Do not send funds.',
      late_payment: 'Payment received after expiry. The merchant will contact you.',
      failed: 'This invoice could not be created.',
      created: 'Preparing invoice',
    } as Record<string, string>,
    returnToMerchant: 'Return to merchant',
    cancel: 'Cancel and return',
    notFound: 'Invoice not found',
    continue: 'Continue to payment',
    linkInactive: 'This payment link is no longer active.',
    tooMany: 'Too many open payments for this link. Please try again later.',
  },
};
export type Strings = (typeof STRINGS)['en'];

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#14171f;--muted:#5d6472;--line:#e3e6eb;--accent:#2457d6;--ok:#11804a;--warn:#a15c00;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e8eaee;--muted:#9aa1ad;--line:#2a2f3a;--accent:#7aa2ff;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
h1{font-size:15px;font-weight:600;margin:0 0 12px;color:var(--muted)}
.amount{font-size:28px;font-weight:700;margin:4px 0}.muted{color:var(--muted)}
.test{background:var(--warn);color:#000;font-weight:600;font-size:12px;text-align:center;padding:4px;border-radius:6px;margin-bottom:12px}
.warn{border-left:3px solid var(--warn);padding:8px 10px;margin:12px 0;font-size:13px}
.qr{display:flex;justify-content:center;margin:12px 0}.qr svg{width:200px;height:200px;background:#fff;padding:8px;border-radius:8px}
.addr{display:flex;gap:8px;align-items:center}.addr code{flex:1;word-break:break-all;font-size:13px;background:var(--bg);padding:8px;border-radius:8px;border:1px solid var(--line)}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:8px 12px;cursor:pointer}
.primary{background:var(--accent);border-color:var(--accent);color:#fff;width:100%;padding:12px;margin-top:12px;font-weight:600}
.status{margin-top:14px;padding:10px;border-radius:8px;background:var(--bg);font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}a{color:var(--accent)}
.row{display:flex;justify-content:space-between;font-size:14px;margin-top:6px}
`;

export function sendPage(reply: FastifyReply, opts: { title: string; body: (nonce: string) => SafeHtml; status?: number }) {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    // Widget embedding (merchant-allowlisted origins) arrives in M10; until then never framed.
    "frame-ancestors 'none'",
  ].join('; ');
  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${opts.title}</title><style nonce="${nonce}">${raw(STYLE)}</style></head>
<body><main>${opts.body(nonce)}</main></body></html>`;
  return reply
    .status(opts.status ?? 200)
    .header('content-security-policy', csp)
    .header('cache-control', 'no-store')
    .header('x-frame-options', 'DENY')
    .type('text/html; charset=utf-8')
    .send(page.value);
}
