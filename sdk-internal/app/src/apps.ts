// @ts-self-types="./apps.d.ts"
/**
 * @hatch/app/apps — reach other Apps from this App's backend.
 *
 * The manifest's `appAccess` lists what may be reached; every call goes
 * through the platform, which checks the grant and tells the target which
 * App is calling. Frontends cannot use it: they call their own backend,
 * which relays.
 *
 * The target side uses `appCaller` (RPC) or `verifyPlatformRequest`
 * (webhooks) to learn the calling App.
 */
import {
  createDataClient,
  type DataClient,
  DataRequestError,
  type DataSchema,
  type DataTransport,
} from './data.js';
import { hmacHeaders, runtimeEnv, verifyHmac } from './signing.js';

const MAX_SKEW_MS = 5 * 60 * 1000;
const CALLER_APP_HEADER = 'x-hatch-caller-app';
const CALLER_SIGNATURE_HEADER = 'x-hatch-caller-signature';

/** A failure the platform or the target App reported. */
export class AppAccessError extends Error {
  constructor(
    message: string,
    /** Connect-style code, such as `permission_denied` or `not_found`. */
    readonly code: string,
    /** HTTP status of the response. */
    readonly status: number,
    /** The parsed error body, when it was JSON. */
    readonly response?: unknown,
  ) {
    super(message);
    this.name = 'AppAccessError';
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'invalid_argument',
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  409: 'already_exists',
  413: 'resource_exhausted',
  429: 'resource_exhausted',
  501: 'unimplemented',
  503: 'unavailable',
};

async function accessError(response: Response): Promise<AppAccessError> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const json = body as { code?: unknown; message?: unknown } | undefined;
  const code =
    typeof json?.code === 'string'
      ? json.code
      : (STATUS_CODES[response.status] ?? 'unknown');
  const message =
    typeof json?.message === 'string'
      ? json.message
      : text || `App access failed (${response.status})`;
  return new AppAccessError(message, code, response.status, body);
}

/** The relay base (`…/api/app/<this App>/access`) and this App's id. */
function relay(): { base: string; appId: string; secret: string } {
  const base = runtimeEnv('HATCH_APP_ACCESS_URL');
  const secret = runtimeEnv('HATCH_SIGNING_SECRET');
  const appId = base
    ? /\/api\/app\/([^/]+)\/access\/?$/.exec(new URL(base).pathname)?.[1]
    : undefined;
  if (!base || !secret || !appId) {
    throw new Error(
      'Other Apps are unreachable: declare appAccess in the manifest and deploy the backend.',
    );
  }
  return { base: base.replace(/\/+$/, ''), appId, secret };
}

export type AppTaskRun = {
  id: string;
  taskName: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  [key: string]: unknown;
};

export type CallOptions = {
  signal?: AbortSignal;
  /** Abort the call after this many milliseconds. */
  timeoutMs?: number;
};

export type AppConnection = {
  /** The id or alias this connection was opened with. */
  readonly target: string;
  /**
   * Base URL for a Connect transport, for typed clients generated from the
   * target's proto: `createConnectTransport({ baseUrl, fetch })`.
   */
  readonly rpcBaseUrl: string;
  /** `fetch` that signs requests to the relay; pass it to a transport. */
  readonly fetch: (
    input: Request | URL | string,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Call a granted unary method with JSON and return its JSON response. */
  call<T = unknown>(
    method: string,
    input?: unknown,
    options?: CallOptions,
  ): Promise<T>;
  /** A Data client for the target's granted tables (no realtime changes). */
  data<TSchema extends DataSchema = DataSchema>(): DataClient<TSchema>;
  readonly tasks: {
    /** Queue a granted task; `status` is `failed` when the input was rejected. */
    start(
      task: string,
      input?: Record<string, unknown>,
    ): Promise<{ runId: string; status: 'queued' | 'failed' }>;
    /** A run this App started. */
    get(runId: string): Promise<AppTaskRun>;
  };
  /** Send a request to a granted path of the target's webhook. */
  webhook(path: string, init?: RequestInit): Promise<Response>;
};

function withTimeout(
  options: CallOptions | undefined,
): AbortSignal | undefined {
  const signals = [
    options?.signal,
    options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/**
 * Open a connection to another App by the id or alias listed in `appAccess`.
 * Nothing is sent until a method is used.
 */
export function connectApp(target: string): AppConnection {
  if (!target || target.includes('/')) {
    throw new Error('connectApp: name an App id or alias from appAccess.');
  }
  const targetBase = () => `${relay().base}/${encodeURIComponent(target)}`;

  const signedFetch = async (
    input: Request | URL | string,
    init?: RequestInit,
  ): Promise<Response> => {
    const { base, appId, secret } = relay();
    const request = new Request(input, init);
    const url = new URL(request.url);
    const basePath = new URL(base).pathname;
    if (
      url.origin !== new URL(base).origin ||
      !url.pathname.startsWith(`${basePath}/`)
    ) {
      throw new Error(`App access fetch only reaches ${base}.`);
    }
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(
      await hmacHeaders(
        secret,
        `${appId}.${request.method.toUpperCase()} ${url.pathname.slice(
          basePath.length,
        )}${url.search}`,
      ),
    )) {
      headers.set(name, value);
    }
    return fetch(new Request(request, { headers }));
  };

  const json = async <T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<T> => {
    const response = await signedFetch(`${targetBase()}${path}`, {
      method,
      headers:
        method === 'POST'
          ? { 'content-type': 'application/json', ...headers }
          : headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal,
    });
    if (!response.ok) throw await accessError(response);
    return (await response.json()) as T;
  };

  const transport: DataTransport = {
    async post<T>(
      action: 'query' | 'mutate',
      body: unknown,
      signal?: AbortSignal,
    ) {
      const response = await signedFetch(`${targetBase()}/data/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        throw new DataRequestError(
          (await response.text()) || `Data request failed (${response.status})`,
          response.status,
        );
      }
      return (await response.json()) as T;
    },
    changes() {
      return Promise.reject(
        new DataRequestError(
          'Realtime changes are not available for another App.',
          404,
        ),
      );
    },
  };

  return {
    target,
    get rpcBaseUrl() {
      return `${targetBase()}/rpc`;
    },
    fetch: signedFetch,
    call: (method, input, options) =>
      json(`/rpc/${method}`, 'POST', input ?? {}, withTimeout(options), {
        'connect-protocol-version': '1',
      }),
    data: <TSchema extends DataSchema = DataSchema>() =>
      createDataClient<TSchema>({
        transport,
        cacheNamespace: JSON.stringify(['app-access', target]),
      }),
    tasks: {
      start: (task, input = {}) =>
        json(`/tasks/${encodeURIComponent(task)}/runs`, 'POST', input),
      get: (runId) =>
        json(`/tasks/runs/${encodeURIComponent(runId)}`, 'GET', undefined),
    },
    webhook(path, init) {
      if (!path.startsWith('/')) {
        throw new Error('webhook: the path starts with "/".');
      }
      return signedFetch(`${targetBase()}/hook${path}`, init);
    },
  };
}

/** The App that sent a relayed request. */
export type AppCaller = { appId: string };

type RequestLike = {
  method: string;
  url: string;
  headers: Headers;
};

/**
 * The calling App when the platform relayed this request from another App's
 * backend, verified with this App's signing secret; otherwise null. Pass a
 * `Request`, or `{ method, url, headers }` from a Connect handler context
 * (`context.requestMethod`, `context.url`, `context.requestHeader`).
 */
export async function appCaller(
  request: RequestLike,
): Promise<AppCaller | null> {
  const secret = runtimeEnv('HATCH_SIGNING_SECRET');
  const appId = request.headers.get(CALLER_APP_HEADER);
  if (!secret || !appId) return null;
  const url = new URL(request.url);
  const valid = await verifyHmac({
    secret,
    timestamp: request.headers.get('x-hatch-timestamp'),
    signature: request.headers.get(CALLER_SIGNATURE_HEADER),
    body: `${appId}.${request.method.toUpperCase()} ${url.pathname}${url.search}`,
    maxSkewMs: MAX_SKEW_MS,
  });
  return valid ? { appId } : null;
}

/**
 * Check that the platform sent a webhook request: either a platform-signed
 * forward (`{ via: 'platform' }`, which signs the raw body) or a relay from
 * another App (`{ via: 'app', appId }`). Returns null otherwise. Pass the raw
 * body bytes when the request body was already read.
 */
export async function verifyPlatformRequest(
  request: Request,
  rawBody?: Uint8Array | string,
): Promise<{ via: 'platform' } | { via: 'app'; appId: string } | null> {
  if (request.headers.has(CALLER_APP_HEADER)) {
    const caller = await appCaller(request);
    return caller ? { via: 'app', appId: caller.appId } : null;
  }
  const secret = runtimeEnv('HATCH_SIGNING_SECRET');
  if (!secret) return null;
  const body = rawBody ?? new Uint8Array(await request.clone().arrayBuffer());
  const valid = await verifyHmac({
    secret,
    timestamp: request.headers.get('x-hatch-timestamp'),
    signature: request.headers.get('x-hatch-signature'),
    body,
    maxSkewMs: MAX_SKEW_MS,
  });
  return valid ? { via: 'platform' } : null;
}
