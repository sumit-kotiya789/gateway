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
| GET | `/v1/balances` | API key | `read` (per token: `received`, `fees_owed`) | M5 |
| GET | `/v1/events`, `/v1/events/:id` | API key | `read` (`limit`, `starting_after`, `type`; newest first) | M5 |
| GET | `/checkout/:id`, `/checkout/:id/status` | public (invoice id) | – | M3 |
| GET, POST | `/pay/:id` | public (link id) | – (POST creates the invoice, 303 → checkout) | M3 |

## Invoices

```http
POST /v1/invoices
Authorization: Bearer sk_test_…
Idempotency-Key: order-1001
Content-Type: application/json

{ "amount": "25.00", "token": "bsc-testnet:usdt", "external_order_id": "1001",
  "expires_in": 1800, "success_url": "https://shop.example/thanks", "metadata": { "cart": "42" } }
```

Response `201` (abridged):

```json
{ "id": "01a1…", "object": "invoice", "status": "pending", "livemode": false, "custody_mode": "non_custodial_xpub",
  "amount": "25", "amount_received": "0", "token": "bsc-testnet:usdt", "symbol": "USDT", "chain": "bsc-testnet",
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
| GET | `/v1/dashboard/api-keys/` | session | `api_keys:read` | M1 |
| POST | `/v1/dashboard/api-keys/` | session + **2FA** | `api_keys:write` (returns full key once) | M1 |
| DELETE | `/v1/dashboard/api-keys/:id` | session | `api_keys:write` | M1 |
| GET | `/v1/dashboard/audit-logs/` | session | `audit:read` | M1 |
| GET | `/v1/dashboard/invoices/` | session | `invoices:read` (`livemode`, `limit`, `starting_after`, `status`, `external_order_id`) | M3b |
| GET | `/v1/dashboard/invoices/:id` | session | `invoices:read` (includes status `history`) | M3b |
| POST | `/v1/dashboard/invoices/` | session | `invoices:write` (`livemode` in body; no idempotency key) | M3b |
| POST | `/v1/dashboard/invoices/:id/cancel` | session | `invoices:write` | M3b |
| GET | `/v1/dashboard/tokens/` | session | – (`livemode`) | M3b |
| GET | `/v1/dashboard/xpubs/` | session | `account:read` (`livemode`; full xpub never returned) | M3b |
| POST | `/v1/dashboard/xpubs/preview` | session | `custody:manage` (first 5 addresses, no side effects) | M3b |
| POST | `/v1/dashboard/xpubs/` | session + **2FA** | `custody:manage` (retires the previous active xpub) | M3b |
| GET | `/v1/dashboard/webhooks/` | session | `webhooks:manage` (`livemode`) | M3b |
| POST | `/v1/dashboard/webhooks/` | session + **2FA** | `webhooks:manage` (returns signing secret once) | M3b |
| DELETE | `/v1/dashboard/webhooks/:id` | session | `webhooks:manage` | M3b |
| GET | `/v1/dashboard/balances/` | session | `account:read` (`livemode`) | M5 |
| POST | `/admin/v1/auth/login` | none | password + TOTP | M1 |
| POST | `/admin/v1/auth/logout` | admin session | `admin:read` | M1 |
| GET | `/admin/v1/auth/me` | admin session | `admin:read` | M1 |

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
