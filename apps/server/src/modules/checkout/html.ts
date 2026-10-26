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
    securedBy: 'Secured by Gateway · Non-custodial',
  },
};
export type Strings = (typeof STRINGS)['en'];

// Same look as the dashboard (dark surface, neon-green accent). The CSP allows no font downloads: system font stack.
const STYLE = `
:root{color-scheme:dark;--bg:#060806;--card:#101310;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--fg:#f2f5f2;--fg2:#c9d1ca;
--muted:#8b948c;--accent:#34d65c;--accent2:#19b347;--soft:rgba(52,214,92,.12);--warn:#f5b947;--bad:#ff6b6b;
--font:Poppins,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}[hidden]{display:none!important}html{background:var(--bg)}
body{margin:0;min-height:100vh;color:var(--fg);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;
background:radial-gradient(700px 420px at 50% -140px,rgba(52,214,92,.22),transparent 70%),radial-gradient(520px 520px at 110% 110%,rgba(52,214,92,.07),transparent 60%),var(--bg)}
main{max-width:460px;margin:0 auto;padding:32px 16px 24px}
.card{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0) 40%),var(--card);border:1px solid var(--line);
border-radius:24px;padding:24px;box-shadow:0 30px 80px -30px rgba(0,0,0,.85)}
.card::before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;pointer-events:none;
background:linear-gradient(160deg,rgba(52,214,92,.5),transparent 42%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
-webkit-mask-composite:xor;mask-composite:exclude}
.merchant{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.avatar{flex:none;width:44px;height:44px;border-radius:14px;display:grid;place-items:center;font-weight:700;font-size:18px;color:#031007;
background:linear-gradient(135deg,#7dff9b,#0d7f2a);box-shadow:0 8px 24px -8px rgba(52,214,92,.6)}
h1{font-size:17px;font-weight:600;margin:0;letter-spacing:-.01em}
.merchant .muted{font-size:13px}
.label{font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.amount{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:2px 0 16px;font-variant-numeric:tabular-nums;
background:linear-gradient(90deg,#fff,#b8ffc8);-webkit-background-clip:text;background-clip:text;color:transparent}
.facts{border:1px solid var(--line);border-radius:16px;padding:2px 14px;background:rgba(255,255,255,.015)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px;padding:9px 0}
.facts .row+.row{border-top:1px solid var(--line)}
.row span:last-child{font-weight:500;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.test{display:flex;align-items:center;justify-content:center;gap:8px;font-size:11.5px;font-weight:600;letter-spacing:.08em;color:#ffd28a;
background:rgba(245,165,36,.1);border:1px solid rgba(245,165,36,.35);border-radius:999px;padding:6px 12px;margin-bottom:20px}
.test::before{content:"";width:6px;height:6px;border-radius:50%;background:#f5a524;box-shadow:0 0 10px #f5a524}
.warn{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:#ffe2ad;background:rgba(245,185,71,.08);border:1px solid rgba(245,185,71,.3);
border-radius:14px;padding:10px 12px;margin:16px 0}
.warn::before{content:"!";flex:none;width:18px;height:18px;margin-top:1px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;
color:#1b1000;background:var(--warn)}
.qr{display:flex;justify-content:center;margin:22px 0 18px}
.qr svg{width:212px;height:212px;background:#fff;padding:10px;border-radius:18px;box-shadow:0 0 0 6px rgba(52,214,92,.12),0 20px 60px -20px rgba(52,214,92,.6)}
.addr{display:flex;gap:8px;align-items:stretch;margin:6px 0 2px}
.addr code{flex:1;min-width:0;word-break:break-all;font:12.5px/1.5 var(--mono);color:var(--fg2);background:var(--bg);padding:10px 12px;border-radius:12px;
border:1px solid var(--line2)}
button,.btn{font:500 14px/1 var(--font);display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line2);
background:rgba(255,255,255,.04);color:var(--fg);border-radius:999px;padding:10px 16px;cursor:pointer;text-decoration:none;
transition:transform .15s,box-shadow .2s,background .2s,border-color .2s}
button:hover,.btn:hover{border-color:rgba(52,214,92,.45);background:var(--soft);text-decoration:none}
button:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
#copy{flex:none;border-radius:12px;min-width:76px}
.primary{width:100%;padding:15px 18px;margin-top:16px;font-weight:600;font-size:15px;color:#031007;border-color:transparent;
background:linear-gradient(180deg,#45e46c,var(--accent2));box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 12px 30px -10px rgba(52,214,92,.8)}
.primary:hover{color:#031007;transform:translateY(-1px);background:linear-gradient(180deg,#52ee78,#1cc04e);
box-shadow:0 1px 0 rgba(255,255,255,.4) inset,0 16px 36px -10px rgba(52,214,92,.95)}
#timer{font-family:var(--mono);font-size:13px;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:999px;padding:3px 10px}
#walletmsg{font-size:13px;margin-top:8px;text-align:center;color:#ffb4b4}#walletmsg:empty{display:none}
.status{display:flex;align-items:center;gap:10px;margin-top:18px;padding:12px 14px;border-radius:14px;border:1px solid var(--line);
background:rgba(255,255,255,.03);font-weight:500;font-size:14px}
.status::before{content:"";flex:none;width:9px;height:9px;border-radius:50%;background:var(--accent);animation:ping 1.6s infinite}
.status.ok{color:#b8ffc8;border-color:rgba(52,214,92,.4);background:var(--soft)}
.status.ok::before{animation:none;box-shadow:0 0 12px var(--accent)}
.status.bad{color:#ffd0d0;border-color:rgba(255,107,107,.4);background:rgba(255,107,107,.08)}
.status.bad::before{animation:none;background:var(--bad)}
.status:empty{display:none}
@keyframes ping{0%{box-shadow:0 0 0 0 rgba(52,214,92,.6)}70%,100%{box-shadow:0 0 0 9px rgba(52,214,92,0)}}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.cancel{text-align:center;margin:16px 0 0;font-size:14px}.cancel a{color:var(--muted)}
.desc{color:var(--fg2);margin:0 0 4px}
.foot{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:18px;font-size:12px;color:var(--muted)}
.foot svg{width:16px;height:16px}
@media (max-width:420px){main{padding:16px 12px}.card{padding:20px 18px;border-radius:20px}.amount{font-size:28px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// Our own static SVG (the dashboard's brand mark).
const MARK = `<svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="gw-mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7dff9b"/><stop offset="1" stop-color="#0d7f2a"/></linearGradient></defs><rect width="40" height="40" rx="12" fill="url(#gw-mark)"/><path d="M27.5 14.2A9 9 0 1 0 29 22h-8.5" fill="none" stroke="#031007" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** `frameAncestor`: the one merchant-allowlisted origin that may embed this page (widget), else never framed. */
export function sendPage(reply: FastifyReply, opts: { title: string; body: (nonce: string) => SafeHtml; status?: number; frameAncestor?: string }) {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    `frame-ancestors ${opts.frameAncestor ?? "'none'"}`,
  ].join('; ');
  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${opts.title}</title><style nonce="${nonce}">${raw(STYLE)}</style></head>
<body><main>${opts.body(nonce)}<footer class="foot">${raw(MARK)}<span>${STRINGS.en.securedBy}</span></footer></main></body></html>`;
  reply.status(opts.status ?? 200).header('content-security-policy', csp).header('cache-control', 'no-store').type('text/html; charset=utf-8');
  // X-Frame-Options cannot name an origin: embeddable pages rely on frame-ancestors alone (helmet sets SAMEORIGIN).
  if (opts.frameAncestor) reply.removeHeader('x-frame-options');
  else reply.header('x-frame-options', 'DENY');
  return reply.send(page.value);
}
