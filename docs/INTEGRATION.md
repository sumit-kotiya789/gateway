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
     -d '{"amount":"25.00","token":"bsc-testnet:usdt","external_order_id":"1001","success_url":"https://shop.example/thanks"}'
   ```

5. **Send the customer to `checkout_url`** from the response (redirect, or link button). The hosted page shows the
   amount, address, QR code, network warning, countdown, live status and a browser-wallet pay button.
6. **Learn the outcome**: poll `GET /v1/invoices/:id` for now; signed webhooks (`invoice.paid`, …) arrive with M6.

Treat an order as paid only when status is `paid` or `overpaid` (later `settled`). Never on `detected`/`confirming`.
`GET /v1/invoices/:id` lists the on-chain `payments` (tx hash, amount, block, status). A payment mined before the deadline
counts even if it is detected later; one mined after it turns the invoice into `late_payment` (never auto-fulfilled).

## Amounts
Always decimal strings in token units: `"25.00"`. More decimals than the token supports are rejected, never rounded.
USDT on BSC has **18** decimals.

## Retries
Send an `Idempotency-Key` (your order id works) on every POST. Retrying with the same key and body is always safe.

## Payment links (no code)
`POST /v1/payment-links` with `amount` and `token` returns a `url` you can share. Each customer who clicks
"Continue to payment" gets their own invoice and deposit address.

## Non-custodial wallet tips
Each invoice uses the next address of your xpub (`0/<index>`, shown in the dashboard). Invoices that expire unpaid leave
unused addresses; if your wallet stops discovering addresses, raise its gap limit or scan up to the latest index.

## Still to come
Webhook verification snippets (Node, PHP, Python, Go) in M6; SDKs, widget and WooCommerce plugin in M10;
go-live checklist for merchants before launch.
