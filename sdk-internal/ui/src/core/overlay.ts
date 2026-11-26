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
