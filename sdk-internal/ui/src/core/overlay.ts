import { context } from 'nsh';

/**
 * True inside a `Dialog`, `Sheet` or the alert dialog. NSH 0.6.1's tooltip
 * keeps Escape while its element has the focus, even when it is not shown,
 * so a focused icon button with a tooltip would stop Escape from closing the
 * overlay; controls inside overlays leave their tooltip out.
 */
export const InOverlayContext = context(false);
