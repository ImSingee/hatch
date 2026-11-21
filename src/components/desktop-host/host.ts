/**
 * The Hatch macOS app loads this web UI in its window and announces itself
 * with a `HatchDesktop/<version>` token in the user agent. The token only
 * picks a layout; it grants nothing, so a browser that copies it merely gets
 * the sidebar layout.
 */
const DESKTOP_HOST = /\bHatchDesktop\/\d+(?:\.\d+)*\b/;

export function isDesktopHost(userAgent = globalThis.navigator?.userAgent) {
  return typeof userAgent === 'string' && DESKTOP_HOST.test(userAgent);
}

/**
 * The macOS app's menu and keyboard shortcuts reach the page as this event.
 * The host dispatches it on `window`; the page decides what each command
 * means, so the host never needs to know a route's implementation.
 */
export const DESKTOP_COMMAND_EVENT = 'hatch:desktop-command';

export type DesktopCommand =
  | { type: 'navigate'; to: DesktopDestination }
  | { type: 'focus-search' }
  | { type: 'toggle-sidebar' };

/** Pages the menu opens; anything else is refused. */
export const DESKTOP_DESTINATIONS = [
  '/dashboard',
  '/agent',
  '/apps',
  '/workflows',
  '/notifications',
  '/settings',
] as const;
export type DesktopDestination = (typeof DESKTOP_DESTINATIONS)[number];

/** Reads an event detail, refusing anything that is not a known command. */
export function parseDesktopCommand(detail: unknown): DesktopCommand | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const { type, to } = detail as { type?: unknown; to?: unknown };
  if (type === 'focus-search' || type === 'toggle-sidebar') return { type };
  if (
    type === 'navigate' &&
    (DESKTOP_DESTINATIONS as readonly unknown[]).includes(to)
  )
    return { type, to: to as DesktopDestination };
  return null;
}
