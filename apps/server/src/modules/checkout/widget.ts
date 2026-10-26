// The embeddable checkout widget (M10, D-080), served as /widget.js. Merchant pages load it with a script tag and open
// an invoice their backend created: GatewayCheckout.open({ invoiceId, onStatus, onPaid, onClose }). It frames the hosted
// checkout (which only allows framing by the merchant's allowlisted origins) and accepts status messages only from that
// frame and the gateway origin. It never sees keys: the invoice id is the only input.
export const WIDGET_JS = `(function(){
  'use strict';
  if (window.GatewayCheckout) return;
  var script = document.currentScript;
  var base = script && script.src ? new URL(script.src).origin : null;
  var DONE = ['paid', 'overpaid', 'settled'];
  var current = null;

  function close(){
    if (!current) return;
    window.removeEventListener('message', current.onMessage);
    document.removeEventListener('keydown', current.onKey);
    current.overlay.remove();
    var done = current.opts.onClose; current = null;
    if (done) done();
  }

  function open(opts){
    if (!base) throw new Error('GatewayCheckout: load widget.js with a <script src> tag');
    if (!opts || !/^[0-9a-f-]{36}$/i.test(opts.invoiceId || '')) throw new Error('GatewayCheckout.open: invoiceId (uuid) required');
    close();
    var overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
    var frame = document.createElement('iframe');
    frame.title = 'Checkout';
    frame.src = base + '/checkout/' + encodeURIComponent(opts.invoiceId) + '?embed=1&origin=' + encodeURIComponent(window.location.origin);
    frame.style.cssText = 'width:min(440px,100vw);height:min(720px,100vh);border:0;border-radius:12px;background:#fff';
    frame.setAttribute('allow', 'clipboard-write');
    var x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '\\u00d7';
    x.style.cssText = 'position:absolute;top:12px;right:16px;font:28px/1 sans-serif;color:#fff;background:none;border:0;cursor:pointer';
    x.addEventListener('click', close);
    overlay.appendChild(frame);
    overlay.appendChild(x);
    var paid = false;
    var onMessage = function(e){
      // Only our frame, from the gateway origin, about this invoice.
      if (e.origin !== base || e.source !== frame.contentWindow) return;
      var d = e.data;
      if (!d || d.source !== 'gateway-checkout' || d.invoice_id !== opts.invoiceId) return;
      if (opts.onStatus) opts.onStatus(d.status);
      if (!paid && DONE.indexOf(d.status) >= 0) { paid = true; if (opts.onPaid) opts.onPaid(d.status); }
    };
    var onKey = function(e){ if (e.key === 'Escape') close(); };
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    current = { overlay: overlay, opts: opts, onMessage: onMessage, onKey: onKey };
  }

  window.GatewayCheckout = { open: open, close: close };
})();
`;
