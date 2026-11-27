/**
 * The classes of a card's parts on each look. The web look is the Desk's
 * notification card (`src/components/notifications`), iOS and Android follow
 * the Mobile app's card, and macOS and Windows keep the web tree with their
 * own type, as the rest of the library does. Only theme tokens.
 */
import { byLook } from '../core/env';
import type { ContentTone } from './content/catalog.gen';

/** A tone's tint chip: shade-1 fill and shade-8 text. */
export const TONE_TINT: Record<ContentTone, string> = {
  neutral: 'bg-surface-hover text-neutral-strong',
  info: 'bg-info-tint text-info-tint-foreground',
  success: 'bg-success-tint text-success-tint-foreground',
  warning: 'bg-warning-tint text-warning-tint-foreground',
  danger: 'bg-danger-tint text-danger-tint-foreground',
  working: 'bg-working-tint text-working-tint-foreground',
};

/** A tone's fill alone, for tinted surfaces (`Box tone`, `Callout`). */
export const TONE_SURFACE: Record<ContentTone, string> = {
  neutral: 'bg-surface-hover',
  info: 'bg-info-tint',
  success: 'bg-success-tint',
  warning: 'bg-warning-tint',
  danger: 'bg-danger-tint',
  working: 'bg-working-tint',
};

/** Text on a tone's tint. */
export const TONE_ON_TINT: Record<ContentTone, string> = {
  neutral: 'text-neutral-strong',
  info: 'text-info-tint-foreground',
  success: 'text-success-tint-foreground',
  warning: 'text-warning-tint-foreground',
  danger: 'text-danger-tint-foreground',
  working: 'text-working-tint-foreground',
};

/** A tone as text on a card: shade 7. */
export const TONE_TEXT: Record<ContentTone, string> = {
  neutral: 'text-foreground',
  info: 'text-info-strong',
  success: 'text-success-strong',
  warning: 'text-warning-strong',
  danger: 'text-danger-strong',
  working: 'text-working-strong',
};

/** A tone as a bar or a dot. Neutral is the accent: never grey on grey. */
export const TONE_FILL: Record<ContentTone, string> = {
  neutral: 'bg-primary',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  working: 'bg-working',
};

/** Colour tokens of a glyph in a tone, as `Glyph` takes them. */
export const TONE_GLYPH = {
  neutral: 'foreground',
  info: 'info-strong',
  success: 'success-strong',
  warning: 'warning-strong',
  danger: 'danger-strong',
  working: 'working-strong',
} as const satisfies Record<ContentTone, string>;

/** Ink of `Text` and `Caption`: dimmed or a tone. */
export const INK: Record<string, string> = {
  dimmed: 'text-muted-foreground',
  ...TONE_TEXT,
};

export const CARD_GAP: Record<string, string> = {
  xs: 'gap-1',
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
  xl: 'gap-6',
};

export const SPACER: Record<string, string> = {
  xs: 'h-1',
  sm: 'h-2',
  md: 'h-4',
  lg: 'h-6',
  xl: 'h-8',
};

export const BOX_PADDING: Record<string, string> = {
  sm: 'px-2 py-1.5',
  md: 'px-3 py-2.5',
  lg: 'p-4',
};

/** The card itself: as `Card`, a hairline sheet on the web and the
 * desktops, edgeless on iOS and Android. */
export const FRAME = byLook({
  web: 'self-stretch gap-3 rounded-(--radius-lg) border border-hairline bg-card p-4',
  ios: 'self-stretch gap-3 rounded-(--radius-lg) bg-card p-4',
  android: 'self-stretch gap-3 rounded-(--radius-lg) bg-card p-4',
  macos:
    'self-stretch gap-3 rounded-(--radius-lg) border border-hairline bg-card p-4',
  windows:
    'self-stretch gap-3 rounded-(--radius-sm) border border-hairline bg-card p-4',
});

type Type = {
  /** `Title` sizes. */
  title: Record<string, string>;
  /** `Text` sizes. */
  text: Record<string, string>;
  /** Small text: captions, labels, details, metadata. */
  small: string;
  /** Text of data blocks: fields, steps, tables, quotes, callouts. */
  data: string;
  /** Monospaced text, one step smaller. */
  mono: string;
  /** A statistic's figure. */
  figure: string;
  /** Status pills, badges and the flag. */
  pill: string;
  /** Weights: regular, medium (labels) and bold (headings, emphasis). */
  regular: string;
  medium: string;
  bold: string;
};

/** Each look's type: the Desk card's 12-20, the Mobile card's 12-24 on iOS
 * and Android in their own scales, and the desktops' own. */
export const TYPE = byLook<Type>({
  web: {
    title: {
      sm: 'text-body',
      md: 'text-control',
      lg: 'text-subsection',
      xl: 'text-section',
    },
    text: {
      xs: 'text-caption',
      sm: 'text-control-sm',
      md: 'text-body',
      lg: 'text-body-lg',
      xl: 'text-title',
    },
    small: 'text-caption',
    data: 'text-control-sm',
    mono: 'text-caption',
    figure: 'text-modal',
    pill: 'text-caption font-heading',
    regular: 'font-body',
    medium: 'font-label',
    bold: 'font-heading',
  },
  ios: {
    title: {
      sm: 'text-ios-subhead',
      md: 'text-ios-body',
      lg: 'text-ios-title-3',
      xl: 'text-ios-title-2',
    },
    text: {
      xs: 'text-ios-caption',
      sm: 'text-ios-footnote',
      md: 'text-ios-subhead',
      lg: 'text-ios-body',
      xl: 'text-ios-title-2',
    },
    small: 'text-ios-caption',
    data: 'text-ios-footnote',
    mono: 'text-ios-caption',
    figure: 'text-ios-title-3',
    pill: 'text-ios-caption font-semibold',
    regular: 'font-regular',
    medium: 'font-medium',
    bold: 'font-semibold',
  },
  android: {
    title: {
      sm: 'text-m3-title-sm',
      md: 'text-m3-title-md',
      lg: 'text-m3-title-lg',
      xl: 'text-m3-headline-sm',
    },
    text: {
      xs: 'text-m3-body-sm',
      sm: 'text-m3-body-md',
      md: 'text-m3-body-lg',
      lg: 'text-m3-title-md',
      xl: 'text-m3-headline-sm',
    },
    small: 'text-m3-body-sm',
    data: 'text-m3-body-md',
    mono: 'text-m3-body-sm',
    figure: 'text-m3-title-lg',
    pill: 'text-m3-label-md font-medium',
    regular: 'font-regular',
    medium: 'font-medium',
    bold: 'font-medium',
  },
  macos: {
    title: {
      sm: 'text-mac-body',
      md: 'text-mac-title-3',
      lg: 'text-mac-title-2',
      xl: 'text-mac-title-1',
    },
    text: {
      xs: 'text-mac-callout',
      sm: 'text-mac-body',
      md: 'text-mac-body',
      lg: 'text-mac-title-3',
      xl: 'text-mac-title-1',
    },
    small: 'text-mac-callout',
    data: 'text-mac-body',
    mono: 'text-mac-callout',
    figure: 'text-mac-title-2',
    pill: 'text-mac-callout font-semibold',
    regular: 'font-regular',
    medium: 'font-medium',
    bold: 'font-bold',
  },
  windows: {
    title: {
      sm: 'text-win-body',
      md: 'text-win-body',
      lg: 'text-win-body-lg',
      xl: 'text-win-subtitle',
    },
    text: {
      xs: 'text-win-caption',
      sm: 'text-win-label',
      md: 'text-win-body',
      lg: 'text-win-body-lg',
      xl: 'text-win-title',
    },
    small: 'text-win-caption',
    data: 'text-win-label',
    mono: 'text-win-caption',
    figure: 'text-win-subtitle',
    pill: 'text-win-caption font-semibold',
    regular: 'font-regular',
    medium: 'font-semibold',
    bold: 'font-semibold',
  },
});

/** Corners of the blocks inside a card: one step under the card's. */
export const BLOCK_RADIUS = byLook({
  web: 'rounded-(--radius-md)',
  ios: 'rounded-(--radius-md)',
  android: 'rounded-(--radius-md)',
  macos: 'rounded-(--radius-md)',
  windows: 'rounded-(--radius-xs)',
});

/** A choice's option row: a bordered row on the web and the desktops, the
 * platform's own row height on touch. */
export const OPTION = byLook({
  web: 'group min-h-11 flex-row items-center gap-2.5 rounded-(--radius-md) border border-hairline bg-card px-3',
  ios: 'group min-h-11 flex-row items-center gap-3 rounded-(--radius-md) border border-hairline bg-card px-3',
  android:
    'group min-h-12 flex-row items-center gap-3 rounded-(--radius-md) border border-hairline bg-card px-3',
  macos:
    'group min-h-8 flex-row items-center gap-2 rounded-(--radius-sm) border border-hairline bg-card px-2.5',
  windows:
    'group min-h-9 flex-row items-center gap-3 rounded-(--radius-xs) border border-hairline bg-card px-3',
});

/** A chosen option's row. */
export const OPTION_SELECTED = 'border-primary bg-primary-tint';
