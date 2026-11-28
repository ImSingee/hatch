/**
 * Where the App runs, as the components decide layout, density and habits
 * from it.
 *
 * Layout follows the App's own pane: NSH's `windowSize()` is the surface the
 * App renders into (the web player's container, the native view), so an App
 * in a narrow window or a split pane on a desktop lays out as a narrow App.
 * Density follows the input: touch idioms get 44-point targets. Habits
 * follow the platform (`look`): iOS, Android, macOS and Windows controls on
 * those, the Desk's own elsewhere.
 */
import { host, platform, windowSize } from 'nsh';
import { lookOf, resolvePlatform } from './platform';
import type { DesktopLook, HostPlatform, Look, MobileLook } from './platform';

export type { DesktopLook, HostPlatform, Look, MobileLook };

/** The platform the App runs on: NSH's OS, or in the web player the one
 * its shell names (`host.params.platform`). Constant while it runs. */
export const hostPlatform: HostPlatform = resolvePlatform(
  platform.os,
  host.available() ? host.params : {},
);

/** The habits the components follow. */
export const look: Look = lookOf(hostPlatform);

/** iOS or Android: the touch looks, with their own page and list trees. */
export const mobileLook: boolean = look === 'ios' || look === 'android';

/** The value for the App's look. */
export function byLook<T>(values: Record<Look, T>): T {
  return values[look];
}

/** Phones and tablets (and Mac Catalyst): touch targets, sheets, tab bars. */
export const touch: boolean = !platform.desktop;

/** A phone: dialogs become sheets, the AppShell uses a bottom tab bar. */
export const phone: boolean = platform.idiom === 'phone';

/** How wide the App's pane is. */
export type PaneSize = 'compact' | 'medium' | 'wide';

/** Below this, a pane is compact: one column, no sidebars. */
export const COMPACT_MAX = 600;
/** From this width up, a pane is wide: side-by-side layouts. */
export const WIDE_MIN = 960;
/** From this width up, `AppShell` shows a sidebar. */
export const SIDEBAR_MIN = 720;

/** The pane's width in points (reactive). */
export function paneWidth(): number {
  return windowSize().width;
}

/** The pane's size class (reactive). */
export function paneSize(): PaneSize {
  const width = windowSize().width;
  if (width < COMPACT_MAX) return 'compact';
  if (width < WIDE_MIN) return 'medium';
  return 'wide';
}
