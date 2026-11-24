// @ts-self-types="./native-player.d.ts"
/**
 * @hatch/app/native/player — not for App source. The platform build bundles
 * it as the script of a `native` App's web player page: it starts the NSH
 * web runtime, runs the App's packaged module with the App's grant, answers
 * the App's `hatch.*` host calls with same-origin requests scoped to this
 * App, and talks to the framing `AppSurface` over the surface channel.
 *
 * NSH does not isolate an App from the page that hosts it on the web, so the
 * page's CSP (set by the platform) and this App-scoped host are the boundary.
 */
import {
  NATIVE_SURFACE_PROTOCOL,
  parseSurfaceMessage,
  type PlayerMessage,
  type SurfaceMessage,
} from './native-surface.js';

/** What the platform build writes into `#hatch-player` (JSON). */
export type NativePlayerConfig = {
  appId: string;
  deploymentId: string;
  name: string;
  /** NSH app id the module is packaged under (`dev.hatch.app.<id>`). */
  nshAppId: string;
  /** The packaged NSH web runtime, shared by Apps of the same NSH version. */
  runtime: {
    /** Absolute path of the shared runtime directory, ending in '/'. */
    base: string;
    module: string;
    wasm: string;
    data: Record<string, string>;
    sides: Record<string, { url: string } & Record<string, unknown>>;
  };
  /** The App's packaged code, relative to the page. */
  app: {
    code: string;
    chunks: Record<string, string>;
    assets: Record<string, string>;
    fonts: string[];
    nativeExports: Record<string, string[]>;
  };
  /** The App's grant, as the JSON text of an NSH capabilities document. */
  grant: string;
  /** Unary methods the page may call, by fully-qualified service name. */
  rpc: { url: string; methods: Record<string, string[]> } | null;
  data: { url: string } | null;
  /** NSH theme per accent name. */
  themes: Record<string, unknown>;
  defaultAccent: string;
};

type Answer =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; code: string; message: string };

type Player = {
  runModule(url: string, options: Record<string, unknown>): Promise<void>;
  hostEvent(event: string, payload: unknown): void;
};

type CreatePlayer = (
  element: HTMLElement,
  options: Record<string, unknown>,
) => Promise<Player>;

const DATA_DEPLOYMENT_HEADER = 'x-hatch-data-deployment';
/** How long one `hatch.data.events` call waits before answering "none". */
const DATA_EVENTS_WAIT_MS = 25_000;
/** How long an embedded page waits for its surface before starting alone. */
const SURFACE_WAIT_MS = 3_000;
const MAX_ROUTE_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 256;
const SERVICE_NAME = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/;
const METHOD_NAME = /^[A-Za-z_]\w*$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCENT_STORAGE_KEY = 'hatch.accent';
/** The faces the player page declares (fonts.css) and the theme names. */
const PLAYER_FONT_FAMILIES = ['Nunito', 'JetBrains Mono'];
const FONT_WAIT_MS = 3_000;

function refuse(code: string, message: string): Answer {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Connect code for an HTTP status the Data API answered with. */
function codeForStatus(status: number): string {
  if (status === 400) return 'invalid_argument';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 409) return 'already_exists';
  if (status === 429) return 'resource_exhausted';
  if (status === 503) return 'unavailable';
  if (status === 504) return 'deadline_exceeded';
  return status >= 500 ? 'internal' : 'unknown';
}

/**
 * The App-scoped host. Every handler validates its arguments, reaches only
 * this App's own endpoints, and answers with an envelope (a rejected host
 * call would lose its code on the way to the App).
 */
export function createNativeHost(
  config: NativePlayerConfig,
  shell: {
    accent(): string;
    /** Resolves true once the App is visible, or false after `ms`. */
    visibleWithin(ms: number): Promise<boolean>;
    post(message: PlayerMessage): boolean;
    setTitle(title: string | null): void;
    setRoute(route: string): void;
  },
  fetchImpl: typeof fetch = fetch,
): { call(name: string, args: unknown): Promise<Answer> } {
  const deploymentHeader: Record<string, string> = config.deploymentId
    ? { [DATA_DEPLOYMENT_HEADER]: config.deploymentId }
    : {};
  const dataHeaders = {
    'content-type': 'application/json',
    ...deploymentHeader,
  };

  async function rpc(args: Record<string, unknown>): Promise<Answer> {
    if (!config.rpc) return refuse('unimplemented', 'This App has no backend.');
    const { service, method, message } = args;
    if (
      typeof service !== 'string' ||
      !SERVICE_NAME.test(service) ||
      typeof method !== 'string' ||
      !METHOD_NAME.test(method) ||
      // Any JSON value: a message's JSON form need not be an object
      // (`google.protobuf.Value`, `Timestamp`, wrappers). The codecs and the
      // backend check its shape.
      message === undefined
    ) {
      return refuse(
        'invalid_argument',
        'hatch.rpc needs { service, method, message }.',
      );
    }
    if (!config.rpc.methods[service]?.includes(method)) {
      return refuse(
        'unimplemented',
        `${service}/${method} is not a unary method of this App.`,
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${config.rpc.url}/${service}/${method}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: JSON.stringify(message),
      });
    } catch (error) {
      return refuse('unavailable', String(error));
    }
    const text = await response.text();
    let body: unknown;
    let parsed = true;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // A proxy error page; reported below.
      parsed = false;
    }
    if (!response.ok) {
      const failure = isRecord(body) ? body : {};
      return refuse(
        typeof failure.code === 'string'
          ? failure.code
          : codeForStatus(response.status),
        typeof failure.message === 'string'
          ? failure.message
          : `HTTP ${response.status}`,
      );
    }
    if (!parsed) {
      return refuse('internal', 'The backend answered with no JSON message.');
    }
    const header: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      header[key] = value;
    });
    return { ok: true, message: body, header };
  }

  async function data(
    action: 'query' | 'mutate',
    args: Record<string, unknown>,
  ): Promise<Answer> {
    if (!config.data) {
      return refuse('unimplemented', 'This App has no Data Tables.');
    }
    if (!isRecord(args.body)) {
      return refuse('invalid_argument', `hatch.data.${action} needs { body }.`);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${config.data.url}/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: dataHeaders,
        body: JSON.stringify(args.body),
      });
    } catch (error) {
      return refuse('unavailable', String(error));
    }
    const text = await response.text();
    if (!response.ok) {
      return refuse(
        codeForStatus(response.status),
        text || `HTTP ${response.status}`,
      );
    }
    try {
      return { ok: true, result: JSON.parse(text) as unknown };
    } catch {
      return refuse('internal', 'The Data API answered with no JSON.');
    }
  }

  async function events(args: Record<string, unknown>): Promise<Answer> {
    if (!config.data) {
      return refuse('unimplemented', 'This App has no Data Tables.');
    }
    const { table, since } = args;
    if (
      typeof table !== 'string' ||
      !table ||
      typeof since !== 'number' ||
      !Number.isSafeInteger(since) ||
      since < 0
    ) {
      return refuse(
        'invalid_argument',
        'hatch.data.events needs { table, since }.',
      );
    }
    // A hidden App gets no change events: the call answers "none" after the
    // usual wait (well inside the App's call timeout) without touching the
    // network, and the App catches up once shown, because the cursor it
    // sends then still names what it last saw.
    if (!(await shell.visibleWithin(DATA_EVENTS_WAIT_MS))) {
      return { ok: true, events: [] };
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DATA_EVENTS_WAIT_MS);
    const found: { revision?: number; reset: boolean }[] = [];
    try {
      const response = await fetchImpl(
        `${config.data.url}/events?since=${since}&table=${encodeURIComponent(table)}`,
        {
          credentials: 'same-origin',
          headers: deploymentHeader,
          signal: abort.signal,
        },
      );
      if (!response.ok) {
        return refuse(
          codeForStatus(response.status),
          (await response.text()) || `HTTP ${response.status}`,
        );
      }
      const reader = response.body
        ?.pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = '';
      while (reader && found.length === 0) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const lines = block.split('\n');
          const type = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim();
          if (!type) continue;
          const id = Number(
            lines
              .find((line) => line.startsWith('id:'))
              ?.slice(3)
              .trim(),
          );
          found.push({
            revision: Number.isSafeInteger(id) && id >= 0 ? id : undefined,
            reset: type === 'reset',
          });
        }
      }
      void reader?.cancel().catch(() => undefined);
    } catch (error) {
      if (!abort.signal.aborted) return refuse('unavailable', String(error));
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    return { ok: true, events: found };
  }

  return {
    async call(name, args): Promise<Answer> {
      const input = args === undefined || args === null ? {} : args;
      if (!isRecord(input)) {
        return refuse('invalid_argument', `${name} takes an object.`);
      }
      try {
        switch (name) {
          case 'hatch.rpc':
            return await rpc(input);
          case 'hatch.data.query':
            return await data('query', input);
          case 'hatch.data.mutate':
            return await data('mutate', input);
          case 'hatch.data.events':
            return await events(input);
          case 'hatch.theme.get': {
            const accent = shell.accent();
            return {
              ok: true,
              theme:
                config.themes[accent] ?? config.themes[config.defaultAccent],
            };
          }
          case 'hatch.nav.setTitle': {
            const { title } = input;
            if (
              !(title === null || typeof title === 'string') ||
              (typeof title === 'string' && title.length > MAX_TITLE_LENGTH)
            ) {
              return refuse(
                'invalid_argument',
                `hatch.nav.setTitle needs { title } (a string of at most ${MAX_TITLE_LENGTH} characters, or null).`,
              );
            }
            shell.setTitle(title || null);
            return { ok: true };
          }
          case 'hatch.nav.setRoute': {
            const { route } = input;
            if (
              typeof route !== 'string' ||
              route.length > MAX_ROUTE_LENGTH ||
              route.startsWith('#')
            ) {
              return refuse(
                'invalid_argument',
                'hatch.nav.setRoute needs { route }: a fragment without "#".',
              );
            }
            shell.setRoute(route);
            return { ok: true };
          }
          case 'hatch.nav.open': {
            const { slug, route = '' } = input;
            if (
              typeof slug !== 'string' ||
              !SLUG.test(slug) ||
              typeof route !== 'string' ||
              route.length > MAX_ROUTE_LENGTH
            ) {
              return refuse(
                'invalid_argument',
                'hatch.nav.open needs { slug, route? }.',
              );
            }
            return shell.post({ type: 'open', slug, route })
              ? { ok: true }
              : refuse('unavailable', 'No shell is framing this App.');
          }
          case 'hatch.native.supports':
            // The web player provides no native capabilities.
            return { ok: true, capabilities: [] };
          default:
            return refuse('unimplemented', `${name} is not a host function.`);
        }
      } catch (error) {
        return refuse('internal', String(error));
      }
    },
  };
}

function readConfig(): NativePlayerConfig {
  const element = document.getElementById('hatch-player');
  if (!element?.textContent) throw new Error('The player has no App.');
  return JSON.parse(element.textContent) as NativePlayerConfig;
}

function storedAccent(): string | null {
  try {
    return localStorage.getItem(ACCENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rawHash(): string {
  return location.hash.replace(/^#/, '');
}

function fail(message: string): void {
  const status = document.getElementById('status');
  if (!status) return;
  status.hidden = false;
  status.textContent = `This App could not start: ${message}`;
}

/** Wait for the surface's port, or give up (the page was opened directly). */
function connectSurface(onMessage: (message: SurfaceMessage) => void): {
  ready: Promise<{ port: MessagePort | null; init: SurfaceMessage | null }>;
} {
  const embedded = window.parent !== window;
  const ready = new Promise<{
    port: MessagePort | null;
    init: SurfaceMessage | null;
  }>((resolve) => {
    if (!embedded) {
      resolve({ port: null, init: null });
      return;
    }
    const timer = setTimeout(() => {
      removeEventListener('message', onConnect);
      resolve({ port: null, init: null });
    }, SURFACE_WAIT_MS);
    function onConnect(event: MessageEvent) {
      if (
        event.source !== window.parent ||
        event.origin !== location.origin ||
        !isRecord(event.data) ||
        event.data.protocol !== NATIVE_SURFACE_PROTOCOL ||
        event.data.type !== 'connect' ||
        !event.ports[0]
      ) {
        return;
      }
      event.stopImmediatePropagation();
      removeEventListener('message', onConnect);
      const port = event.ports[0];
      let started = false;
      port.onmessage = (message) => {
        const parsed = parseSurfaceMessage(message.data);
        if (!parsed) return;
        if (!started && parsed.type === 'init') {
          started = true;
          clearTimeout(timer);
          resolve({ port, init: parsed });
          return;
        }
        onMessage(parsed);
      };
      port.start();
    }
    addEventListener('message', onConnect);
  });
  return { ready };
}

/** Start the player page. */
export async function startNativePlayer(): Promise<void> {
  const config = readConfig();
  let accent = storedAccent() ?? config.defaultAccent;
  let visible = true;
  const showWaiters: (() => void)[] = [];
  let player: Player | null = null;
  let port: MessagePort | null = null;
  const pending: SurfaceMessage[] = [];

  const post = (message: PlayerMessage) => {
    if (!port) return false;
    port.postMessage(message);
    return true;
  };
  const theme = () =>
    config.themes[accent] ?? config.themes[config.defaultAccent];

  const apply = (message: SurfaceMessage) => {
    if (!player) {
      pending.push(message);
      return;
    }
    switch (message.type) {
      case 'navigate':
        history.replaceState(history.state, '', `#${message.route}`);
        player.hostEvent('hatch.nav', { route: message.route });
        break;
      case 'theme':
        if (message.accent !== accent) {
          accent = message.accent;
          player.hostEvent('hatch.theme', { theme: theme() });
        }
        break;
      case 'visibility':
        visible = message.visible;
        if (visible) {
          for (const resolve of showWaiters.splice(0)) resolve();
        }
        player.hostEvent('hatch.visibility', { visible });
        break;
      case 'update-available':
        player.hostEvent('hatch.update', {});
        break;
      case 'init':
        break;
    }
  };

  const surface = connectSurface(apply);
  const connected = await surface.ready;
  port = connected.port;
  let route = rawHash();
  if (connected.init?.type === 'init') {
    route = connected.init.route;
    accent = connected.init.accent;
    visible = connected.init.visible;
    if (rawHash() !== route) {
      history.replaceState(history.state, '', `#${route}`);
    }
  }
  post({
    type: 'hello',
    appId: config.appId,
    deploymentId: config.deploymentId,
  });

  const host = createNativeHost(config, {
    accent: () => accent,
    visibleWithin: (ms) =>
      visible
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            const waiter = () => {
              clearTimeout(timer);
              resolve(true);
            };
            const timer = setTimeout(() => {
              const index = showWaiters.indexOf(waiter);
              if (index >= 0) showWaiters.splice(index, 1);
              resolve(false);
            }, ms);
            showWaiters.push(waiter);
          }),
    post,
    setTitle(title) {
      document.title = title ?? config.name;
      post({ type: 'title', title });
    },
    setRoute(next) {
      if (rawHash() !== next) {
        history.replaceState(history.state, '', `#${next}`);
      }
      post({ type: 'route', route: next });
    },
  });

  const runtimeUrl = (file: string) =>
    new URL(file, new URL(config.runtime.base, location.href)).href;
  const appUrl = (file: string) => new URL(file, location.href).href;
  const fonts = new Map<string, Uint8Array>();
  await Promise.all(
    config.app.fonts.map(async (font) => {
      const url = config.app.assets[font];
      if (!url) return;
      const response = await fetch(appUrl(url));
      if (response.ok) {
        fonts.set(font, new Uint8Array(await response.arrayBuffer()));
      }
    }),
  );
  const mapValues = (
    record: Record<string, string>,
    resolve: (file: string) => string,
  ) =>
    Object.fromEntries(
      Object.entries(record).map(([key, file]) => [key, resolve(file)]),
    );

  try {
    // The shared runtime's URL is known only from the page's config.
    // oxlint-disable-next-line local/no-dynamic-import
    const { createPlayer } = (await import(
      /* @vite-ignore */ runtimeUrl(config.runtime.module)
    )) as { createPlayer: CreatePlayer };
    // Surface messages stay queued (in order) until the player is ready:
    // `player` is set only after the font wait, just before the drain.
    const created = await createPlayer(document.getElementById('app')!, {
      wasm: runtimeUrl(config.runtime.wasm),
      data: mapValues(config.runtime.data, runtimeUrl),
      sides: Object.fromEntries(
        Object.entries(config.runtime.sides).map(([key, side]) => [
          key,
          { ...side, url: runtimeUrl(side.url) },
        ]),
      ),
      assets: mapValues(config.app.assets, appUrl),
      readAsset: (uri: string) =>
        fonts.get(uri.replace(/^asset:\/+/, '')) ?? null,
      history: false,
      overlay: false,
      host: { call: (name: string, args: unknown) => host.call(name, args) },
      onError: (message: string) => fail(message),
    });
    // Text NSH draws before a face has loaded stays invisible until the next
    // repaint, so the Desk faces (player fonts.css) load first, briefly.
    await Promise.race([
      Promise.all(
        PLAYER_FONT_FAMILIES.map((family) =>
          document.fonts.load(`16px "${family}"`).catch(() => []),
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
    ]);
    document.getElementById('status')?.setAttribute('hidden', '');
    created.hostEvent('hatch.theme', { theme: theme() });
    player = created;
    for (const message of pending.splice(0)) apply(message);
    await created.runModule(appUrl(config.app.code), {
      capabilities: config.grant,
      appId: config.nshAppId,
      chunks: mapValues(config.app.chunks, appUrl),
      nativeExports: config.app.nativeExports,
      linked: true,
      params: { route },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
