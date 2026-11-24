import { context } from 'nsh';

/** What a `Page` needs from the `NavStack` it is in: whether it can go back. */
export type PageNav = {
  /** True on every page above the stack's first. */
  canGoBack: () => boolean;
  back: () => void;
};

export const PageNavContext = context<PageNav | null>(null);

/** Set by `AppShell` and pattern pages that draw their own title, so a
 * `Page` inside them does not repeat it. */
export const ChromeContext = context<{ inShell: boolean }>({ inShell: false });
