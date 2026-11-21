export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly httpStatus?: number,
    /** Machine-readable data a caller needs to recover; printed with --json. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
