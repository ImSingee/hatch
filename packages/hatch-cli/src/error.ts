export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * A preparation failure, named by `code` unless `error` is a missing tool or a
 * timeout (exit 7). Those say nothing about the source, so they keep their own
 * code and exit status and gain only the stage in the message.
 */
export function preparationFailure(
  code: string,
  message: string,
  error: unknown,
  signal: AbortSignal,
): CliError {
  if (signal.aborted) return new CliError(code, message, 130);
  return error instanceof CliError && error.exitCode === 7
    ? new CliError(error.code, message, 7)
    : new CliError(code, message, 6);
}
