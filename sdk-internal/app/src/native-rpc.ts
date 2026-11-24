// @ts-self-types="./native-rpc.d.ts"
/**
 * @hatch/app/native/rpc — a Connect transport for an App on the native (NSH)
 * runtime. Unary calls cross the host bridge as `hatch.rpc` with the Connect
 * JSON codec; the shell performs the HTTP request against this App's own
 * backend. Streaming RPC is not available on the native runtime, and a call
 * cannot be cancelled once sent: it ends with an answer or its timeout.
 */
import {
  create,
  fromJson,
  toJson,
  type DescMessage,
  type DescMethodUnary,
  type JsonValue,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type Transport,
  type UnaryResponse,
} from '@connectrpc/connect';
import { callHost, HostCallError } from './native-bridge.js';

/** Default deadline of one RPC when the caller sets none (NSH's default). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Connect code names (`invalid_argument`) to `Code` values. */
const CODE_BY_NAME = new Map<string, Code>(
  Object.entries(Code)
    .filter((entry): entry is [string, Code] => typeof entry[1] === 'number')
    .map(([name, code]) => [
      name.replace(
        /[A-Z]/g,
        (c, i: number) => (i ? '_' : '') + c.toLowerCase(),
      ),
      code,
    ]),
);

function connectError(error: unknown): ConnectError {
  if (error instanceof HostCallError) {
    return new ConnectError(
      error.message,
      CODE_BY_NAME.get(error.code) ?? Code.Unknown,
    );
  }
  // NSH's own refusals (not granted, ETIMEDOUT) carry only a message.
  const message = error instanceof Error ? error.message : String(error);
  return new ConnectError(
    message,
    /ETIMEDOUT/.test(message) ? Code.DeadlineExceeded : Code.Unavailable,
  );
}

/** The Connect transport for this App's backend, through the shell. */
export function createAppTransport(): Transport {
  return {
    async unary<I extends DescMessage, O extends DescMessage>(
      method: DescMethodUnary<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      _header: HeadersInit | undefined,
      input: MessageInitShape<I>,
    ): Promise<UnaryResponse<I, O>> {
      signal?.throwIfAborted();
      let answer: { message: JsonValue; header?: Record<string, string> };
      try {
        answer = await callHost(
          'hatch.rpc',
          {
            service: method.parent.typeName,
            method: method.name,
            message: toJson(method.input, create(method.input, input)),
          },
          timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      } catch (error) {
        throw connectError(error);
      }
      return {
        stream: false,
        service: method.parent,
        method,
        header: new Headers(answer.header ?? {}),
        message: fromJson(method.output, answer.message, {
          ignoreUnknownFields: true,
        }),
        trailer: new Headers(),
      };
    },
    stream() {
      return Promise.reject(
        new ConnectError(
          'Streaming RPC is not available on the native runtime.',
          Code.Unimplemented,
        ),
      );
    },
  };
}
