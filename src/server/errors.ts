/**
 * Server-only: structured errors for API routes and server functions.
 *
 * Server code should throw `AppError` (or a subclass) with the HTTP status the
 * failure maps to; HTTP route handlers convert any thrown value with
 * `errorResponse`. This keeps status codes out of error-message string
 * matching, where a copy tweak would silently change HTTP semantics.
 */

import { ERROR_CODE_HEADER, ERROR_PARAMS_HEADER } from '~lib/error-codes';

export type AppErrorDetails = {
  /**
   * Stable identifier the Web UI translates (`error.<code>` in the
   * catalogs). The English `message` stays for the CLI, RPC and logs.
   */
  code?: string;
  /** Values the translated sentence interpolates. */
  params?: Record<string, string | number>;
};

export class AppError extends Error {
  /** HTTP status an API route should respond with for this failure. */
  status: number;
  code?: string;
  params?: Record<string, string | number>;

  constructor(message: string, status = 400, details: AppErrorDetails = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    if (details.code) this.code = details.code;
    if (details.params) this.params = details.params;
  }
}

/**
 * Map a thrown value to an HTTP Response: `AppError` (and subclasses) carry
 * their own status; anything else gets `fallbackStatus` with its message.
 */
export function errorResponse(error: unknown, fallbackStatus = 400): Response {
  const status = error instanceof AppError ? error.status : fallbackStatus;
  const headers = new Headers();
  if (error instanceof AppError && error.code) {
    headers.set(ERROR_CODE_HEADER, error.code);
    if (error.params) {
      headers.set(
        ERROR_PARAMS_HEADER,
        encodeURIComponent(JSON.stringify(error.params)),
      );
    }
  }
  return new Response(error instanceof Error ? error.message : String(error), {
    status,
    headers,
  });
}
