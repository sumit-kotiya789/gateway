# WooCommerce plugin

`gateway-crypto/` is a WordPress plugin that adds "Pay with USDT" to WooCommerce (classic and block checkout). Each
order gets a gateway invoice; the customer pays on the hosted checkout; the order follows the invoice.

Requirements: WordPress 6.4+, WooCommerce 8.3+, PHP 7.4+, store currency USD (USDT is priced 1:1). HPOS compatible.

## Install
1. `cd integrations/woocommerce && zip -r gateway-crypto.zip gateway-crypto`
2. WordPress admin → Plugins → Add New → Upload Plugin → `gateway-crypto.zip` → Activate.
3. WooCommerce → Settings → Payments → Crypto (USDT):
   - **Gateway URL**: the API base, e.g. `https://pay.example`.
   - **Secret API key**: `sk_test_…` first (scopes `read`, `invoices:write`); `sk_live_…` to go live.
   - **Token**: `nexis:usdt` with a test key, `bsc:usdt` with a live key.
   - **Webhook secret**: in the gateway dashboard add a webhook endpoint for the URL shown under the field
     (`https://<shop>/wp-json/gateway-crypto/v1/webhook`) and paste its `whsec_…` secret.
4. Place a test order and pay it with the test token.

## How orders move
| Invoice | Order |
|---|---|
| created | Pending payment (customer sent to the hosted checkout) |
| detected / confirming | On hold, "do not ship yet" |
| paid / overpaid / settled | Processing (`payment_complete`, transaction id = invoice id) |
| underpaid / late_payment | On hold with the amounts; resolve in the gateway dashboard (a manual `paid` then completes the order) |
| held (gateway risk review) | On hold, "do not ship"; release then completes the order |
| failed (review rejected) | Failed (current invoice only) |
| expired / cancelled | Cancelled (only the order's current invoice, only while pending) |

- The plugin never trusts an event body: after verifying the signature it re-reads the invoice from the API and
  applies its current state, so out-of-order or repeated webhooks are harmless.
- A paid invoice whose amount differs from the order total (order edited afterwards) puts the order on hold instead.
- No webhook configured or delivered yet: the thank-you page re-reads the invoice when the customer returns.
- Returning to the pay page reuses the open invoice (same address) while it is pending and the total is unchanged;
  otherwise a new invoice is made with `external_order_id` `<order>-2`, `<order>-3`, … (unique per merchant).

## Tests
- `php integrations/woocommerce/test/selfcheck.php`: signature check (vector from the server's own signer) and exact
  amount comparison. Runs in CI.
- `bash integrations/woocommerce/test/e2e/e2e.sh`: real WordPress + WooCommerce in Docker against a mock gateway API;
  every row of the table above. Needs Docker and internet; not in CI.
