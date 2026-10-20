/** Stable API error codes. Part of the public contract: add, never rename. */
export const ERROR_STATUS = {
  validation_error: 400,
  invalid_amount: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; request_id: string };
}
