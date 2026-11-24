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
 * Marks the document `data-host="desktop"` before first paint, so pages
 * outside the signed-in shell (sign-in, 404, errors) leave room for the
 * window's traffic lights from their first frame.
 */
export const DESKTOP_HOST_BOOT_SCRIPT = `try{if(${DESKTOP_HOST}.test(navigator.userAgent))document.documentElement.dataset.host='desktop'}catch(e){}`;

/**
 * The macOS app's menu and keyboard shortcuts reach the page as this event.
 * The host dispatches it on `window` as a cancelable event; the page decides
 * what each command means and cancels the event when it handled it. When
 * nothing does (a page outside the signed-in shell), the host loads `navigate`
 * destinations itself.
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
