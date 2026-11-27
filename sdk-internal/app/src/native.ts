// @ts-self-types="./native.d.ts"
/**
 * @hatch/app/native — the shell bridge of an App whose frontend runs on the
 * native (NSH) runtime. The App holds no credentials and no network access:
 * every request goes through `host.call('hatch.*')`, which the shell (the web
 * player page or a native shell) performs with its own session, scoped to this
 * App. Connect RPC lives in `@hatch/app/native/rpc`.
 */
import { host, setTheme } from 'nsh';
import {
  createDataClient,
  DataRequestError,
  type DataClient,
  type DataSchema,
  type DataTransport,
} from './data.js';
import { callHost, HostCallError } from './native-bridge.js';

export { HostCallError } from './native-bridge.js';

/** How long one `hatch.data.events` call may wait for a change. */
const DATA_EVENTS_TIMEOUT_MS = 60_000;
/** An empty events answer faster than this ends the poll loop. */
const EMPTY_POLL_DISCONNECT_MS = 1_000;

/** Theme the shell resolved for this App: NSH's shadcn `cssVars` shape. */
export type ShellTheme = {
  cssVars: {
    theme?: Record<string, string | number>;
    light?: Record<string, string | number>;
    dark?: Record<string, string | number>;
  };
};

function themeOf(payload: unknown): ShellTheme | null {
  const theme = (payload as { theme?: unknown } | null)?.theme;
  return theme && typeof theme === 'object' && 'cssVars' in theme
    ? (theme as ShellTheme)
    : null;
}

/**
 * Apply the shell's theme now and whenever it changes (`hatch.theme`), so
 * the instance accent reaches the App without a redeploy. Call it once,
 * before the first render. Returns a function that stops following.
 */
export function followShellTheme(): () => void {
  let stopped = false;
  const apply = (theme: ShellTheme | null) => {
    if (!stopped && theme) setTheme(theme);
  };
  const stop = host.on('hatch.theme', (payload) => apply(themeOf(payload)));
  void callHost<{ theme: ShellTheme }>('hatch.theme.get', {}).then(
    (answer) => apply(themeOf(answer)),
    // The build-time theme from nsh.json stays in place.
    () => undefined,
  );
  return () => {
    stopped = true;
    stop();
  };
}

/**
 * The route the shell opened the App at: a raw, still percent-encoded
 * fragment without `#` (`''` is the App's home).
 */
export function initialRoute(): string {
  const route = host.params.route;
  return typeof route === 'string' ? route : '';
}

/**
 * The build number of the signed package this App runs, as the phone app
 * names it: it grows with every deploy and rollback (a rolled-back version is
 * a newer build of older code). Null where the shell does not say (the web
 * player). Use it, not NSH's `appInfo().build`, which is the build the bundle
 * was compiled with and stays 1.
 */
export function packageBuild(): number | null {
  const build = host.params.packageBuild;
  return typeof build === 'number' && Number.isSafeInteger(build) && build > 0
    ? build
    : null;
}

/** Tell the shell the App's current route, so deep links and reloads work. */
export function setRoute(route: string): void {
  void callHost('hatch.nav.setRoute', { route }).catch(() => undefined);
}

/** Tell the shell the App's title; `null` clears it. */
export function setTitle(title: string | null): void {
  void callHost('hatch.nav.setTitle', { title }).catch(() => undefined);
}

/** The shell asks the App to show `route` (for example the host's back button). */
export function onNavigate(listener: (route: string) => void): () => void {
  return host.on('hatch.nav', (payload) => {
    const route = (payload as { route?: unknown } | null)?.route;
    if (typeof route === 'string') listener(route);
  });
}

/** The shell hid or showed the App; a hidden App keeps running. */
export function onVisibilityChange(
  listener: (visible: boolean) => void,
): () => void {
  return host.on('hatch.visibility', (payload) => {
    const visible = (payload as { visible?: unknown } | null)?.visible;
    if (typeof visible === 'boolean') listener(visible);
  });
}

/** A newer deployment of this App is live; reloading the App loads it. */
export function onUpdateAvailable(listener: () => void): () => void {
  return host.on('hatch.update', () => listener());
}

/** Ask the shell to open another App by its slug, optionally at a route. */
export async function openApp(slug: string, route = ''): Promise<void> {
  await callHost('hatch.nav.open', { slug, route });
}

/** Native capabilities this shell provides (none on the web player). */
export async function nativeSupports(): Promise<string[]> {
  const answer = await callHost<{ capabilities: string[] }>(
    'hatch.native.supports',
    {},
  );
  return answer.capabilities;
}

/** Map a refused bridge call to the HTTP-style status the data client uses. */
function dataError(error: unknown): unknown {
  if (!(error instanceof HostCallError)) return error;
  const status =
    {
      invalid_argument: 400,
      failed_precondition: 400,
      out_of_range: 400,
      unauthenticated: 401,
      permission_denied: 403,
      not_found: 404,
      already_exists: 409,
      aborted: 409,
      resource_exhausted: 429,
      unavailable: 503,
      deadline_exceeded: 504,
    }[error.code] ?? 500;
  return new DataRequestError(error.message, status);
}

const hostDataTransport: DataTransport = {
  async post<T>(action: 'query' | 'mutate', body: unknown): Promise<T> {
    try {
      const answer = await callHost<{ result: T }>(`hatch.data.${action}`, {
        body,
      });
      return answer.result;
    } catch (error) {
      throw dataError(error);
    }
  },
  async changes(table, since, signal, onChange) {
    let cursor = since;
    while (!signal.aborted) {
      let answer: {
        events: { revision?: number; reset?: boolean }[];
      };
      const asked = Date.now();
      try {
        answer = await callHost(
          'hatch.data.events',
          { table, since: cursor },
          DATA_EVENTS_TIMEOUT_MS + 5_000,
        );
      } catch (error) {
        throw dataError(error);
      }
      // The bridge cannot cancel a call; drop what arrives after a stop.
      if (signal.aborted) return;
      for (const event of answer.events) {
        const reset = event.reset === true;
        const revision =
          typeof event.revision === 'number' &&
          Number.isSafeInteger(event.revision) &&
          event.revision >= 0
            ? event.revision
            : undefined;
        if (revision !== undefined) {
          cursor = reset ? revision : Math.max(cursor, revision);
        }
        onChange({ revision, reset });
      }
      // A long poll that comes back empty at once is a dropped stream (an
      // empty proxy response, say). End this connection so the watch loop
      // backs off before asking again, as it does for an HTTP stream.
      if (
        answer.events.length === 0 &&
        Date.now() - asked < EMPTY_POLL_DISCONNECT_MS
      ) {
        return;
      }
    }
  },
};

/**
 * The App's Data Tables, through the shell. Same API as `createDataClient`;
 * the shell scopes every request to this App and its live deployment.
 */
export function createAppDataClient<
  TSchema extends DataSchema,
>(): DataClient<TSchema> {
  return createDataClient<TSchema>({
    transport: hostDataTransport,
    cacheNamespace: JSON.stringify(['native']),
  });
}
