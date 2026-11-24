/**
 * How an `AppError`'s stable code travels to the Web UI. Server Functions
 * serialize the error's own `code` and `params` properties; plain HTTP routes
 * put them in these response headers next to the English message body.
 */
export const ERROR_CODE_HEADER = 'Hatch-Error-Code';
/** URI-encoded JSON object of interpolation values. */
export const ERROR_PARAMS_HEADER = 'Hatch-Error-Params';

export type ErrorParams = Record<string, string | number>;

/** An error that may carry a stable code for the UI to translate. */
export class CodedError extends Error {
  code?: string;
  params?: ErrorParams;

  constructor(message: string, code?: string, params?: ErrorParams) {
    super(message);
    this.name = 'CodedError';
    if (code) this.code = code;
    if (params) this.params = params;
  }
}

/** Build an error from a failed HTTP response's body text and code headers. */
export function errorFromResponse(response: Response, message: string) {
  const code = response.headers.get(ERROR_CODE_HEADER) ?? undefined;
  const rawParams = response.headers.get(ERROR_PARAMS_HEADER);
  let params: ErrorParams | undefined;
  if (rawParams) {
    try {
      params = JSON.parse(decodeURIComponent(rawParams)) as ErrorParams;
    } catch {
      params = undefined;
    }
  }
  return new CodedError(message, code, params);
}
