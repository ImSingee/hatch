/**
 * Holds back a `web` App's Data Table change events while its surface is
 * hidden, without any code in the App.
 *
 * A `web` App's bundle subscribes to changes with a long-lived
 * `GET /api/app/<id>/data/events?since=<revision>` stream from its own
 * same-origin frame, and reconnects with the last revision it saw whenever
 * the stream ends cleanly. The gate wraps the frame's `fetch` for exactly
 * that request:
 *
 * - hidden: every open stream ends cleanly (an EOF, never an error, so the
 *   App does not report a failure), and every new stream request waits,
 *   unanswered, until the App is shown again or the caller aborts it;
 * - shown: the waiting requests go out, still carrying the revision the App
 *   last saw, so the server sends the changes it missed.
 *
 * So a hidden App neither receives events nor holds a connection, and its
 * reconnect loop parks on one pending call instead of spinning. Every other
 * request passes through untouched.
 *
 * Install the gate on the frame's initial `about:blank` window, right after
 * the frame is inserted: navigating that window to a same-origin page reuses
 * it (HTML's "reuse the Window" rule, which Chromium and Firefox implement),
 * so the wrapper is in place before the App's first script runs. Installing
 * again on `load` covers a browser that creates a new window, or an App that
 * reloads itself; a stream opened before that point is not seen.
 *
 * This relies on the App frame being same-origin, like the rest of what
 * `AppSurface` reads from a `web` App. A native App's player handles
 * visibility itself, so its gate is released.
 */

const DATA_EVENTS_PATH = /^\/api\/app\/[^/]+\/data\/events$/;
const GATE = Symbol('hatch.desk.dataEventsGate');

export type DataEventsGate = {
  /** Hide or show the App: hiding ends open streams, showing resumes. */
  setVisible: (visible: boolean) => void;
  /** Stop gating for good: waiting requests go out, nothing is held again. */
  release: () => void;
};

type GatedWindow = Window & { [GATE]?: DataEventsGate };

function requestOf(input: unknown): Request | null {
  return typeof input === 'object' &&
    input !== null &&
    'url' in input &&
    'method' in input &&
    typeof (input as Request).url === 'string'
    ? (input as Request)
    : null;
}

function isDataEvents(win: Window, input: unknown, init?: RequestInit) {
  const request = requestOf(input);
  const method = init?.method ?? request?.method ?? 'GET';
  if (method.toUpperCase() !== 'GET') return false;
  const href = request
    ? request.url
    : typeof input === 'string'
      ? input
      : String((input as { href?: unknown } | null)?.href ?? input);
  try {
    const url = new URL(href, win.location.href);
    return (
      url.origin === win.location.origin && DATA_EVENTS_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * The gate on `win`, installed if it is not there yet. Idempotent: a window
 * keeps its one gate (and its state), even when the App wrapped `fetch` again
 * on top of it.
 */
export function gateDataEvents(win: Window, visible: boolean): DataEventsGate {
  const gated = win as GatedWindow;
  const existing = gated[GATE];
  if (existing) return existing;

  // Streams, responses and abort signals the App reads are made in its own
  // realm, as its own `fetch` would make them.
  const realm = win as Window & typeof globalThis;
  const nativeFetch = win.fetch;
  let shown = visible;
  let released = false;
  /** Ends one open stream cleanly. */
  const open = new Set<() => void>();
  /** Starts one waiting request. */
  const waiting = new Set<() => void>();

  const passing = () => shown || released;

  // A body that ends at once: the App reads a clean EOF and reconnects.
  const ended = (response: Response) =>
    new realm.Response(
      new realm.ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );

  async function stream(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    signal: AbortSignal | null,
  ): Promise<Response> {
    const upstream = new realm.AbortController();
    const forward = () => upstream.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener('abort', forward, { once: true });
    const response = await nativeFetch.call(win, input, {
      ...init,
      signal: upstream.signal,
    });
    if (!response.ok || !response.body) return response;
    if (!passing()) {
      // Hidden while the request was on its way.
      upstream.abort();
      signal?.removeEventListener('abort', forward);
      return ended(response);
    }

    const reader = response.body.getReader();
    let finished = false;
    let end = () => {};
    const finish = () => {
      finished = true;
      open.delete(end);
      signal?.removeEventListener('abort', forward);
    };
    const body = new realm.ReadableStream<Uint8Array>(
      {
        start(controller) {
          end = () => {
            if (finished) return;
            finish();
            controller.close();
            upstream.abort();
          };
          open.add(end);
        },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (finished) return;
            if (chunk.done) {
              finish();
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            if (finished) return;
            finish();
            controller.error(error);
          }
        },
        cancel(reason) {
          finish();
          upstream.abort();
          reader.cancel(reason).catch(() => undefined);
        },
        // Read upstream only when the App asks: nothing waits in a queue, so
        // ending the stream on hide leaves no event for a hidden App to read.
      },
      { highWaterMark: 0 },
    );
    return new realm.Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const wrapped = function gatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (released || !isDataEvents(win, input, init)) {
      return nativeFetch.call(win, input, init);
    }
    const signal = init?.signal ?? requestOf(input)?.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        waiting.delete(start);
        reject(signal?.reason);
      };
      function start() {
        waiting.delete(start);
        signal?.removeEventListener('abort', onAbort);
        stream(input, init, signal).then(resolve, reject);
      }
      if (passing()) {
        start();
        return;
      }
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      waiting.add(start);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } as typeof fetch;

  const resume = () => {
    for (const start of waiting) start();
  };

  const gate: DataEventsGate = {
    setVisible(next) {
      if (released || next === shown) return;
      shown = next;
      if (shown) resume();
      else for (const end of open) end();
    },
    release() {
      if (released) return;
      released = true;
      resume();
    },
  };
  win.fetch = wrapped;
  gated[GATE] = gate;
  return gate;
}
