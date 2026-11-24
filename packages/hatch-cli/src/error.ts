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

// Socket errors raised before a connection exists, so no request byte left.
const NOT_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function neverConnected(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 8) return false;
  const { code, cause, errors } = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof code === 'string' && NOT_CONNECTED.has(code)) return true;
  // Dual-stack hosts such as localhost reject with one error per address.
  if (Array.isArray(errors) && errors.length > 0)
    return errors.every((item) => neverConnected(item, depth + 1));
  return neverConnected(cause, depth + 1);
}

/**
 * The error for a `fetch` to the platform at `url` that rejected without a
 * response. A failure before the connection opened sent nothing, so it is a
 * plain `network_error`; any later failure may have reached the platform.
 */
export function fetchFailure(url: string, error: unknown): CliError {
  return neverConnected(error)
    ? new CliError(
        'network_error',
        `Cannot connect to the platform at ${url}. Check that it is running and that the URL is correct.`,
        7,
      )
    : new CliError(
        'outcome_unknown',
        `The connection to the platform at ${url} failed. Inspect platform state before retrying mutations.`,
        7,
      );
}
