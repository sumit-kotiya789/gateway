// Public hosted checkout. Unauthenticated: the unguessable invoice id (UUIDv7, 74 random bits) is the capability.
// Exposes only what a payer needs: merchant name, amount, token, network, address, status. Never metadata or order ids.
import { fromMinorUnits } from '@gw/core';
import { eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withSystem } from '../../common/db.js';
import { chains, invoices, merchants, tokens } from '../../db/schema.js';
import type { Deps } from '../../deps.js';
import { paymentUri } from '../invoices/invoices.js';
import { STRINGS, html, jsonForHtml, raw, sendPage } from './html.js';

export const CHECKOUT_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
const DONE = new Set(['paid', 'overpaid', 'settled']);
const DEAD = new Set(['expired', 'cancelled', 'failed', 'late_payment']);

async function load(deps: Deps, id: string) {
  const [r] = await withSystem(deps.db, (tx) =>
    tx
      .select({ inv: invoices, token: tokens, chain: chains, merchantName: merchants.name })
      .from(invoices)
      .innerJoin(tokens, eq(tokens.id, invoices.tokenId))
      .innerJoin(chains, eq(chains.id, invoices.chainId))
      .innerJoin(merchants, eq(merchants.id, invoices.merchantId))
      .where(eq(invoices.id, id)),
  );
  return r;
}

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

function statusView(r: Loaded) {
  const d = r.token.decimals;
  const remaining = r.inv.amountExpected > r.inv.amountReceived ? r.inv.amountExpected - r.inv.amountReceived : 0n;
  return {
    status: r.inv.status,
    amount: fromMinorUnits(r.inv.amountExpected, d),
    amount_received: fromMinorUnits(r.inv.amountReceived, d),
    remaining: fromMinorUnits(remaining, d),
    remaining_minor: remaining.toString(),
    expires_at: r.inv.expiresAt.toISOString(),
    success_url: DONE.has(r.inv.status) ? r.inv.successUrl : null,
    cancel_url: r.inv.cancelUrl,
  };
}

const CLIENT_JS = `
(function(){
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var S = cfg.strings;
  function $(id){ return document.getElementById(id); }
  function setStatus(v){
    var el = $('status'); el.textContent = S.status[v.status] || v.status;
    el.className = 'status ' + (cfg.done.indexOf(v.status) >= 0 ? 'ok' : (cfg.dead.indexOf(v.status) >= 0 ? 'bad' : ''));
    $('received').textContent = v.amount_received; $('remaining').textContent = v.remaining;
    cfg.remainingMinor = v.remaining_minor;
    var finished = cfg.done.indexOf(v.status) >= 0 || cfg.dead.indexOf(v.status) >= 0;
    $('payarea').hidden = finished;
    if (v.success_url) { var a = $('ret'); a.href = v.success_url; a.hidden = false; }
    return finished;
  }
  function tick(){
    var ms = new Date(cfg.expiresAt).getTime() - Date.now();
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    $('timer').textContent = m + ':' + (s < 10 ? '0' : '') + s;
  }
  function poll(){
    fetch(cfg.statusUrl, { credentials: 'omit', cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(v){
      if (!setStatus(v)) setTimeout(poll, 5000);
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
  if (!setStatus(cfg.initial)) setTimeout(poll, 5000);
})();
`;

export function checkoutRoutes(deps: Deps): FastifyPluginAsyncZod {
  const S = STRINGS.en;
  const Params = z.strictObject({ id: z.string().max(64) });

  return async (app) => {
    app.get('/checkout/:id', { config: { rateLimit: CHECKOUT_RATE_LIMIT }, schema: { params: Params, hide: true } }, async (req, reply) => {
      const r = z.uuid().safeParse(req.params.id).success ? await load(deps, req.params.id) : undefined;
      if (!r) return sendPage(reply, { title: S.notFound, status: 404, body: () => html`<div class="card"><h1>${S.notFound}</h1></div>` });

      const v = statusView(r);
      const uri = paymentUri(r.token, r.chain, r.inv.depositAddress, r.inv.amountExpected);
      // QR SVG comes from our own generator over hex/decimal-only content (addresses, chain id, amount).
      const qr = await QRCode.toString(uri ?? r.inv.depositAddress, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
      if (!qr.startsWith('<svg') || /<script|\bon\w+=/i.test(qr)) throw new Error('unexpected QR output');
      const qrSvg = raw(qr);
      const cfg = {
        statusUrl: `/checkout/${r.inv.id}/status`,
        address: r.inv.depositAddress,
        token: r.token.contractAddress,
        chainId: r.chain.evmChainId,
        expiresAt: v.expires_at,
        remainingMinor: v.remaining_minor,
        initial: v,
        done: [...DONE],
        dead: [...DEAD],
        strings: { status: S.status, copied: S.copied },
      };
      return sendPage(reply, {
        title: `${S.pay} ${r.merchantName}`,
        body: (nonce) => html`
<div class="card">
  ${r.inv.livemode ? '' : html`<div class="test">${S.testMode}</div>`}
  <h1>${r.merchantName}</h1>
  <div class="muted">${S.sendExactly}</div>
  <div class="amount">${v.amount} ${r.token.symbol}</div>
  <div class="row"><span class="muted">${S.network}</span><span>${r.chain.name}</span></div>
  <div class="row"><span class="muted">${S.received}</span><span id="received">${v.amount_received}</span></div>
  <div class="row"><span class="muted">${S.remaining}</span><span id="remaining">${v.remaining}</span></div>
  <div class="warn">${S.warning(r.token.symbol, r.chain.name)}</div>
  <div id="payarea">
    <div class="qr">${qrSvg}</div>
    <div class="muted">${S.toAddress}</div>
    <div class="addr"><code id="addr">${r.inv.depositAddress}</code><button id="copy" type="button">${S.copy}</button></div>
    <div class="row"><span class="muted">${S.expiresIn}</span><span id="timer"></span></div>
    <button id="wallet" class="primary" type="button">${S.payWithWallet}</button>
    <div id="walletmsg" class="muted"></div>
  </div>
  <div id="status" class="status"></div>
  <a id="ret" class="btn primary" hidden>${S.returnToMerchant}</a>
  ${v.cancel_url ? html`<p><a href="${v.cancel_url}">${S.cancel}</a></p>` : ''}
</div>
<script type="application/json" id="cfg">${raw(jsonForHtml(cfg))}</script>
<script nonce="${nonce}">${raw(CLIENT_JS)}</script>`,
      });
    });

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
