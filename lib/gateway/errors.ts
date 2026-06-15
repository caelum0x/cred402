/**
 * Typed API errors + consistent response envelope (p2 §7.1, patterns.md).
 *
 * Every response — success or failure — uses one envelope shape, and every
 * error maps to an HTTP status + stable machine code. Internal details (stack
 * traces, DB errors) are logged server-side, never leaked to clients.
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
  request_id: string;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string };
  request_id: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T, request_id: string): ApiSuccess<T> {
  return { success: true, data, request_id };
}

export function fail(code: string, message: string, request_id: string): ApiFailure {
  return { success: false, error: { code, message }, request_id };
}

/** Base class for errors that are safe to surface to clients with a status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(400, "validation_error", message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "missing or invalid API key") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "insufficient scope") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "resource not found") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super(409, "conflict", message);
  }
}

export class RateLimitError extends ApiError {
  constructor(readonly retryAfterMs: number) {
    super(429, "rate_limited", "rate limit exceeded");
  }
}

/** Map any thrown value to a client-safe { status, code, message }. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  // Domain invariant violations from the ledger surface as 422, message-only.
  if (err instanceof Error) return new ApiError(422, "unprocessable", err.message);
  return new ApiError(500, "internal_error", "internal server error");
}
