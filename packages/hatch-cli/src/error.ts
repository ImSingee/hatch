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

/**
 * The `invalid_arguments` error for a `node:util` parseArgs failure, naming
 * the flag to fix instead of a generic "invalid arguments".
 */
export function argumentsError(error: unknown, command: string): CliError {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  // Node quotes the option as '--name', '-n, --name' or '--name <value>'.
  const flag =
    /--[A-Za-z0-9][\w-]*/.exec(message)?.[0] ??
    /'(-[A-Za-z0-9])/.exec(message)?.[1];
  const help = `Use hatch help ${command}.`;
  if (flag && code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION')
    return new CliError(
      'invalid_arguments',
      `${flag} is not a flag of this command. ${help}`,
    );
  if (flag && code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE')
    return new CliError(
      'invalid_arguments',
      /does not take an argument/.test(message)
        ? `${flag} does not take a value.`
        : // Missing, or followed by another flag ("ambiguous").
          `${flag} needs a value.`,
    );
  const detail = message.split('\n')[0];
  return new CliError(
    'invalid_arguments',
    `Invalid arguments${detail ? `: ${detail}` : ''}. ${help}`,
  );
}
