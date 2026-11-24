/**
 * Class strings shared by several components. Every colour is a theme token
 * and every size a step of the Tailwind scale or a token, so the host's
 * theme restyles them while the App runs.
 */
import type { Align, Justify, Space, Tone } from './types';

/** DESIGN.md "Focus": a 2-point ink outline, 2 points out, on keyboard focus. */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** The same ring drawn inside, where an ancestor clips (rows in a list). */
export const FOCUS_RING_INSET =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

export const GAP: Record<Space, string> = {
  none: 'gap-0',
  xs: 'gap-1',
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
  xl: 'gap-6',
  '2xl': 'gap-8',
};

export const ALIGN: Record<Align, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
};

export const JUSTIFY: Record<Justify, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
};

/** A tone as a tint chip: shade-1 fill, shade-8 text (DESIGN.md "Badge"). */
export const TONE_TINT: Record<Tone, string> = {
  neutral: 'bg-surface-hover text-neutral-strong',
  accent: 'bg-primary-tint text-primary-tint-foreground',
  success: 'bg-success-tint text-success-tint-foreground',
  warning: 'bg-warning-tint text-warning-tint-foreground',
  danger: 'bg-danger-tint text-danger-tint-foreground',
  info: 'bg-info-tint text-info-tint-foreground',
};

/** A tone as a dot or a bar: the tone's own shade. */
export const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-control-border',
  accent: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

/** A tone as text on a sheet: shade 7, 4.5:1 or better. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  accent: 'text-primary-strong',
  success: 'text-success-strong',
  warning: 'text-warning-strong',
  danger: 'text-danger-strong',
  info: 'text-info-strong',
};

/** DESIGN.md "Menu, popover": the one treatment of every anchored popup.
 * On phones the same classes style the sheet NSH shows instead. */
export const POPUP =
  'rounded-(--radius-lg) border border-hairline bg-popover p-1.5 shadow-dock transition-all duration-150 ease-out';
export const POPUP_STARTING = 'opacity-0 -translate-y-1';
export const POPUP_ENDING = 'opacity-0';
export const BACKDROP = 'bg-scrim';

/** A row of a menu or a list box: 32 points, 44 on touch. */
export const POPUP_ITEM =
  'group min-h-8 flex-row items-center gap-2 rounded-(--radius-sm) px-2.5 py-1.5 text-body font-strong text-popover-foreground focus:bg-surface-hover hover:bg-surface-hover disabled:opacity-50 pointer-coarse:min-h-11';

/** A group's label inside a popup. */
export const POPUP_GROUP =
  'px-2.5 pb-1 pt-2 text-eyebrow font-heading uppercase tracking-eyebrow text-muted-foreground';
