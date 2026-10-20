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
- **Idempotency** (`Idempotency-Key` header) on state-changing merchant-API POSTs arrives with M3.
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
