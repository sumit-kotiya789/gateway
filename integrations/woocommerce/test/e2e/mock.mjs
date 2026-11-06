// Mock gateway API for the WooCommerce e2e: invoices in memory, signed webhooks like apps/server (D-071).
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
const KEY = 'sk_test_e2e', WHSEC = 'whsec_e2e', HOOK = process.env.HOOK;
const invoices = new Map(), byIdem = new Map();
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function webhook(inv, secret = WHSEC) {
  const body = JSON.stringify({ id: randomUUID(), object: 'event', type: `invoice.${inv.status}`, livemode: false, created_at: new Date().toISOString(),
    data: { invoice_id: inv.id, status: inv.status, external_order_id: inv.external_order_id, amount_expected: inv.amount, amount_received: inv.amount_received } });
  const t = Math.floor(Date.now() / 1000);
  const r = await fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'gateway-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` }, body });
  return { status: r.status, body: await r.text() };
}
http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/_test/')) { // /_test/<id>/<status>/<received>[?secret=]
    const [, , id, status, received] = u.pathname.split('/');
    const inv = invoices.get(id); if (!inv) return send(res, 404, {});
    inv.status = status; inv.amount_received = received ?? inv.amount_received;
    return send(res, 200, await webhook(inv, u.searchParams.get('secret') ?? WHSEC));
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: { code: 'unauthorized' } });
  if (req.method === 'POST' && u.pathname === '/v1/invoices') {
    const idem = req.headers['idempotency-key'];
    if (idem && byIdem.has(idem)) return send(res, 201, invoices.get(byIdem.get(idem)));
    const b = JSON.parse(raw);
    // Like the real API (invoices_external_order_uq): one invoice per external_order_id.
    if ([...invoices.values()].some((i) => i.external_order_id === b.external_order_id)) return send(res, 409, { error: { code: 'conflict' } });
    const id = randomUUID();
    const inv = { id, object: 'invoice', status: 'pending', amount: b.amount.replace(/\.?0+$/, ''), amount_received: '0', token: b.token, external_order_id: b.external_order_id,
      checkout_url: `http://mock/checkout/${id}`, success_url: b.success_url, cancel_url: b.cancel_url, expires_in: b.expires_in, description: b.description };
    invoices.set(id, inv); if (idem) byIdem.set(idem, id);
    return send(res, 201, inv);
  }
  const m = /^\/v1\/invoices\/([\w-]+)$/.exec(u.pathname);
  if (req.method === 'GET' && m) return invoices.has(m[1]) ? send(res, 200, invoices.get(m[1])) : send(res, 404, { error: { code: 'not_found' } });
  send(res, 404, { error: { code: 'not_found' } });
}).listen(80, () => console.log('mock up'));
