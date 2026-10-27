# API

OpenAPI 3.1 is generated from route schemas and served at `GET /v1/openapi.json`. This file covers conventions.

## Conventions

- **Amounts** are decimal strings in token units (`"25.5"`), never JSON numbers. Excess precision is rejected, not rounded. Responses use canonical form (no trailing zeros).
- **Errors** always use this envelope:

  ```json
  { "error": { "code": "validation_error", "message": "invalid request", "details": [], "request_id": "..." } }
  ```

  | code | HTTP |
  |---|---|
  | validation_error, invalid_amount | 400 |
  | unauthorized | 401 |
  | insufficient_fee_balance (live invoice, prepaid fees used up) | 402 |
  | forbidden | 403 |
  | not_found | 404 |
  | conflict, idempotency_conflict | 409 |
  | payload_too_large | 413 |
  | rate_limited | 429 |
  | internal_error | 500 |
  | service_unavailable | 503 |

  Codes are stable; new codes may be added.
- **Request id**: every response has `x-request-id`. You may send your own (`[A-Za-z0-9._-]{8,128}`); otherwise one is generated.
- **Unknown fields** in request bodies are rejected.
- **Body size** limit: 100 KB.
- **Rate limits**: 300 requests/min per API key (or per IP when unauthenticated); 10/min per IP on auth routes.
  Headers: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, and `retry-after` on 429.
- **Pagination**: `limit` (max 100) + `starting_after` cursor; responses carry `has_more` and `next_cursor`.
- **Idempotency**: send `Idempotency-Key: <1-255 printable ASCII>` on any state-changing merchant-API POST. A retry with
  the same key and body returns the original response with `idempotent-replayed: true`; the same key with a different
  body returns `409 idempotency_conflict`. Failed requests do not consume the key. Keys are scoped per merchant and mode.
- **Secrets never go in query strings.**

## Authentication

| Surface | Credential | Notes |
|---|---|---|
| Merchant API `/v1/*` | `Authorization: Bearer sk_live_…` / `sk_test_…` | Scopes: `read`, `invoices:write`, `refunds:write`, `withdrawals:write`, `webhooks:write`. Optional IP allowlist and expiry. |
| Widget | `pk_live_…` / `pk_test_…` | Scope `checkout` only. |
| Dashboard `/v1/dashboard/*` | `gw_at` cookie (10-min JWT) + `gw_rt` refresh cookie | State-changing requests need `x-csrf-token` = `gw_csrf` cookie, and an allowlisted `Origin`. |
| Admin `/admin/v1/*` | `gw_admin_at` cookie (15-min JWT) | Password + TOTP on every login; `x-csrf-token` = `gw_admin_csrf`; optional IP allowlist. |

Step-up: endpoints marked **2FA** need header `x-totp-code` with a fresh code (a code is accepted once).

Live mode (M10): creating live API keys, xpubs, dashboard invoices and webhook endpoints needs the acting user's
verified email (`403`, `details.reason = "email_unverified"`). `GET /auth/me` returns `user.email_verified`.

## Endpoints

| Method | Path | Auth | Permission / scope | Since |
|---|---|---|---|---|
| GET | `/healthz` | none | – | M0 |
| GET | `/readyz` | none | – (db, redis) | M1 |
| GET | `/v1/openapi.json` | none | – | M1 |
| GET | `/v1/account` | API key | `read` | M1 |
| GET | `/v1/chains` | API key | `read` (test keys: testnets only; live keys: mainnets only) | M2 |
| GET | `/v1/tokens` | API key | `read` (same filter; `min_amount` is a decimal string) | M2 |
| POST | `/v1/invoices` | API key | `invoices:write` | M3 |
| GET | `/v1/invoices` | API key | `read` (`limit`, `starting_after`, `status`, `external_order_id`) | M3 |
| GET | `/v1/invoices/:id` | API key | `read` (includes on-chain `payments`, M4) | M3 |
| POST | `/v1/invoices/:id/cancel` | API key | `invoices:write` (pending only) | M3 |
| POST | `/v1/payment-links` | API key | `invoices:write` | M3 |
| GET | `/v1/payment-links`, `/v1/payment-links/:id` | API key | `read` | M3 |
| PATCH | `/v1/payment-links/:id` | API key | `invoices:write` (affects future invoices only) | M3 |
| DELETE | `/v1/payment-links/:id` | API key | `invoices:write` (deactivates) | M3 |
| GET | `/v1/balances` | API key | `read` (per token: `received`, `fees_charged`, `fees_owed` (charged, not covered by top-ups), `prepaid_fees` (signed), `fee_status` ok / low / blocked / not_enforced; custodial: `pending` (not swept yet), `available` (withdrawable), `withdrawing`; top-level `custody_mode`; live keys also list every usable live token) | M5/M8/M7 |
| GET | `/v1/events`, `/v1/events/:id` | API key | `read` (`limit`, `starting_after`, `type`; newest first) | M5 |
| POST | `/v1/withdrawals` | API key | `withdrawals:write` (`token`, `amount`; custodial; to the current payout address; Idempotency-Key; held at once) | M7 |
| GET | `/v1/withdrawals`, `/v1/withdrawals/:id` | API key | `read` | M7 |
| GET | `/v1/exports/invoices.csv`, `/v1/exports/payments.csv` | API key | `read` (the key's mode; `from`, `to` as UTC dates, default last 31 days, ≤ 366 days, ≤ 50,000 rows; 10/min per key; audited as the key) | M10 |
| GET | `/checkout/:id`, `/checkout/:id/status` | public (invoice id) | – | M3 |
| GET | `/checkout/:id?embed=1&origin=<site>` | public | – (framable only by the merchant's allowlisted `origin`; posts status to it) | M10 |
| GET | `/widget.js` | public | – (embeddable widget; `Cross-Origin-Resource-Policy: cross-origin`) | M10 |
| GET, POST | `/pay/:id` | public (link id) | – (POST creates the invoice, 303 → checkout) | M3 |

## Invoices

```http
POST /v1/invoices
Authorization: Bearer sk_test_…
Idempotency-Key: order-1001
Content-Type: application/json

{ "amount": "25.00", "token": "nexis:usdt", "external_order_id": "1001",
  "expires_in": 1800, "success_url": "https://shop.example/thanks", "metadata": { "cart": "42" } }
```

Response `201` (abridged):

```json
{ "id": "01a1…", "object": "invoice", "status": "pending", "livemode": false, "custody_mode": "non_custodial_xpub",
  "amount": "25", "amount_received": "0", "token": "nexis:usdt", "symbol": "USDT", "chain": "nexis",
  "deposit_address": "0x…", "payment_uri": "ethereum:0xToken@97/transfer?address=0x…&uint256=25000000000000000000",
  "checkout_url": "https://pay.example/checkout/01a1…", "expires_at": "…" }
```

Fields: `amount` decimal string (≤ token decimals, ≥ token minimum); `expires_in` 300–86400 s (default 1800);
`metadata` ≤ 50 string keys/values, ≤ 4 KB; URLs http(s), https only in production.

Statuses: `pending → detected → confirming → paid | underpaid | overpaid → settled`; also `expired`, `cancelled`,
`failed`, `late_payment`. Payments after expiry become `late_payment` and are never auto-fulfilled.
| POST | `/v1/dashboard/auth/signup` | none | – | M1 |
| POST | `/v1/dashboard/auth/login` | none | – (returns `mfa_required` + `mfa_token` when 2FA on) | M1 |
| POST | `/v1/dashboard/auth/login/2fa` | `mfa_token` | `code` or `recovery_code` | M1 |
| POST | `/v1/dashboard/auth/refresh` | refresh cookie | – | M1 |
| POST | `/v1/dashboard/auth/logout` | refresh cookie | – | M1 |
| GET | `/v1/dashboard/auth/me` | session | – | M1 |
| POST | `/v1/dashboard/auth/2fa/setup` | session | – | M1 |
| POST | `/v1/dashboard/auth/2fa/enable` | session | – (returns 10 recovery codes once) | M1 |
| POST | `/v1/dashboard/auth/verify-email` | none | – (`token` from the emailed link; single use, 48 h) | M10 |
| POST | `/v1/dashboard/auth/verify-email/resend` | session | – (202; 429 within a minute of the last link; 409 when verified) | M10 |
| POST | `/v1/dashboard/auth/password/forgot` | none | – (`email`; always 202; one email per minute per account) | M10 |
| POST | `/v1/dashboard/auth/password/reset` | none | – (`token`, `password`, plus `code` or `recovery_code` when 2FA is on; revokes every session) | M10 |
| POST | `/v1/dashboard/auth/2fa/recovery-codes` | session + **2FA** | – (10 new codes, shown once; earlier codes stop working) | M10 |
| POST | `/v1/dashboard/auth/invite/preview` | none | – (`token`: merchant name, email, role) | M10 |
| POST | `/v1/dashboard/auth/invite/accept` | none | – (`token`, `password`; creates or reactivates the member, verified, signed in) | M10 |
| GET | `/v1/dashboard/team/` | session | `account:read` (active members + open invitations) | M10 |
| POST | `/v1/dashboard/team/invites` | session + **2FA** | `team:manage` (`email`, `role`; admins: developer / finance / read_only only; 7-day link) | M10 |
| DELETE | `/v1/dashboard/team/invites/:id` | session | `team:manage` | M10 |
| POST | `/v1/dashboard/team/members/:id/role` | session + **2FA** | `team:manage` (`role`; not yourself; signs the member out) | M10 |
| DELETE | `/v1/dashboard/team/members/:id` | session + **2FA** | `team:manage` (not yourself; the merchant keeps an owner) | M10 |
| GET | `/v1/dashboard/api-keys/` | session | `api_keys:read` | M1 |
| POST | `/v1/dashboard/api-keys/` | session + **2FA** | `api_keys:write` (returns full key once) | M1 |
| DELETE | `/v1/dashboard/api-keys/:id` | session | `api_keys:write` | M1 |
| GET | `/v1/dashboard/audit-logs/` | session | `audit:read` | M1 |
| GET | `/v1/dashboard/invoices/` | session | `invoices:read` (`livemode`, `limit`, `starting_after`, `status`, `external_order_id`) | M3b |
| GET | `/v1/dashboard/invoices/:id` | session | `invoices:read` (includes status `history`) | M3b |
| POST | `/v1/dashboard/invoices/` | session | `invoices:write` (`livemode` in body; no idempotency key) | M3b |
| POST | `/v1/dashboard/invoices/:id/cancel` | session | `invoices:write` | M3b |
| GET | `/v1/dashboard/tokens/` | session | – (`livemode`) | M3b |
| GET | `/v1/dashboard/xpubs/` | session | `account:read` (`livemode`; full xpub never returned; `pending_change` when a live change waits out its cooldown) | M3b/M8 |
| POST | `/v1/dashboard/xpubs/preview` | session | `custody:manage` (`xpub`, `livemode`: first 5 addresses + ownership challenge to sign with address 0/0; seed phrases / private keys refused and audited) | M3b/M8 |
| POST | `/v1/dashboard/xpubs/` | session + **2FA** | `custody:manage` (`livemode`, `xpub`, `ownership: { issued_at, signature }` required for live; 201 active now, or 202 `pending_change` when replacing a live xpub: applies after 24 h) | M3b/M8 |
| POST | `/v1/dashboard/xpubs/changes/:id/cancel` | session | `custody:manage` (pending changes only) | M8 |
| GET | `/v1/dashboard/xpubs/:id/addresses` | session | `account:read` (`offset`, `limit`: derived addresses with their invoice; `wallet_gap_limit`, `highest_used_index`) | M8 |
| GET | `/v1/dashboard/webhooks/` | session | `webhooks:manage` (`livemode`) | M3b |
| POST | `/v1/dashboard/webhooks/` | session + **2FA** | `webhooks:manage` (returns signing secret once) | M3b |
| DELETE | `/v1/dashboard/webhooks/:id` | session | `webhooks:manage` (also deletes its delivery log) | M3b |
| POST | `/v1/dashboard/webhooks/:id/rotate-secret` | session + **2FA** | `webhooks:manage` (`expire_previous_in_hours` 0-72, default 24; returns the new secret once) | M6 |
| GET | `/v1/dashboard/webhooks/:id/deliveries` | session | `webhooks:manage` (`limit`, `starting_after`; newest first) | M6 |
| POST | `/v1/dashboard/webhooks/:id/deliveries/:deliveryId/retry` | session | `webhooks:manage` (finished deliveries only; fresh retry budget) | M6 |
| GET | `/v1/dashboard/balances/` | session | `account:read` (`livemode`) | M5 |
| GET | `/v1/dashboard/fee-topups/` | session | `account:read` (`livemode`; newest first) | M8 |
| GET | `/v1/dashboard/exports/invoices.csv`, `/v1/dashboard/exports/payments.csv` | session | `reports:read` (`livemode`, `from`, `to` as UTC dates, default last 31 days, ≤ 366 days, ≤ 50,000 rows; 10/min; audited) | M10 |
| GET | `/v1/dashboard/withdrawals/` | session | `account:read` (`livemode`, `starting_after`) | M7 |
| POST | `/v1/dashboard/withdrawals/` | session + **2FA** | `withdrawals:request` (`livemode`, `token`, `amount`; verified email for live) | M7 |
| POST | `/v1/dashboard/withdrawals/:id/cancel` | session | `withdrawals:request` (while awaiting approval) | M7 |
| GET | `/v1/dashboard/withdrawals/payout-addresses` | session | `account:read` (`livemode`; status current / pending / superseded / cancelled) | M7 |
| POST | `/v1/dashboard/withdrawals/payout-addresses` | session + **2FA** | `payouts:manage` (`livemode`, `address` (EIP-55 checked), `label`; live: active after 24 h, owners emailed) | M7 |
| POST | `/v1/dashboard/withdrawals/payout-addresses/:id/cancel` | session | `payouts:manage` (only before it is active) | M7 |
| GET | `/v1/dashboard/settings/` | session | `account:read` (`widget_origins`) | M10 |
| PUT | `/v1/dashboard/settings/widget-origins` | session | `settings:manage` (`widget_origins`: ≤ 10 exact origins, https in production; audited) | M10 |
| POST | `/admin/v1/auth/login` | none | password + TOTP | M1 |
| POST | `/admin/v1/auth/logout` | admin session | `admin:read` | M1 |
| GET | `/admin/v1/auth/me` | admin session | `admin:read` | M1 |
| GET | `/admin/v1/merchants` | admin session | `admin:read` (`q`: name fragment, merchant id or user email; `status`, `flag`, `limit`, `starting_after`) | M5b |
| GET | `/admin/v1/merchants/:id` | admin session | `admin:read` (users, balances per mode) | M5b |
| POST | `/admin/v1/merchants/:id/suspend` | admin session | `merchants:manage` (`reason`) | M5b |
| POST | `/admin/v1/merchants/:id/reactivate` | admin session + **2FA** | `merchants:manage` (`reason`) | M5b |
| PUT | `/admin/v1/merchants/:id/risk-flags` | admin session | `risk:manage` (`flags`, `reason`; replaces the set) | M5b |
| PUT | `/admin/v1/merchants/:id/fees` | admin session + **2FA** | `fees:manage` (`fee_bps`, `fee_fixed`, `fee_grace` in token units ≤ 6 dp, `reason`; new invoices only) | M8 |
| GET | `/admin/v1/merchants/:id/fee-topups` | admin session | `admin:read` (`livemode`, default true) | M8 |
| POST | `/admin/v1/merchants/:id/fee-topups` | admin session + **2FA** | `fees:manage` (`livemode`, `token`, `amount`, `reference`, `reason`; posts a ledger journal; append-only) | M8 |
| POST | `/admin/v1/merchants/:id/users/:userId/reset-2fa` | admin session + **2FA** | `merchants:manage` (`reason`; revokes sessions, deletes recovery codes) | M5b |
| GET | `/admin/v1/invoices`, `/admin/v1/invoices/:id` | admin session | `admin:read` (default list: `underpaid` + `late_payment`; `status`, `merchant_id`, `livemode`) | M5b |
| POST | `/admin/v1/invoices/:id/resolve` | admin session + **2FA** | `invoices:resolve` (`reason`; underpaid/late_payment -> paid -> settled) | M5b |
| GET | `/admin/v1/registry` | admin session | `admin:read` (chains and tokens with `enabled`) | M5b |
| POST | `/admin/v1/registry/:kind/:id/disable` | admin session | `kill_switch:manage` (`kind`: chain or token; `reason`) | M5b |
| POST | `/admin/v1/registry/:kind/:id/enable` | admin session + **2FA** | `registry:enable` (`reason`) | M5b |
| GET | `/admin/v1/admins/` | admin session | `admins:manage` (every admin account) | M9 |
| POST | `/admin/v1/admins/` | admin session + **2FA** | `admins:manage` (`email`, `role`, `reason`; returns `password`, `totp_uri`, `qr_svg` once) | M9 |
| PUT | `/admin/v1/admins/:id/role` | admin session + **2FA** | `admins:manage` (`role`, `reason`; not yourself; a superadmin remains; applies to open sessions at once) | M9 |
| POST | `/admin/v1/admins/:id/disable` | admin session | `admins:manage` (`reason`; not yourself; a superadmin remains) | M9 |
| POST | `/admin/v1/admins/:id/enable` | admin session + **2FA** | `admins:manage` (`reason`; clears lockout) | M9 |
| POST | `/admin/v1/admins/:id/reset-credentials` | admin session + **2FA** | `admins:manage` (`reason`; new password + TOTP shown once; signs the admin out everywhere) | M9 |
| GET | `/admin/v1/withdrawals/` | admin session | `admin:read` (`status`, default `pending_approval`; `merchant_id`) | M7 |
| POST | `/admin/v1/withdrawals/:id/approve` | admin session + **2FA** | `withdrawals:approve` (`reason`; two different admins at or above `WITHDRAWAL_TWO_PERSON_MIN`) | M7 |
| POST | `/admin/v1/withdrawals/:id/reject` | admin session | `withdrawals:approve` (`reason`; releases the hold) | M7 |
| GET | `/admin/v1/custody/` | admin session | `admin:read` (signer state, platform wallets, custody totals, open sweeps, withdrawal queue) | M7 |
| POST | `/admin/v1/custody/signer/pause` | admin session | `kill_switch:manage` (`reason`; the signer refuses everything) | M7 |
| POST | `/admin/v1/custody/signer/resume` | admin session + **2FA** | `registry:enable` (`reason`) | M7 |
| GET | `/admin/v1/custody/treasury` | admin session | `admin:read` | M7 |
| POST | `/admin/v1/custody/treasury` | admin session + **2FA** | `treasury:manage` (`livemode`, `token`, `direction` to_cold / to_hot, `amount`, `tx_hash` for to_hot, `reason`) | M7 |
| POST | `/admin/v1/custody/treasury/:id/approve` | admin session + **2FA** | `treasury:manage` (a different admin than the proposer) | M7 |
| POST | `/admin/v1/custody/treasury/:id/reject` | admin session | `treasury:manage` | M7 |
| GET | `/admin/v1/audit-logs` | admin session | `audit:read` (`merchant_id`, `actor_id`, `action` prefix, `limit`, `starting_after` seq) | M5b |
| GET | `/admin/v1/audit-logs/verify` | admin session | `audit:read` (`{ intact, first_bad_seq }`) | M5b |

## Roles

| Permission | owner | admin | developer | finance | read_only |
|---|---|---|---|---|---|
| account:read, invoices:read | ✓ | ✓ | ✓ | ✓ | ✓ |
| reports:read | ✓ | ✓ | | ✓ | ✓ |
| invoices:write | ✓ | ✓ | ✓ | ✓ | |
| api_keys:read/write, webhooks:manage | ✓ | ✓ | ✓ | | |
| refunds:write | ✓ | ✓ | | ✓ | |
| withdrawals:request | ✓ | | | ✓ | |
| payouts:manage, custody:manage | ✓ | | | | |
| team:manage, settings:manage, audit:read | ✓ | ✓ | | | |

Source of truth: `packages/core/src/rbac.ts`.

Admin step-up (**2FA** above): fresh code in `x-totp-code`, for actions that lower a safety control (D-064).

| Admin permission | superadmin | operator | auditor |
|---|---|---|---|
| admin:read | ✓ | ✓ | ✓ |
| audit:read | ✓ | | ✓ |
| merchants:manage, risk:manage, kill_switch:manage, invoices:resolve | ✓ | ✓ | |
| registry:enable, admins:manage | ✓ | | |
