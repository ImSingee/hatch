import { context } from 'nsh';

/**
 * True inside a `Dialog`, `Sheet` or the alert dialog. NSH 0.6.1's tooltip
 * kept Escape while its element had the focus, even when it was not shown,
 * so a focused icon button with a tooltip would stop Escape from closing the
 * overlay; controls inside overlays leave their tooltip out. (A minimal web
 * probe with a plain button showed it on neither 0.6.1 nor 0.7.0; the rule
 * stays until the shells are checked with the library's icon buttons.)
 */
export const InOverlayContext = context(false);

/**
 * True in the actions of a sheet on iOS and Android: there each button
 * fills the width at the large size, the main action on top.
 */
export const StackedActionsContext = context(false);

/**
 * True in the actions of a page's bar on iOS and Android (`Page`): there a
 * button is the bar's plain kind, its icon alone when it has one, else its
 * label in the accent.
 */
export const BarActionsContext = context(false);
