import { context, signal } from 'nsh';

/** What a `Page` needs from the `NavStack` it is in: whether it can go back. */
export type PageNav = {
  /** True on every page above the stack's first. */
  canGoBack: () => boolean;
  back: () => void;
  /** The title of the page back leads to: iOS's back button names it. */
  backLabel?: () => string | undefined;
  /** Names this page's title for the back button of the page above it;
   * returns the function that takes it back. */
  nameTitle?: (title: () => string) => () => void;
};

export const PageNavContext = context<PageNav | null>(null);

/** Set by `AppShell` and pattern pages that draw their own title, so a
 * `Page` inside them does not repeat it. */
export const ChromeContext = context<{ inShell: boolean }>({ inShell: false });

/** Space the shell's chrome takes over the bottom of a section, as the
 * height class of a spacer (reactive: the shell's layout follows the pane):
 * `AppShell`'s floating iOS tab bar draws over the section, so a `Page`
 * scrolls its content clear of it. */
export const BottomChromeContext = context<() => string>(() => '');

/** Whether an `AppShell` shows its bottom tab bar, which toasts rise above. */
export const bottomBarShown = signal(false);

/** The sidebar of an `AppShell` that people can hide (macOS): while the
 * sidebar layout is on, a `Page` puts its toggle at the start of its title
 * row, where macOS keeps it in a window's toolbar. */
export type SidebarToggle = {
  /** True while the pane is wide enough for the sidebar. */
  available: () => boolean;
  /** True while the sidebar shows. */
  shown: () => boolean;
  toggle: () => void;
};

export const SidebarToggleContext = context<SidebarToggle | null>(null);
