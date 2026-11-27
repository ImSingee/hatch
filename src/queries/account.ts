/**
 * A per-account read answered for another account: the session changed
 * under the page. Asking again cannot help, so these reads do not retry it.
 */
export class AccountChangedError extends Error {
  constructor() {
    super('Your account changed. Reload the page to continue.');
    this.name = 'AccountChangedError';
  }
}

/** Retry a failed account read as usual, but never an account change. */
export function retryUnlessAccountChanged(
  failureCount: number,
  error: Error,
): boolean {
  return !(error instanceof AccountChangedError) && failureCount < 3;
}
