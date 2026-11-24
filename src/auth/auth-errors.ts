/** The error a Better Auth client call reports in its result. */
export type AuthClientError = {
  code?: string;
  message?: string;
  status?: number;
};

/**
 * Re-code a Better Auth client error for `translateError`: its bare codes
 * (`INVALID_EMAIL_OR_PASSWORD`) translate through `error.auth.<CODE>`. The
 * rate limiter answers without a code, so a 429 gets `RATE_LIMITED`.
 */
export function authErrorOf(error: AuthClientError | null | undefined): {
  code?: string;
  message?: string;
} {
  const code =
    error?.code || (error?.status === 429 ? 'RATE_LIMITED' : undefined);
  return {
    code: code ? `auth.${code}` : undefined,
    message: error?.message?.trim() || undefined,
  };
}
