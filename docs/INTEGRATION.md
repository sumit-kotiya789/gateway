# Integration guide

For merchants and developers integrating the gateway. Everything below runs in **test mode** (testnet, no real money).

## Quick start (10 minutes)

1. **Sign up** in the dashboard and enable two-factor authentication (required to create API keys).
2. **Register your wallet's account xpub** for test mode on the dashboard's *Payout wallet* page (non-custodial: payments
   go straight to your wallet). Check that the previewed addresses match your wallet before confirming. Use a different
   key for live mode.
   Export the account-level xpub (`m/44'/60'/0'`) from a hardware wallet or a wallet that supports it.
   Never paste a seed phrase or a private key (`xprv`): the gateway refuses them.
3. **Create a secret test key** (`sk_test_…`) with scopes `read` and `invoices:write`. It is shown once.
4. **Create an invoice** from your backend:

   ```sh
   curl https://pay.example/v1/invoices \
     -H "Authorization: Bearer sk_test_..." \
     -H "Idempotency-Key: order-1001" \
     -H "Content-Type: application/json" \
     -d '{"amount":"25.00","token":"nexis:usdt","external_order_id":"1001","success_url":"https://shop.example/thanks"}'
   ```

5. **Send the customer to `checkout_url`** from the response (redirect, or link button). The hosted page shows the
   amount, address, QR code, network warning, countdown, live status and a browser-wallet pay button.
6. **Learn the outcome**: add a webhook endpoint (dashboard, Webhooks) and verify every request (below). Polling
   `GET /v1/invoices/:id` also works.

Treat an order as paid only when status is `paid` or `overpaid` (later `settled`). Never on `detected`/`confirming`.
Non-custodial invoices move to `settled` right after `paid`/`overpaid`, once the platform fee is booked.
An `underpaid` or `late_payment` invoice can later become `paid` by a manual decision (event reason `manual: ...`).
`GET /v1/events` lists every status change (`invoice.paid`, `invoice.settled`, ...); `GET /v1/balances` sums what you received.
`GET /v1/invoices/:id` lists the on-chain `payments` (tx hash, amount, block, status). A payment mined before the deadline
counts even if it is detected later; one mined after it turns the invoice into `late_payment` (never auto-fulfilled).

## Amounts
Always decimal strings in token units: `"25.00"`. More decimals than the token supports are rejected, never rounded.
USDT on BSC has **18** decimals.

## Retries
Send an `Idempotency-Key` (your order id works) on every POST. Retrying with the same key and body is always safe.

## Webhooks
Each invoice status change is POSTed as JSON to every endpoint of that mode (test events only to test endpoints):

```json
{ "id": "0b1c…", "object": "event", "type": "invoice.paid", "livemode": false, "created_at": "2026-10-23T10:00:00.000Z",
  "data": { "invoice_id": "0192…", "status": "paid", "previous_status": "confirming", "token": "nexis:usdt",
            "amount_expected": "10", "amount_received": "10", "fee_amount": null, "external_order_id": "order-123",
            "reason": "confirmed payments cover the amount" } }
```

Types: `invoice.<status>` for every status after creation (`detected`, `confirming`, `paid`, `underpaid`, `overpaid`,
`settled`, `expired`, `cancelled`, `late_payment`, and `pending` when a detected payment was reorged away).
The same objects are listed by `GET /v1/events`.

- **Verify** the `gateway-signature` header (`t=<unix>,v1=<hex>[,v1=<hex>]`): HMAC-SHA256 of `"<t>.<raw body>"` keyed
  with your `whsec_…` secret; accept if any `v1` matches and `t` is within 5 minutes. Use the raw body bytes.
- **Respond 2xx within 10 s**, then do the work. Anything else (including redirects) is retried: 1 m, 5 m, 30 m, 2 h,
  5 h, then every 10 h, 12 attempts over about 2.4 days. The dashboard shows each delivery and can resend it.
- **Deduplicate** on the event `id` (also in the `gateway-event-id` header): delivery is at-least-once.
- **Order is not guaranteed.** Act on `data.status`, or fetch `GET /v1/invoices/:id` for the current state.
- **Rotating the secret** (dashboard): the old secret keeps signing alongside the new one for the window you choose.
- Endpoints must be public: private, loopback and link-local addresses are refused. To test locally, expose your
  receiver through a tunnel. Cancelling a test invoice produces an `invoice.cancelled` event.

Node.js
```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the exact bytes received (Buffer). Never re-serialize parsed JSON before verifying.
function verifyGatewayWebhook(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const got = Buffer.from(v, 'hex');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}
```

PHP
```php
// $rawBody = file_get_contents('php://input'); $header = $_SERVER['HTTP_GATEWAY_SIGNATURE'] ?? '';
function verify_gateway_webhook(string $rawBody, string $header, string $secret, int $tolerance = 300): bool {
    $t = null;
    $sigs = [];
    foreach (explode(',', $header) as $part) {
        [$k, $v] = array_pad(explode('=', $part, 2), 2, '');
        if ($k === 't' && ctype_digit($v)) $t = (int) $v;
        if ($k === 'v1') $sigs[] = $v;
    }
    if ($t === null || abs(time() - $t) > $tolerance) return false;
    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    foreach ($sigs as $sig) {
        if (hash_equals($expected, $sig)) return true;
    }
    return false;
}
```

Python
```python
import hashlib
import hmac
import time


# raw_body: the exact bytes received (e.g. Flask request.get_data(), Django request.body).
def verify_gateway_webhook(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in header.split(",") if "=" in p]
    ts = next((v for k, v in parts if k == "t"), "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")
```

Go
```go
// rawBody: the exact bytes received (read r.Body once, verify, then unmarshal).
func VerifyGatewayWebhook(rawBody []byte, header, secret string, tolerance time.Duration) bool {
	var ts string
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts = v
		case "v1":
			sigs = append(sigs, v)
		}
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false
	}
	if d := time.Since(time.Unix(t, 0)); d > tolerance || d < -tolerance {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(rawBody)
	expected := mac.Sum(nil)
	for _, s := range sigs {
		if got, err := hex.DecodeString(s); err == nil && hmac.Equal(got, expected) {
			return true
		}
	}
	return false
}
```

## Payment links (no code)
`POST /v1/payment-links` with `amount` and `token` returns a `url` you can share. Each customer who clicks
"Continue to payment" gets their own invoice and deposit address.

## Node SDK
`packages/sdk-node` (`@gw/sdk-node`): typed client with automatic idempotency keys and retries, and
`constructEvent(rawBody, signatureHeader, secret)` for webhooks. See its README.

## Checkout widget (no redirect)
Open the hosted checkout in a dialog on your own page:

1. Dashboard → Checkout widget: list the sites that may embed it (exact origins, e.g. `https://shop.example`).
2. Your backend creates the invoice with your secret key (`POST /v1/invoices`) and passes its `id` to the page.
3. On the page:

```html
<script src="https://<gateway>/widget.js"></script>
<script>
  GatewayCheckout.open({
    invoiceId: '<invoice id>',
    onStatus: (status) => {},   // pending, detected, confirming, paid, ...
    onPaid: () => {},           // once, when paid / overpaid / settled
    onClose: () => {},
  });
</script>
```

The checkout refuses to be framed by any site not on your list, and only talks to your page's exact origin. Treat
`onPaid` as a display hint: fulfil orders from the `invoice.paid` webhook or `GET /v1/invoices/:id`.

## Non-custodial wallet tips
Each invoice uses the next address of your xpub (`0/<index>`, shown in the dashboard). Invoices that expire unpaid leave
unused addresses; set your wallet's gap limit to the value the dashboard shows (Payout wallet → Derived addresses).

## Still to come
WooCommerce plugin (M10); go-live checklist for merchants before launch.
