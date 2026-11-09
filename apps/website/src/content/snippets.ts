// Code samples shown on the site. They match the merchant API (docs/API.md) and the Node SDK (packages/sdk-node).
import type { CodeTab } from '../ui/Code';

export const BASE = 'https://pay.example.com';

export const depositNode = `import { Gateway } from '@gw/sdk-node';

const gateway = new Gateway({
  apiKey: process.env.GATEWAY_SECRET_KEY,   // sk_test_… or sk_live_…
  baseUrl: '${BASE}',
});

// Same user + same token = the same address, forever.
const account = await gateway.depositAccounts.create({
  customer_ref: user.id,
  token: 'bsc-testnet:usdt',
});

showDepositAddress(account.address);   // 0x…, BNB Smart Chain (BEP-20)`;

export const depositCurl = `curl ${BASE}/v1/deposit-accounts \\
  -H "Authorization: Bearer sk_test_..." \\
  -H "Content-Type: application/json" \\
  -d '{"customer_ref":"user-42","token":"bsc-testnet:usdt"}'`;

export const depositPython = `import os, requests

res = requests.post(
    "${BASE}/v1/deposit-accounts",
    headers={"Authorization": f"Bearer {os.environ['GATEWAY_SECRET_KEY']}"},
    json={"customer_ref": "user-42", "token": "bsc-testnet:usdt"},
    timeout=30,
)
account = res.json()
print(account["address"])   # show it to the user`;

export const webhookNode = `import express from 'express';
import { constructEvent } from '@gw/sdk-node';

app.post('/webhooks/gateway', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    // Verifies HMAC-SHA256 over "<t>.<raw body>" and the 5-minute timestamp window.
    event = constructEvent(req.body, req.get('gateway-signature'), process.env.GATEWAY_WHSEC);
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(200);                      // answer fast, then work

  if (event.type === 'invoice.settled' && event.data.kind === 'deposit') {
    const inv = await gateway.invoices.retrieve(event.data.invoice_id);
    await creditOnce(inv.id, inv.customer_ref, inv.amount_received);   // idempotent by invoice id
  }
});`;

export const payoutNode = `// Debit the user in your own ledger first, then ask for the payout.
const payout = await gateway.payouts.create(
  {
    customer_ref: 'user-42',
    to_address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    token: 'bsc-testnet:usdt',
    amount: '25',
  },
  { idempotencyKey: withdrawalRequest.id },   // a retry never pays twice
);

// payout.status: approved → sent → confirmed   (webhooks: payout.*)
// On payout.failed, refund the user in your app.`;

export const invoiceNode = `const invoice = await gateway.invoices.create(
  {
    amount: '25.00',
    token: 'bsc-testnet:usdt',
    external_order_id: 'order-1001',
    success_url: 'https://shop.example/thanks',
    expires_in: 1800,
  },
  { idempotencyKey: 'order-1001' },
);

redirect(invoice.checkout_url);   // hosted page: amount, QR, countdown, live status`;

export const homeTabs: CodeTab[] = [
  { label: 'deposit.ts', lang: 'js', code: depositNode },
  { label: 'webhook.ts', lang: 'js', code: webhookNode },
  { label: 'payout.ts', lang: 'js', code: payoutNode },
  { label: 'curl', lang: 'bash', code: depositCurl },
  { label: 'python', lang: 'python', code: depositPython },
];

export const verifyNode = `import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the exact bytes received (Buffer). Never re-serialize parsed JSON before verifying.
function verifyGatewayWebhook(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\`).update(rawBody).digest();
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const got = Buffer.from(v, 'hex');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}`;

export const verifyPython = `import hashlib
import hmac
import time


# raw_body: the exact bytes received (e.g. Flask request.get_data(), Django request.body).
def verify_gateway_webhook(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in header.split(",") if "=" in p]
    ts = next((v for k, v in parts if k == "t"), "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")`;

export const verifyPhp = `// $rawBody = file_get_contents('php://input'); $header = $_SERVER['HTTP_GATEWAY_SIGNATURE'] ?? '';
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
}`;

export const verifyGo = `// rawBody: the exact bytes received (read r.Body once, verify, then unmarshal).
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
}`;

export const verifyTabs: CodeTab[] = [
  { label: 'Node.js', lang: 'js', code: verifyNode },
  { label: 'Python', lang: 'python', code: verifyPython },
  { label: 'PHP', lang: 'php', code: verifyPhp },
  { label: 'Go', lang: 'go', code: verifyGo },
];

export const eventJson = `{
  "id": "0193a4f0-2b1c-7e55-8d0a-6f1e2c3b4a59",
  "object": "event",
  "type": "invoice.settled",
  "livemode": false,
  "created_at": "2026-11-09T10:00:12.000Z",
  "data": {
    "invoice_id": "0193a4ef-91d2-7c3a-b6e4-0f8a7d6c5b41",
    "status": "settled",
    "previous_status": "paid",
    "token": "bsc-testnet:usdt",
    "kind": "deposit",
    "customer_ref": "user-42",
    "deposit_account_id": "0193a1c2-55aa-7f10-9b3e-2d4c6e8f0a12",
    "amount_expected": "250",
    "amount_received": "250",
    "fee_amount": "2.5",
    "external_order_id": null,
    "sub_merchant_id": null,
    "reason": "platform fee charged"
  }
}`;

export const widgetHtml = `<script src="${BASE}/widget.js"></script>
<script>
  GatewayCheckout.open({
    invoiceId: '<invoice id from your backend>',
    onStatus: (status) => {},   // pending, detected, confirming, paid, ...
    onPaid: () => {},           // once, when paid / overpaid / settled
    onClose: () => {},
  });
</script>`;
