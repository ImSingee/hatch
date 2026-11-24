import { Text as NshText, View } from 'nsh';
import type { JSX } from 'nsh';

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

const SIZE: Record<NonNullable<TextProps['size']>, string> = {
  sm: 'text-caption',
  md: 'text-body',
  lg: 'text-body-lg',
};

const WEIGHT: Record<NonNullable<TextProps['weight']>, string> = {
  regular: 'font-body',
  strong: 'font-strong',
  bold: 'font-label',
};

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

const LEVEL: Record<NonNullable<HeadingProps['level']>, string> = {
  1: 'text-display',
  2: 'text-title',
  3: 'text-section',
  4: 'text-subsection',
};

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
