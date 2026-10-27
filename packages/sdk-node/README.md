# @gw/sdk-node

Node.js (>= 18) client for the Gateway merchant API, plus webhook verification. No dependencies.

```js
import { Gateway, constructEvent } from '@gw/sdk-node';

const gw = new Gateway({ apiKey: process.env.GATEWAY_SECRET_KEY, baseUrl: 'https://pay.example.com' });

// Creating sends an Idempotency-Key (pass your own, e.g. your order id, to make retries across restarts safe).
const invoice = await gw.invoices.create({ amount: '25.00', token: 'nexis:usdt', external_order_id: 'order-1001' }, { idempotencyKey: 'order-1001' });
// Send the customer to invoice.checkout_url, or open it with the widget (GatewayCheckout.open({ invoiceId: invoice.id })).

await gw.invoices.retrieve(invoice.id);
await gw.invoices.list({ status: 'paid', limit: 20 });
await gw.balances();
// Accounting sync: CSV text for the key's mode, inclusive UTC dates (≤ 366 days).
const csv = await gw.exports.invoicesCsv({ from: '2026-10-01', to: '2026-10-31' });

// Webhooks (Express): use the raw body.
app.post('/gateway/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.get('gateway-signature'), process.env.GATEWAY_WEBHOOK_SECRET);
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(200); // answer fast, then work; deduplicate on event.id
  if (event.type === 'invoice.paid') fulfil(event.data.external_order_id);
});
```

Errors are `GatewayError` (`status`, `code`, `message`, `requestId`, `details`). Network errors, 429 and 5xx are
retried twice with backoff (GETs, and POSTs carrying an idempotency key). Secret keys only on servers, never in a browser.

Build: `pnpm --filter @gw/sdk-node build` (ESM + type declarations in `dist/`).
