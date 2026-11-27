import { context } from 'nsh';

/**
 * The fill a control sits on, so a part drawn over an edge (Android's
 * outlined field label, which cuts its border) takes the same fill. Pages
 * on iOS and Android set `background`; cards, sheets and dialogs their own.
 */
export type Surface = 'window' | 'background' | 'card' | 'muted';

export const SurfaceContext = context<Surface>('window');

export const SURFACE_FILL: Record<Surface, string> = {
  window: 'bg-surface-window',
  background: 'bg-background',
  card: 'bg-card',
  muted: 'bg-muted',
};
