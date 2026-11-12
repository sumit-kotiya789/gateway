// Public hosted checkout. Unauthenticated: the unguessable invoice id (UUIDv7, 74 random bits) is the capability.
// Exposes only what a payer needs: merchant name, amount, token, network, address, status. Never metadata or order ids.
import { fromMinorUnits } from '@gw/core';
import { logoUri, networkOf, tokenLogo } from '@gw/networks';
import { eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withSystem } from '../../common/db.js';
import { chains, invoices, merchants, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { paymentUri } from '../invoices/invoices.js';
import { STRINGS, html, jsonForHtml, raw, sendPage, type PageOpts } from './html.js';
import { HERO, MODEL_OF, SCENE_CSS, SCENE_JS, TONE_OF, sceneModels } from './scene.js';
import { WIDGET_JS } from './widget.js';

export const CHECKOUT_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
const DONE = new Set(['paid', 'overpaid', 'settled']);
const DEAD = new Set(['expired', 'cancelled', 'failed', 'late_payment', 'held', 'partially_paid']);

async function load(deps: Deps, id: string) {
  const [r] = await withSystem(deps.db, (tx) =>
    tx
      .select({ inv: invoices, token: tokens, chain: chains, merchantName: merchants.name, widgetOrigins: merchants.widgetOrigins })
      .from(invoices)
      .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
      .innerJoin(chains, eq(chains.id, invoices.chainId))
      .innerJoin(merchants, eq(merchants.id, invoices.merchantId))
      .where(eq(invoices.id, id)),
  );
  return r;
}

export type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

function statusView(r: Loaded) {
  const d = r.token.decimals;
  const remaining = r.inv.amountExpected > r.inv.amountReceived ? r.inv.amountExpected - r.inv.amountReceived : 0n;
  return {
    status: r.inv.status,
    amount: fromMinorUnits(r.inv.amountExpected, d),
    amount_received: fromMinorUnits(r.inv.amountReceived, d),
    remaining: fromMinorUnits(remaining, d),
    remaining_minor: remaining.toString(),
    // Share of the amount received, 0-100 (the partial-payment ring).
    progress: r.inv.amountExpected > 0n ? Number((r.inv.amountReceived >= r.inv.amountExpected ? 100n : (r.inv.amountReceived * 100n) / r.inv.amountExpected)) : 0,
    expires_at: r.inv.expiresAt.toISOString(),
    success_url: DONE.has(r.inv.status) ? r.inv.successUrl : null,
    cancel_url: r.inv.cancelUrl,
  };
}

/** After confirmation the page waits this long for settlement, then shows the thank-you screen anyway. */
const SETTLE_WAIT_MS = 10 * 60_000;

const CLIENT_JS = `
(function(){
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var S = cfg.strings;
  var scene = window.gwScene || { rain: function(){}, burst: function(){} };
  function $(id){ return document.getElementById(id); }
  function has(list, s){ return list.indexOf(s) >= 0; }
  var last = null, confirmedAt = 0, finalShown = !$('done').hidden;
  function notify(v){
    // Embedded (widget): tell the merchant page, and only that exact origin, never '*'.
    if (cfg.parentOrigin && window.parent !== window) {
      window.parent.postMessage({ source: 'gateway-checkout', invoice_id: cfg.invoiceId, status: v.status, amount_received: v.amount_received }, cfg.parentOrigin);
    }
  }
  function showFinal(v, live){
    finalShown = true;
    $('donepaid').textContent = v.amount_received + ' ' + cfg.symbol;
    $('paybody').hidden = true; $('done').hidden = false;
    var c = $('cancel'); if (c) c.hidden = true;
    if (live) setTimeout(function(){ scene.burst($('hero')); }, 250);
  }
  function setStatus(v){
    notify(v);
    var done = has(cfg.done, v.status), dead = has(cfg.dead, v.status);
    var st = $('state'), model = cfg.models[v.status] || 'coin';
    if (st.getAttribute('data-model') !== model) { st.classList.remove('swap'); void st.offsetWidth; st.classList.add('swap'); }
    st.setAttribute('data-model', model); st.setAttribute('data-tone', cfg.tones[v.status] || 'wait');
    $('status').textContent = S.status[v.status] || v.status; $('statussub').textContent = S.sub[v.status] || '';
    $('received').textContent = v.amount_received; $('remaining').textContent = v.remaining;
    $('arc').setAttribute('stroke-dasharray', v.progress + ' 100');
    cfg.remainingMinor = v.remaining_minor;
    $('payarea').hidden = done || dead; $('warnbox').hidden = done || dead;
    if (done) { var c = $('cancel'); if (c) c.hidden = true; }
    if (v.success_url) { var a = $('ret'); a.href = v.success_url; a.hidden = false; }
    // Celebrate only what happens while the page is open: a confirmation seen live rains confetti.
    var live = last !== null && !has(cfg.done, last);
    if (done && !confirmedAt) { confirmedAt = Date.now(); if (live) scene.rain(); }
    var final = v.status === 'settled' || (done && Date.now() - confirmedAt > cfg.settleWaitMs);
    if (final && !finalShown) showFinal(v, last !== null && !live);
    last = v.status;
    return final || dead;
  }
  function tick(){
    var ms = new Date(cfg.expiresAt).getTime() - Date.now();
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    $('timer').textContent = m + ':' + (s < 10 ? '0' : '') + s;
  }
  function poll(){
    fetch(cfg.statusUrl, { credentials: 'omit', cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(v){
      if (!setStatus(v)) setTimeout(poll, 4000);
    }).catch(function(){ setTimeout(poll, 10000); });
  }
  $('copy').addEventListener('click', function(){
    navigator.clipboard.writeText(cfg.address).then(function(){ $('copy').textContent = S.copied; });
  });
  var w = $('wallet');
  if (!window.ethereum || cfg.chainId === null) { w.hidden = true; }
  w.addEventListener('click', function(){
    var eth = window.ethereum; var msg = $('walletmsg');
    eth.request({ method: 'eth_requestAccounts' }).then(function(acc){
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + cfg.chainId.toString(16) }] }).then(function(){ return acc[0]; });
    }).then(function(from){
      var amt = BigInt(cfg.remainingMinor).toString(16);
      var data = '0xa9059cbb' + cfg.address.slice(2).toLowerCase().padStart(64, '0') + amt.padStart(64, '0');
      return eth.request({ method: 'eth_sendTransaction', params: [{ from: from, to: cfg.token, data: data }] });
    }).then(function(){ msg.textContent = ''; poll(); }).catch(function(e){ msg.textContent = (e && e.message) ? e.message : 'Wallet error'; });
  });
  tick(); setInterval(tick, 1000);
  if (!setStatus(cfg.initial)) setTimeout(poll, 4000);
})();
`;

/**
 * Official token and network marks (D-112): the payer must pick the right network in their wallet, and recognises it
 * by its logo. data: URIs of our own constant SVGs (CSP img-src 'self' data:); decorative, the names are written out.
 */
function marks(r: Loaded) {
  const net = networkOf(r.chain.id);
  const mark = tokenLogo(r.token.id);
  const asset = html`<span class="asset">${mark ? html`<span class="ticon"><img src="${logoUri(mark)}" alt="" />${net ? html`<img class="tbadge" src="${logoUri(net.logo)}" alt="" />` : ''}</span>` : ''}<span>${r.token.symbol}</span></span>`;
  const network = html`<span class="net">${net ? html`<img src="${logoUri(net.logo)}" alt="" />` : ''}<span>${r.chain.name}</span>${net?.standard ? html`<small>${net.standard}</small>` : ''}</span>`;
  // "USDT (ERC-20)": the standard where wallets show one; Polygon PoS names the network only.
  const named = net?.standard ? `${r.token.symbol} (${net.standard})` : r.token.symbol;
  return { asset, network, named };
}

/** The checkout page for one invoice. `parentOrigin`: the allowlisted page embedding it (widget), if any. */
export async function checkoutPage(r: Loaded, parentOrigin: string | undefined): Promise<PageOpts> {
  const S = STRINGS.en;
  const v = statusView(r);
  // Embedded: links leave the frame (the merchant page continues); never inside someone else's page.
  const target = parentOrigin ? '_top' : '_self';
  const uri = paymentUri(r.token, r.chain, r.inv.depositAddress, r.inv.amountExpected);
  // QR SVG comes from our own generator over hex/decimal-only content (addresses, chain id, amount).
  const qr = await QRCode.toString(uri ?? r.inv.depositAddress, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  if (!qr.startsWith('<svg') || /<script|\bon\w+=/i.test(qr)) throw new Error('unexpected QR output');
  const qrSvg = raw(qr);
  const cfg = {
    invoiceId: r.inv.id,
    parentOrigin: parentOrigin ?? null,
    statusUrl: `/checkout/${r.inv.id}/status`,
    address: r.inv.depositAddress,
    token: r.token.contractAddress,
    chainId: r.chain.evmChainId,
    expiresAt: v.expires_at,
    remainingMinor: v.remaining_minor,
    initial: v,
    done: [...DONE],
    dead: [...DEAD],
    strings: { status: S.status, sub: S.sub, copied: S.copied },
    models: MODEL_OF,
    tones: TONE_OF,
    symbol: r.token.symbol,
    settleWaitMs: SETTLE_WAIT_MS,
  };
  const done = DONE.has(v.status);
  const final = v.status === 'settled';
  const shortRef = `${r.inv.id.slice(0, 8)}…${r.inv.id.slice(-4)}`;
  const m = marks(r);
  return {
    title: `${S.pay} ${r.merchantName}`,
    ...(parentOrigin ? { frameAncestor: parentOrigin } : {}),
    style: SCENE_CSS,
    body: (nonce) => html`
<div class="card">
  ${r.inv.livemode ? '' : html`<div class="test">${S.testMode}</div>`}
  <header class="merchant"><span class="avatar" aria-hidden="true">${(Array.from(r.merchantName)[0] ?? '').toUpperCase()}</span><div><h1>${r.merchantName}</h1><div class="muted">${S.pay}</div></div></header>
  <div id="paybody"${final ? raw(' hidden') : ''}>
<div class="label">${S.sendExactly}</div>
<div class="amount"><span class="figure">${v.amount}</span> ${m.asset}</div>
<div class="facts">
  <div class="row"><span class="muted">${S.network}</span>${m.network}</div>
  <div class="row"><span class="muted">${S.received}</span><span id="received">${v.amount_received}</span></div>
  <div class="row"><span class="muted">${S.remaining}</span><span id="remaining">${v.remaining}</span></div>
</div>
<div class="warn" id="warnbox">${S.warning(m.named, r.chain.name)}</div>
<div id="payarea">
  <div class="qr">${qrSvg}</div>
  <div class="label">${S.toAddress}</div>
  <div class="addr"><code id="addr">${r.inv.depositAddress}</code><button id="copy" type="button">${S.copy}</button></div>
  <div class="row"><span class="muted">${S.expiresIn}</span><span id="timer"></span></div>
  <button id="wallet" class="primary" type="button">${S.payWithWallet}</button>
  <div id="walletmsg"></div>
</div>
<section id="state" class="state" data-model="${MODEL_OF[v.status] ?? 'coin'}" data-tone="${TONE_OF[v.status] ?? 'wait'}" aria-live="polite">
  <div class="stage" aria-hidden="true">${sceneModels(r.token.symbol, v.progress)}</div>
  <div class="state-text"><strong id="status">${S.status[v.status] ?? v.status}</strong><span id="statussub">${S.sub[v.status] ?? ''}</span></div>
</section>
  </div>
  <section id="done" class="done"${final ? '' : raw(' hidden')} aria-live="polite">
${HERO}
<h2 class="thanks">${S.thanks}</h2>
<p class="done-msg">${S.doneMessage(v.amount, r.token.symbol, r.merchantName)}</p>
<div class="facts receipt">
  <div class="row"><span class="muted">${S.paidLabel}</span><span id="donepaid">${v.amount_received} ${r.token.symbol}</span></div>
  <div class="row"><span class="muted">${S.network}</span>${m.network}</div>
  <div class="row"><span class="muted">${S.reference}</span><span><code>${shortRef}</code></span></div>
</div>
<p class="muted close-hint">${S.closeHint}</p>
  </section>
  <a id="ret" class="btn primary" target="${target}" hidden>${S.returnToMerchant}</a>
  ${v.cancel_url ? html`<p class="cancel" id="cancel"${done ? raw(' hidden') : ''}><a href="${v.cancel_url}" target="${target}">${S.cancel}</a></p>` : ''}
</div>
<canvas id="fx" hidden></canvas>
<script type="application/json" id="cfg">${raw(jsonForHtml(cfg))}</script>
<script nonce="${nonce}">${raw(SCENE_JS)}</script>
<script nonce="${nonce}">${raw(CLIENT_JS)}</script>`,
  };
}

/** The parent origin if the request asks for embedding and the merchant allowlisted it, else undefined. */
export function embedOrigin(q: { embed?: string | undefined; origin?: string | undefined }, allowed: readonly string[]): string | undefined {
  if (q.embed !== '1' || !q.origin || !URL.canParse(q.origin)) return undefined;
  const o = new URL(q.origin).origin;
  return o === q.origin && allowed.includes(o) ? o : undefined;
}

export function checkoutRoutes(deps: Deps): FastifyPluginAsyncZod {
  const S = STRINGS.en;
  const Params = z.strictObject({ id: z.string().max(64) });
  // Not strict: links may carry unrelated parameters (analytics). Only embed + origin are read.
  const Query = z.object({ embed: z.string().max(4).optional(), origin: z.string().max(200).optional() });

  return async (app) => {
    app.get('/checkout/:id', { config: { rateLimit: CHECKOUT_RATE_LIMIT }, schema: { params: Params, querystring: Query, hide: true } }, async (req, reply) => {
      const r = z.uuid().safeParse(req.params.id).success ? await load(deps, req.params.id) : undefined;
      if (!r) return sendPage(reply, { title: S.notFound, status: 404, body: () => html`<div class="card"><h1>${S.notFound}</h1></div>` });

      return sendPage(reply, await checkoutPage(r, embedOrigin(req.query, r.widgetOrigins)));
    });

    /** Embeddable widget script (M10). Loaded cross-origin by merchant sites: CORP must allow it. */
    app.get('/widget.js', { schema: { hide: true } }, async (_req, reply) =>
      reply
        .type('application/javascript; charset=utf-8')
        .header('cache-control', 'public, max-age=3600')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(WIDGET_JS),
    );

    app.get(
      '/checkout/:id/status',
      { config: { rateLimit: CHECKOUT_RATE_LIMIT }, schema: { params: z.strictObject({ id: z.uuid() }), hide: true } },
      async (req, reply) => {
        const r = await load(deps, req.params.id);
        if (!r) return reply.status(404).send({ error: { code: 'not_found', message: 'invoice not found', request_id: req.id } });
        return reply.header('cache-control', 'no-store').send(statusView(r));
      },
    );
  };
}
