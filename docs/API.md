# API

Base path `/v1`. OpenAPI 3.1 is generated from route schemas (M1 onward). This file covers conventions.

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
- **Idempotency** (`Idempotency-Key` header) on all state-changing POSTs, cursor pagination, rate-limit headers, and versioning/deprecation headers arrive with M1–M3.
- **Secrets never go in query strings.**

## Endpoints

| Method | Path | Auth | Since |
|---|---|---|---|
| GET | `/healthz` | none | M0 |
