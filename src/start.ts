import { createSerializationAdapter } from '@tanstack/react-router';
import { createStart } from '@tanstack/react-start';
import { CodedError, type ErrorParams } from '~lib/error-codes';

type CodedErrorLike = Error & { code: string; params?: ErrorParams };

/**
 * Start's own Error serialization keeps only `message`, so a Server
 * Function's `AppError` / `CodedError` would lose the stable `code` the Web
 * UI translates. This adapter carries the code and params and revives the
 * error as a `CodedError` in the browser.
 */
const codedErrorAdapter = createSerializationAdapter({
  key: 'hatch-coded-error',
  test: (value: unknown): value is CodedErrorLike =>
    value instanceof Error &&
    typeof (value as { code?: unknown }).code === 'string',
  toSerializable: (error: CodedErrorLike) => ({
    message: error.message,
    code: error.code,
    params: error.params ?? null,
  }),
  fromSerializable: (value: {
    message: string;
    code: string;
    params: ErrorParams | null;
  }) =>
    new CodedError(
      value.message,
      value.code,
      value.params ?? undefined,
    ) as CodedErrorLike,
});

export const startInstance = createStart(() => ({
  serializationAdapters: [codedErrorAdapter],
}));
