import { Text as NshText, View } from 'nsh';
import type { JSX } from 'nsh';
import { byLook } from '../core/env';

export type TextTone =
  | 'default'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export type TextProps = {
  /** The text. Nested `Text` elements are spans of the same paragraph. */
  children?: JSX.Element;
  /** `sm` caption (12), `md` body (14, default), `lg` lead paragraph (16). */
  size?: 'sm' | 'md' | 'lg';
  /** `regular` (500, default), `strong` (600) or `bold` (700). */
  weight?: 'regular' | 'strong' | 'bold';
  /** Ink by default; `muted` for secondary text. */
  tone?: TextTone;
  align?: 'start' | 'center' | 'end';
  /** Cuts the text to this many lines with an ellipsis. */
  lines?: 1 | 2 | 3 | 4;
  /** JetBrains Mono, for identifiers, codes and values people copy. */
  mono?: boolean;
  /** Lets people select and copy the text. Only for content they copy. */
  selectable?: boolean;
};

type TextSize = NonNullable<TextProps['size']>;
type TextWeight = NonNullable<TextProps['weight']>;

/** Body text on each look: the Desk's 12/14/16, iOS's footnote, body and
 * title 3, Material's body medium, body large and title large, macOS's
 * 12/13/15 and Fluent's caption, body and body large. */
const SIZE = byLook<Record<TextSize, string>>({
  web: { sm: 'text-caption', md: 'text-body', lg: 'text-body-lg' },
  ios: { sm: 'text-ios-footnote', md: 'text-ios-body', lg: 'text-ios-title-3' },
  android: {
    sm: 'text-m3-body-md',
    md: 'text-m3-body-lg',
    lg: 'text-m3-title-lg',
  },
  macos: {
    sm: 'text-mac-callout',
    md: 'text-mac-body',
    lg: 'text-mac-title-3',
  },
  windows: {
    sm: 'text-win-caption',
    md: 'text-win-body',
    lg: 'text-win-body-lg',
  },
});

const WEIGHT = byLook<Record<TextWeight, string>>({
  web: { regular: 'font-body', strong: 'font-strong', bold: 'font-label' },
  ios: { regular: 'font-regular', strong: 'font-semibold', bold: 'font-bold' },
  android: {
    regular: 'font-regular',
    strong: 'font-medium',
    bold: 'font-bold',
  },
  macos: {
    regular: 'font-regular',
    strong: 'font-semibold',
    bold: 'font-bold',
  },
  windows: {
    regular: 'font-regular',
    strong: 'font-semibold',
    bold: 'font-bold',
  },
});

const TONE: Record<TextTone, string> = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  accent: 'text-primary-strong',
  success: 'text-success-strong',
  warning: 'text-warning-strong',
  danger: 'text-danger-strong',
  info: 'text-info-strong',
};

const ALIGN: Record<NonNullable<TextProps['align']>, string> = {
  start: 'text-start',
  center: 'text-center',
  end: 'text-end',
};

const LINES: Record<NonNullable<TextProps['lines']>, string> = {
  1: 'truncate',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
};

/** Body text. */
export function Text(props: TextProps): JSX.Element {
  const text = (
    <NshText
      class={[
        SIZE[props.size ?? 'md'],
        WEIGHT[props.weight ?? 'regular'],
        TONE[props.tone ?? 'default'],
        ALIGN[props.align ?? 'start'],
        props.lines ? LINES[props.lines] : 'text-pretty',
        props.mono ? 'font-mono' : '',
      ].join(' ')}
    >
      {props.children}
    </NshText>
  );
  // Selection belongs to a view: the texts in it share one selection.
  return props.selectable ? <View selectable>{text}</View> : text;
}

export type HeadingProps = {
  /** The heading's text. */
  children?: JSX.Element;
  /** 1 display (30), 2 page title (24, default), 3 section (20),
   * 4 subsection (17). */
  level?: 1 | 2 | 3 | 4;
  tone?: 'default' | 'muted';
  align?: 'start' | 'center' | 'end';
  lines?: 1 | 2;
};

type Level = NonNullable<HeadingProps['level']>;

/** Headings on each look: iOS's large title, title 1, title 2 and headline;
 * Material's headlines and title medium; macOS's large title, title 1,
 * title 2 and title 3; Fluent's title large, title, subtitle and body
 * large. */
const LEVEL = byLook<Record<Level, string>>({
  web: {
    1: 'text-display',
    2: 'text-title',
    3: 'text-section',
    4: 'text-subsection',
  },
  ios: {
    1: 'text-ios-large-title font-bold',
    2: 'text-ios-title-1 font-bold',
    3: 'text-ios-title-2 font-bold',
    4: 'text-ios-body font-semibold tracking-normal',
  },
  android: {
    1: 'text-m3-headline-lg font-regular tracking-normal',
    2: 'text-m3-headline-md font-regular tracking-normal',
    3: 'text-m3-headline-sm font-regular tracking-normal',
    4: 'text-m3-title-md font-medium tracking-normal',
  },
  macos: {
    1: 'text-mac-large-title font-bold tracking-normal',
    2: 'text-mac-title-1 font-bold tracking-normal',
    3: 'text-mac-title-2 font-bold tracking-normal',
    4: 'text-mac-title-3 font-semibold tracking-normal',
  },
  windows: {
    1: 'text-win-title-lg font-semibold tracking-normal',
    2: 'text-win-title font-semibold tracking-normal',
    3: 'text-win-subtitle font-semibold tracking-normal',
    4: 'text-win-body-lg font-semibold tracking-normal',
  },
});

/**
 * The type of a title a component draws (a card's, a dialog's, an empty
 * state's), on the App's look. Internal.
 */
export const TITLE = byLook({
  web: {
    card: 'text-subsection',
    modal: 'text-modal',
    section: 'text-section',
  },
  ios: {
    card: 'text-ios-body font-semibold tracking-normal',
    modal: 'text-ios-title-2 font-bold',
    section: 'text-ios-title-3 font-semibold',
  },
  android: {
    card: 'text-m3-title-md font-medium tracking-normal',
    modal: 'text-m3-headline-sm font-regular tracking-normal',
    section: 'text-m3-title-lg font-regular tracking-normal',
  },
  macos: {
    card: 'text-mac-title-3 font-bold tracking-normal',
    modal: 'text-mac-title-2 font-bold tracking-normal',
    section: 'text-mac-title-2 font-bold tracking-normal',
  },
  windows: {
    card: 'text-win-body font-semibold tracking-normal',
    modal: 'text-win-subtitle font-semibold tracking-normal',
    section: 'text-win-subtitle font-semibold tracking-normal',
  },
});

/** Body and secondary text components draw around content. Internal. */
export const BODY = byLook({
  web: { body: 'text-body', caption: 'text-caption' },
  ios: {
    body: 'text-ios-body font-regular',
    caption: 'text-ios-footnote font-regular',
  },
  android: {
    body: 'text-m3-body-lg font-regular',
    caption: 'text-m3-body-md font-regular',
  },
  macos: {
    body: 'text-mac-body font-regular',
    caption: 'text-mac-callout font-regular',
  },
  windows: {
    body: 'text-win-body font-regular',
    caption: 'text-win-caption font-regular',
  },
});

/**
 * Heading text with the `header` role and its level. Internal: `Heading`,
 * `Page`, `Card` and `Section` titles use it.
 */
export function HeadingText(props: {
  level: 1 | 2 | 3 | 4;
  class: string;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <NshText
      // oxlint-disable-next-line jsx-a11y/aria-role -- NSH's role for headings.
      role="header"
      accessibilityLevel={props.level}
      class={`font-heading tracking-heading ${props.class}`}
    >
      {props.children}
    </NshText>
  );
}

/** A heading, announced as one by screen readers. */
export function Heading(props: HeadingProps): JSX.Element {
  return (
    <HeadingText
      level={props.level ?? 2}
      class={[
        LEVEL[props.level ?? 2],
        props.tone === 'muted' ? 'text-muted-foreground' : 'text-foreground',
        ALIGN[props.align ?? 'start'],
        props.lines ? LINES[props.lines] : 'text-balance',
      ].join(' ')}
    >
      {props.children}
    </HeadingText>
  );
}
