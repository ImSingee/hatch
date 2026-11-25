/**
 * The channel between a web shell's App surface (the platform page that
 * frames an App) and the native App player page inside the frame. The web
 * player imports it; so does `AppSurface` in the platform UI. It carries
 * everything the surface used to read from a `web` App's frame directly.
 *
 * Handshake: the player page marks itself with
 * `<meta name="hatch-app-runtime" content="native">`. On the frame's `load`
 * the surface posts `{ protocol, type: 'connect' }` to the frame's window
 * with a `MessagePort`; both sides then talk only over that port. Both check
 * that the other side is the expected window on the platform's own origin.
 */

export const NATIVE_SURFACE_PROTOCOL = 'hatch.app-surface/1';
export const NATIVE_RUNTIME_META = 'hatch-app-runtime';

/** Surface -> player. */
export type SurfaceMessage =
  /** First message on the port: how the player should start the App. */
  | {
      type: 'init';
      /** Raw, percent-encoded fragment without `#`; '' is the App's home. */
      route: string;
      /** Instance accent name; unknown names fall back to the default. */
      accent: string;
      visible: boolean;
    }
  | { type: 'navigate'; route: string }
  | { type: 'theme'; accent: string }
  | { type: 'visibility'; visible: boolean }
  /** A newer deployment of this App is live. */
  | { type: 'update-available' };

/** Player -> surface. */
export type PlayerMessage =
  /** Sent once the port is connected: what is running in the frame. */
  | { type: 'hello'; appId: string; deploymentId: string }
  | { type: 'route'; route: string }
  | { type: 'title'; title: string | null }
  /** The App asked to open another App (`hatch.nav.open`). */
  | { type: 'open'; slug: string; route: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validate a message from the surface; anything else is ignored. */
export function parseSurfaceMessage(value: unknown): SurfaceMessage | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'init':
      return typeof value.route === 'string' &&
        typeof value.accent === 'string' &&
        typeof value.visible === 'boolean'
        ? {
            type: 'init',
            route: value.route,
            accent: value.accent,
            visible: value.visible,
          }
        : null;
    case 'navigate':
      return typeof value.route === 'string'
        ? { type: 'navigate', route: value.route }
        : null;
    case 'theme':
      return typeof value.accent === 'string'
        ? { type: 'theme', accent: value.accent }
        : null;
    case 'visibility':
      return typeof value.visible === 'boolean'
        ? { type: 'visibility', visible: value.visible }
        : null;
    case 'update-available':
      return { type: 'update-available' };
    default:
      return null;
  }
}

/** Validate a message from the player; anything else is ignored. */
export function parsePlayerMessage(value: unknown): PlayerMessage | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'hello':
      return typeof value.appId === 'string' &&
        typeof value.deploymentId === 'string'
        ? {
            type: 'hello',
            appId: value.appId,
            deploymentId: value.deploymentId,
          }
        : null;
    case 'route':
      return typeof value.route === 'string'
        ? { type: 'route', route: value.route }
        : null;
    case 'title':
      return typeof value.title === 'string' || value.title === null
        ? { type: 'title', title: value.title }
        : null;
    case 'open':
      return typeof value.slug === 'string' && typeof value.route === 'string'
        ? { type: 'open', slug: value.slug, route: value.route }
        : null;
    default:
      return null;
  }
}
