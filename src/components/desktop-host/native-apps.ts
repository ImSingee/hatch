/**
 * Native Apps in the macOS app. There a `native` App runs in an NSH view the
 * app places over the page, not in the web player: the page's App surface
 * keeps its place in the layout and tells the app where it is, whether it
 * shows, and what the App should hear (`desktop/src-tauri/src/native/`).
 *
 * Commands go through the Tauri IPC the app grants this instance's pages;
 * the app answers with `hatch:native-app` events on `window`.
 */
import { isDesktopHost } from './host';

export const NATIVE_APP_EVENT = 'hatch:native-app';

export type NativeAppEvent =
  | { type: 'ready'; key: string; deploymentId: string; build: number }
  | { type: 'failed'; key: string; code: string; message: string }
  | { type: 'title'; key: string; title: string | null }
  | { type: 'route'; key: string; route: string }
  | { type: 'open'; key: string; slug: string; route: string }
  | { type: 'shortcut'; key: string; chord: string };

export type NativeSurfaceMessage =
  | { type: 'navigate'; route: string }
  | { type: 'theme' }
  | { type: 'update-available' };

export type CssRect = { x: number; y: number; width: number; height: number };

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  if (typeof window === 'undefined' || !isDesktopHost()) return null;
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }
  ).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function'
    ? internals.invoke.bind(internals)
    : null;
}

/** Whether this page runs inside a macOS app that runs native Apps itself. */
export function nativeAppsAvailable(): boolean {
  return tauriInvoke() !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown): value is string => typeof value === 'string';

/** Reads an event detail, refusing anything that is not a known event. */
export function parseNativeAppEvent(detail: unknown): NativeAppEvent | null {
  if (!isRecord(detail) || !str(detail.key)) return null;
  const { key } = detail;
  switch (detail.type) {
    case 'ready':
      return str(detail.deploymentId) && typeof detail.build === 'number'
        ? {
            type: 'ready',
            key,
            deploymentId: detail.deploymentId,
            build: detail.build,
          }
        : null;
    case 'failed':
      return str(detail.code) && str(detail.message)
        ? { type: 'failed', key, code: detail.code, message: detail.message }
        : null;
    case 'title':
      return detail.title === null || str(detail.title)
        ? { type: 'title', key, title: detail.title || null }
        : null;
    case 'route':
      return str(detail.route)
        ? { type: 'route', key, route: detail.route }
        : null;
    case 'open':
      return str(detail.slug) && str(detail.route)
        ? { type: 'open', key, slug: detail.slug, route: detail.route }
        : null;
    case 'shortcut':
      return str(detail.chord)
        ? { type: 'shortcut', key, chord: detail.chord }
        : null;
    default:
      return null;
  }
}

/** Listens to the app's events about surface `key`. */
export function onNativeAppEvent(
  key: string,
  listener: (event: NativeAppEvent) => void,
): () => void {
  const handle = (event: Event) => {
    const parsed = parseNativeAppEvent((event as CustomEvent).detail);
    if (parsed && parsed.key === key) listener(parsed);
  };
  window.addEventListener(NATIVE_APP_EVENT, handle);
  return () => window.removeEventListener(NATIVE_APP_EVENT, handle);
}

function call(command: string, args: Record<string, unknown>) {
  const invoke = tauriInvoke();
  if (!invoke) return Promise.reject(new Error('No native App host.'));
  return invoke(command, args);
}

/** The app's native App commands, one surface (`key`) each. */
export const nativeApps = {
  open: (
    key: string,
    appId: string,
    route: string,
    shortcuts: readonly string[],
  ) =>
    call('native_app_open', {
      request: { key, appId, route, shortcuts },
    }),
  place: (
    key: string,
    rect: CssRect,
    viewportWidth: number,
    visible: boolean,
  ) => call('native_app_place', { key, rect, viewportWidth, visible }),
  cover: (key: string, covered: boolean) =>
    call('native_app_cover', { key, covered }),
  snapshot: async (key: string): Promise<Blob> => {
    const bytes = await call('native_app_snapshot', { key });
    const data =
      bytes instanceof ArrayBuffer
        ? bytes
        : new Uint8Array(bytes as ArrayLike<number>).buffer;
    return new Blob([data], { type: 'image/png' });
  },
  focus: (key: string) => call('native_app_focus', { key }),
  message: (key: string, message: NativeSurfaceMessage) =>
    call('native_app_message', { key, message }),
  close: (key: string) => call('native_app_close', { key }),
};
