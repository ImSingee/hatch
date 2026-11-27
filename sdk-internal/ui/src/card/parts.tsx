/**
 * The parts of a card: layout, text, inline marks, markers and data. Each
 * is the component of one catalog type (`content/catalog.gen.ts`), with the
 * catalog's props in camelCase, so a card from markup and one written in
 * TSX draw through the same components.
 */
/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/aria-role, jsx-a11y/role-has-required-aria-props -- NSH has no HTML elements: a view's role and state are its semantics. */
import { Text as NshText, Scroll, View, context, locale, signal } from 'nsh';
import type { JSX } from 'nsh';
import { Progress as BaseProgress } from 'nsh/base';
import { Each } from '../core/control';
import { byLook, mobileLook } from '../core/env';
import { FOCUS_RING } from '../core/styles';
import { Glyph } from '../icons/Icon';
import type { GlyphColor } from '../icons/Icon';
import {
  IconActivity,
  IconAlertTriangle,
  IconApps,
  IconBug,
  IconCheck,
  IconChevronRight,
  IconCircle,
  IconClock,
  IconCoin,
  IconDatabase,
  IconGitPullRequest,
  IconListCheck,
  IconLoader2,
  IconMessage,
  IconMinus,
  IconPackage,
  IconRocket,
  IconShield,
  IconSparkles,
  IconX,
} from '../icons/icons.gen';
import type { IconData } from '../icons/icon-data';
import type {
  CardIconName,
  ContentTone,
  Spacing,
  StepState,
} from './content/catalog.gen';
import { CardContext, linkAction } from './form';
import {
  BLOCK_RADIUS,
  BOX_PADDING,
  CARD_GAP,
  INK,
  SPACER,
  TONE_DOT,
  TONE_FILL,
  TONE_GLYPH,
  TONE_ON_TINT,
  TONE_SURFACE,
  TONE_TINT,
  TYPE,
} from './styles';

// ------------------------------------------------------------------ shared

/** The icons a card may name, as the Desk draws them. */
export const CARD_ICON_DATA: Record<CardIconName, IconData> = {
  agent: IconSparkles,
  app: IconApps,
  pr: IconGitPullRequest,
  deploy: IconRocket,
  task: IconListCheck,
  alert: IconAlertTriangle,
  shield: IconShield,
  chart: IconActivity,
  clock: IconClock,
  database: IconDatabase,
  bug: IconBug,
  message: IconMessage,
  package: IconPackage,
  money: IconCoin,
};

/** Whether content is text (strings, or text that follows a signal) rather
 * than blocks. Text in a view is not shown, so flow parts (list items,
 * quotes, callouts) set their text in a paragraph and lay blocks out. */
function isTextual(children: JSX.Element): boolean {
  const items = Array.isArray(children) ? children.flat(8) : [children];
  return items.some(
    (item) =>
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'function',
  );
}

/** Content of a flow part: a paragraph of its text, or its blocks. */
function Flow(props: { children?: JSX.Element; class: string }): JSX.Element {
  const children = props.children;
  return isTextual(children) ? (
    <NshText class={`${props.class} text-pretty`}>{children}</NshText>
  ) : (
    <View class="gap-1.5">{children}</View>
  );
}

const LINES: Record<number, string> = {
  1: 'truncate',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
  6: 'line-clamp-6',
  7: 'line-clamp-7',
  8: 'line-clamp-8',
  9: 'line-clamp-9',
  10: 'line-clamp-10',
};

function clamp(lines: number | undefined): string {
  if (!lines) return 'text-pretty';
  // The catalog allows 1-10 lines.
  return LINES[Math.min(10, Math.max(1, Math.round(lines)))] ?? '';
}

const ALIGN_TEXT: Record<string, string> = {
  start: 'text-start',
  center: 'text-center',
  end: 'text-end',
};

// ------------------------------------------------------------------ layout

export type ColumnProps = {
  children?: JSX.Element;
  /** Space between children; default `sm`. */
  gap?: Spacing;
  /** Cross-axis alignment; default stretch. */
  align?: 'start' | 'center' | 'end' | 'stretch';
};

const ALIGN_ITEMS: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
};

const JUSTIFY: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
};

/** Children stacked vertically. */
export function Column(props: ColumnProps): JSX.Element {
  return (
    <View
      class={`min-w-0 flex-col ${CARD_GAP[props.gap ?? 'sm']} ${ALIGN_ITEMS[props.align ?? 'stretch']}`}
    >
      {props.children}
    </View>
  );
}

export type RowProps = {
  children?: JSX.Element;
  gap?: Spacing;
  /** Main-axis distribution. */
  justify?: 'start' | 'center' | 'end' | 'between';
  /** Cross-axis alignment; default center. */
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  /** Wraps children onto more lines. */
  wrap?: boolean;
};

/** Which rows hold buttons: a narrow card stacks those, full width. */
export type RowScope = { holdButtons(): void };

export const RowContext = context<RowScope | null>(null);

/** How narrow a card stacks its rows of buttons. */
export const CardWidthContext = context<() => number>(() => Infinity);

const STACK_BELOW = 400;

/** Children side by side; a row of buttons stacks on a narrow card. */
export function Row(props: RowProps): JSX.Element {
  const buttons = signal(0);
  const width = CardWidthContext();
  // A row holds buttons when one is inside it, however deep: it tells the
  // rows around it in turn.
  const parent = RowContext();
  const stacked = () => buttons() > 0 && width() < STACK_BELOW;
  return (
    <RowContext.Provider
      value={{
        holdButtons: () => {
          buttons.update((n) => n + 1);
          parent?.holdButtons();
        },
      }}
    >
      <View
        class={
          stacked()
            ? `min-w-0 flex-col items-stretch ${CARD_GAP[props.gap ?? 'sm']}`
            : `min-w-0 flex-row ${props.wrap ? 'flex-wrap' : ''} ${CARD_GAP[props.gap ?? 'sm']} ${ALIGN_ITEMS[props.align ?? 'center']} ${JUSTIFY[props.justify ?? 'start']}`
        }
      >
        {props.children}
      </View>
    </RowContext.Provider>
  );
}

export type GridProps = {
  children?: JSX.Element;
  /** Columns, 2-4; default 2. */
  columns?: 2 | 3 | 4;
  gap?: Spacing;
};

const GRID_COLUMNS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

/** Equal columns; four become two on a narrow card. */
export function Grid(props: GridProps): JSX.Element {
  const width = CardWidthContext();
  const columns = () => {
    const wanted = Math.min(4, Math.max(2, Math.round(props.columns ?? 2)));
    return wanted === 4 && width() < 360 ? 2 : wanted;
  };
  return (
    <View
      class={`min-w-0 grid ${GRID_COLUMNS[columns()]} ${CARD_GAP[props.gap ?? 'sm']}`}
    >
      {props.children}
    </View>
  );
}

export type BoxProps = {
  children?: JSX.Element;
  /** A muted fill (default) or an outline. */
  surface?: 'muted' | 'outline';
  /** Inner spacing; default `md`. */
  padding?: 'sm' | 'md' | 'lg';
  /** Tints the surface. */
  tone?: ContentTone;
};

/** A group on a tinted surface. */
export function Box(props: BoxProps): JSX.Element {
  const surface = () =>
    props.tone
      ? TONE_SURFACE[props.tone]
      : props.surface === 'outline'
        ? 'border border-hairline'
        : 'bg-muted';
  return (
    <View
      class={`min-w-0 flex-col gap-2 ${BLOCK_RADIUS} ${surface()} ${BOX_PADDING[props.padding ?? 'md']}`}
    >
      {props.children}
    </View>
  );
}

/** A hairline between sections. */
export function Divider(): JSX.Element {
  return <View class="h-px self-stretch bg-hairline" />;
}

export type SpacerProps = {
  /** How much space; default `md`. */
  size?: Spacing;
};

/** Extra vertical space. */
export function Spacer(props: SpacerProps): JSX.Element {
  return (
    <View
      class={SPACER[props.size ?? 'md']}
      importantForAccessibility="no-hide-descendants"
    />
  );
}

export type CollapseProps = {
  children?: JSX.Element;
  /** The toggle's label, such as "Show 12 log lines". */
  summary: string;
};

/** Content hidden behind a toggle until opened. */
export function Collapse(props: CollapseProps): JSX.Element {
  const open = signal(false);
  return (
    <View class="min-w-0 gap-2">
      <View
        role="button"
        accessible
        focusable
        onPress={() => open.set(!open())}
        accessibilityLabel={props.summary}
        accessibilityState={{ expanded: open() }}
        class={`-ml-2.5 min-h-8 flex-row items-center gap-1.5 self-start rounded-(--radius-sm) px-2.5 hover:bg-surface-hover active:bg-surface-pressed pointer-coarse:min-h-11 ${FOCUS_RING}`}
      >
        <View class={open() ? 'rotate-90' : ''}>
          <Glyph icon={IconChevronRight} size="sm" color="primary-strong" />
        </View>
        <NshText class={`${TYPE.data} ${TYPE.bold} text-primary-strong`}>
          {props.summary}
        </NshText>
      </View>
      {open() ? <View class="gap-2.5">{props.children}</View> : null}
    </View>
  );
}

// -------------------------------------------------------------------- text

export type TitleProps = {
  children?: JSX.Element;
  /** Heading size; default `md`. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  align?: 'start' | 'center' | 'end';
  /** Clamps to this many lines. */
  lines?: number;
};

/** A heading. */
export function Title(props: TitleProps): JSX.Element {
  return (
    <NshText
      role="header"
      accessibilityLevel={3}
      class={`${TYPE.title[props.size ?? 'md']} ${TYPE.bold} text-foreground ${ALIGN_TEXT[props.align ?? 'start']} ${clamp(props.lines)}`}
    >
      {props.children}
    </NshText>
  );
}

export type TextProps = {
  children?: JSX.Element;
  /** Text size, xs-xl; default `md`. */
  size?: Spacing;
  /** Default `regular`. */
  weight?: 'regular' | 'medium' | 'bold';
  /** Ink: dimmed, or a tone's colour; default the body ink. */
  tone?: 'dimmed' | ContentTone;
  align?: 'start' | 'center' | 'end';
  /** Monospaced, for identifiers. */
  mono?: boolean;
  /** Clamps to this many lines. */
  lines?: number;
};

/** A paragraph. Large or bold text is a figure or a lead: full ink. */
export function Text(props: TextProps): JSX.Element {
  const ink = () => {
    if (props.tone && props.tone !== 'neutral') return INK[props.tone];
    const strong = props.size === 'xl' || props.weight === 'bold';
    return strong || props.tone === 'neutral'
      ? 'text-foreground'
      : 'text-neutral-strong';
  };
  return (
    <NshText
      class={[
        props.mono ? `${TYPE.mono} font-mono` : TYPE.text[props.size ?? 'md'],
        TYPE[props.weight ?? 'regular'],
        ink(),
        ALIGN_TEXT[props.align ?? 'start'],
        clamp(props.lines),
      ].join(' ')}
    >
      {props.children}
    </NshText>
  );
}

export type CaptionProps = {
  children?: JSX.Element;
  /** Ink; default dimmed. */
  tone?: 'dimmed' | ContentTone;
  align?: 'start' | 'center' | 'end';
  lines?: number;
};

/** Small dimmed text, such as "Updated 10:52". */
export function Caption(props: CaptionProps): JSX.Element {
  return (
    <NshText
      class={`${TYPE.small} ${TYPE.regular} ${INK[props.tone ?? 'dimmed']} ${ALIGN_TEXT[props.align ?? 'start']} ${clamp(props.lines)}`}
    >
      {props.children}
    </NshText>
  );
}

// ------------------------------------------------------------ inline marks

/** Bold text inside a paragraph. */
export function Bold(props: { children?: JSX.Element }): JSX.Element {
  return (
    <NshText class={`${TYPE.bold} text-foreground`}>{props.children}</NshText>
  );
}

/** Italic text inside a paragraph. */
export function Italic(props: { children?: JSX.Element }): JSX.Element {
  return <NshText class="italic">{props.children}</NshText>;
}

/** Struck-through text inside a paragraph. */
export function Strike(props: { children?: JSX.Element }): JSX.Element {
  return <NshText class="line-through">{props.children}</NshText>;
}

/** Inline code inside a paragraph. */
export function InlineCode(props: { children?: string }): JSX.Element {
  return (
    <NshText
      class={`${TYPE.mono} rounded-(--radius-xs) bg-surface-bubble font-mono`}
    >
      {` ${props.children ?? ''} `}
    </NshText>
  );
}

export type LinkProps = {
  children?: JSX.Element;
  /** http(s), another app or a hatch:// page. */
  href: string;
};

/** A link inside a paragraph; opened only when pressed. A link the card
 * cannot open (see `onLinkPress`) shows as its text. */
export function Link(props: LinkProps): JSX.Element {
  const card = CardContext();
  const action = () =>
    card ? card.linkAction(props.href) : linkAction(props.href, undefined);
  return action() ? (
    <NshText
      role="link"
      onPress={() => action()?.()}
      class={`${TYPE.medium} text-primary-strong underline`}
    >
      {props.children}
    </NshText>
  ) : (
    <NshText>{props.children}</NshText>
  );
}

export type TimeProps = {
  /** An ISO-8601 time. */
  datetime: string;
  /** What to show; default the time today, else the date and time. */
  format?: 'datetime' | 'date' | 'time';
};

/** A time in the reader's language and time zone: the time alone today,
 * otherwise with its date (and year, when not this year). */
export function formatCardTime(
  iso: string,
  language: string,
  format: 'datetime' | 'date' | 'time' = 'datetime',
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today = date.toDateString() === now.toDateString();
  const thisYear = date.getFullYear() === now.getFullYear();
  const time: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  };
  const day: Intl.DateTimeFormatOptions = thisYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  const options =
    format === 'time' || (format === 'datetime' && today)
      ? time
      : format === 'date'
        ? day
        : { ...day, ...time };
  return new Intl.DateTimeFormat(language, options).format(date);
}

/** A time inside a paragraph, in the reader's language and time zone. */
export function Time(props: TimeProps): JSX.Element {
  return (
    <NshText class="text-muted-foreground">
      {formatCardTime(props.datetime, locale(), props.format) ?? props.datetime}
    </NshText>
  );
}

/** A line break inside a paragraph. */
export function LineBreak(): JSX.Element {
  return <NshText>{'\n'}</NshText>;
}

// ----------------------------------------------------------------- markers

export type BadgeProps = {
  /** The label. */
  children?: string;
  tone?: ContentTone;
};

/** A small tinted label, among blocks or inside a paragraph. */
export function Badge(props: BadgeProps): JSX.Element {
  return (
    <View class="flex-row">
      <View
        class={`h-5.5 flex-row items-center rounded-full px-2.25 ${TONE_TINT[props.tone ?? 'neutral']}`}
      >
        <NshText
          class={`${TYPE.pill} ${TONE_ON_TINT[props.tone ?? 'neutral']}`}
        >
          {props.children}
        </NshText>
      </View>
    </View>
  );
}

export type IconProps = {
  /** One of the card icons. */
  name: CardIconName;
  tone?: ContentTone;
};

/** An icon from the card's set, decorative: the text around it says what
 * it means. */
export function Icon(props: IconProps): JSX.Element {
  const data = () => CARD_ICON_DATA[props.name];
  return data() ? (
    <Glyph
      icon={data()}
      size="md"
      color={TONE_GLYPH[props.tone ?? 'neutral']}
    />
  ) : null;
}

// -------------------------------------------------------------------- data

export type ProgressProps = {
  /** What is measured. */
  label?: string;
  /** The value as text, such as "3 / 14". */
  value?: string;
  /** 0-100. */
  percent: number;
  tone?: ContentTone;
};

/** A bar filled to `percent`. */
export function Progress(props: ProgressProps): JSX.Element {
  const percent = () => Math.min(100, Math.max(0, props.percent));
  return (
    <View class="min-w-0 gap-1.5">
      {props.label || props.value ? (
        <View class="flex-row justify-between gap-3">
          <NshText class={`flex-1 ${TYPE.data} ${TYPE.medium} text-foreground`}>
            {props.label ?? ''}
          </NshText>
          {props.value ? (
            <NshText class={`${TYPE.mono} font-mono text-foreground`}>
              {props.value}
            </NshText>
          ) : null}
        </View>
      ) : null}
      <BaseProgress
        value={percent()}
        accessibilityLabel={props.label}
        class="self-stretch"
        trackClass="h-1.5 self-stretch overflow-hidden rounded-full bg-surface-sunken"
        indicatorClass={`h-1.5 rounded-full ${TONE_FILL[props.tone ?? 'neutral']} transition-all`}
      />
    </View>
  );
}

export type StatProps = {
  /** The figure. */
  value: string;
  /** What it counts. */
  label: string;
  /** Change, such as "+62%". */
  delta?: string;
  /** Tone of the delta. */
  tone?: ContentTone;
};

/** One figure with its label, on a muted tile. */
export function Stat(props: StatProps): JSX.Element {
  return (
    <View class={`min-w-0 gap-0.5 ${BLOCK_RADIUS} bg-muted px-3 py-2`}>
      <NshText class={`${TYPE.small} text-muted-foreground`}>
        {props.label}
      </NshText>
      <NshText
        class={`${TYPE.figure} ${TYPE.bold} text-foreground tabular-nums`}
      >
        {props.value}
      </NshText>
      {props.delta ? (
        <NshText
          class={`${TYPE.small} ${TYPE.medium} ${props.tone && props.tone !== 'neutral' ? INK[props.tone] : 'text-muted-foreground'}`}
        >
          {props.delta}
        </NshText>
      ) : null}
    </View>
  );
}

/** Labels share one column: the widest label's width, at most 45% of the
 * row, as the Desk card lays them out. iOS and Android give labels 30% of
 * the row, as the Mobile card does. */
const FieldsContext = context<{
  mono: () => boolean;
  labelWidth: () => number;
  measured: (width: number) => void;
}>({ mono: () => false, labelWidth: () => 0, measured: () => {} });

const LABEL_COLUMN = byLook({
  web: 'shrink-0 max-w-[45%]',
  ios: 'w-[30%] min-w-14 max-w-30',
  android: 'w-[30%] min-w-14 max-w-30',
  macos: 'shrink-0 max-w-[45%]',
  windows: 'shrink-0 max-w-[45%]',
});

const SHARED_COLUMN = !mobileLook;

export type FieldsProps = {
  children?: JSX.Element;
  /** Monospaced values. */
  mono?: boolean;
};

/** Label and value pairs. */
export function Fields(props: FieldsProps): JSX.Element {
  const width = signal(0);
  return (
    <FieldsContext.Provider
      value={{
        mono: () => props.mono === true,
        labelWidth: () => width(),
        measured: (value) => {
          if (value > width()) width.set(value);
        },
      }}
    >
      <View class="min-w-0 gap-1">{props.children}</View>
    </FieldsContext.Provider>
  );
}

export type FieldProps = {
  /** The value. */
  children?: JSX.Element;
  /** The label. */
  label: string;
  /** Monospaced value. */
  mono?: boolean;
};

/** One label and its value, inside `Fields`. */
export function Field(props: FieldProps): JSX.Element {
  const fields = FieldsContext();
  const mono = () => props.mono === true || fields.mono();
  return (
    <View class="min-w-0 flex-row items-baseline gap-3">
      <NshText
        class={`min-w-13 ${LABEL_COLUMN} ${TYPE.data} text-muted-foreground`}
        style={SHARED_COLUMN ? { minWidth: fields.labelWidth() } : undefined}
        onLayout={
          SHARED_COLUMN
            ? (event) => fields.measured(event.bounds.size.width)
            : undefined
        }
      >
        {props.label}
      </NshText>
      <NshText
        class={`min-w-0 flex-1 ${mono() ? `${TYPE.mono} font-mono` : TYPE.data} text-foreground`}
      >
        {props.children}
      </NshText>
    </View>
  );
}

const StepsContext = context<{ mono: () => boolean; next: () => number }>({
  mono: () => false,
  next: () => 0,
});

export type StepsProps = {
  children?: JSX.Element;
  /** Monospaced names in an outlined list, for checks. */
  mono?: boolean;
};

/** A checklist of steps or checks. */
export function Steps(props: StepsProps): JSX.Element {
  const counter = { steps: 0 };
  return (
    <StepsContext.Provider
      value={{ mono: () => props.mono === true, next: () => counter.steps++ }}
    >
      <View
        role="list"
        class={
          props.mono
            ? `min-w-0 overflow-hidden ${BLOCK_RADIUS} border border-hairline`
            : 'min-w-0 gap-1.5'
        }
      >
        {props.children}
      </View>
    </StepsContext.Provider>
  );
}

const STEP_GLYPH: Record<StepState, { icon: IconData; color: GlyphColor }> = {
  done: { icon: IconCheck, color: 'success-strong' },
  failed: { icon: IconX, color: 'danger-strong' },
  running: { icon: IconLoader2, color: 'info-strong' },
  pending: { icon: IconCircle, color: 'muted-foreground' },
  skipped: { icon: IconMinus, color: 'muted-foreground' },
};

/** What a step's state is called, for screen readers. */
export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  failed: 'Failed',
  running: 'Running',
  pending: 'Pending',
  skipped: 'Skipped',
};

export type StepProps = {
  /** The step's name. */
  children?: JSX.Element;
  /** Default `pending`. */
  state?: StepState;
  /** Shown at the end, such as "2m 14s". */
  detail?: string;
  /** When it happened; shown as a time when there is no detail. */
  at?: string;
  /** Opens the step, such as its log. */
  href?: string;
};

/** One step of `Steps`. */
export function Step(props: StepProps): JSX.Element {
  const steps = StepsContext();
  const mono = steps.mono;
  const first = steps.next() === 0;
  const state = () => props.state ?? 'pending';
  const glyph = () => STEP_GLYPH[state()];
  const quiet = () => state() === 'pending' || state() === 'skipped';
  const name = () => (
    <NshText
      class={`min-w-0 flex-1 ${mono() ? `${TYPE.mono} font-mono` : TYPE.data} ${state() === 'failed' || state() === 'running' ? TYPE.bold : ''} ${quiet() ? 'text-muted-foreground' : 'text-foreground'}`}
    >
      {props.href ? (
        <Link href={props.href}>{props.children}</Link>
      ) : (
        props.children
      )}
    </NshText>
  );
  return (
    <View
      class={`min-w-0 flex-row items-center gap-2.5 ${mono() ? `px-3 py-2 ${first ? '' : 'border-t border-hairline'}` : ''}`}
      accessibilityValue={{ text: STEP_STATE_LABEL[state()] }}
    >
      <View
        class={
          state() === 'running' ? 'animate-spin motion-reduce:animate-none' : ''
        }
      >
        <Glyph
          icon={glyph().icon}
          size="sm"
          color={glyph().color}
          label={STEP_STATE_LABEL[state()]}
        />
      </View>
      {name()}
      {props.detail || props.at ? (
        <NshText
          class={`max-w-[45%] ${TYPE.small} text-end text-muted-foreground`}
        >
          {props.detail ?? formatCardTime(props.at!, locale()) ?? props.at}
        </NshText>
      ) : null}
    </View>
  );
}

const ListContext = context<{ ordered: () => boolean; next: () => number }>({
  ordered: () => false,
  next: () => 0,
});

export type ListProps = {
  children?: JSX.Element;
  /** Numbered. */
  ordered?: boolean;
};

/** A bulleted, numbered or task list. */
export function List(props: ListProps): JSX.Element {
  const counter = { items: 0 };
  return (
    <ListContext.Provider
      value={{
        ordered: () => props.ordered === true,
        next: () => ++counter.items,
      }}
    >
      <View role="list" class="min-w-0 gap-0.5">
        {props.children}
      </View>
    </ListContext.Provider>
  );
}

export type ItemProps = {
  children?: JSX.Element;
  /** A task item: true when done, false when not. */
  checked?: boolean;
};

/** One item of `List`. */
export function Item(props: ItemProps): JSX.Element {
  const list = ListContext();
  const number = list.next();
  const text = `${TYPE.text.md} ${TYPE.regular} text-neutral-strong`;
  const task = typeof props.checked === 'boolean';
  // A task item is one checkbox, named by its text.
  return (
    <View
      class="min-w-0 flex-row items-start gap-2"
      role={task ? 'checkbox' : undefined}
      accessibilityState={
        task ? { checked: props.checked, disabled: true } : undefined
      }
    >
      {task ? (
        <View
          class={`mt-0.5 size-4 items-center justify-center rounded-(--radius-xs) border-2 ${props.checked ? 'border-primary bg-primary' : 'border-control-border bg-card'}`}
        >
          {props.checked ? (
            <Glyph icon={IconCheck} size="xs" color="primary-foreground" />
          ) : null}
        </View>
      ) : (
        <NshText class={`min-w-4.5 ${text}`} importantForAccessibility="no">
          {list.ordered() ? `${number}.` : '•'}
        </NshText>
      )}
      <View class="min-w-0 flex-1">
        <Flow class={text}>{props.children}</Flow>
      </View>
    </View>
  );
}

const TableContext = context<{ row: () => number }>({ row: () => 0 });

/** Rows of cells; leading rows of header cells form the head. */
export function Table(props: { children?: JSX.Element }): JSX.Element {
  const counter = { rows: 0 };
  return (
    <TableContext.Provider value={{ row: () => counter.rows++ }}>
      <View
        role="table"
        class="min-w-0 overflow-hidden rounded-(--radius-sm) border border-hairline"
      >
        {props.children}
      </View>
    </TableContext.Provider>
  );
}

const RowHeadContext = context<() => boolean>(() => false);

/** A table row. */
export function Tr(props: { children?: JSX.Element }): JSX.Element {
  const table = TableContext();
  const head = signal(true);
  const index = table.row();
  return (
    <RowHeadContext.Provider value={() => index === 0 && head()}>
      <View
        role="row"
        class={`flex-row ${index === 0 ? (head() ? 'bg-muted' : '') : 'border-t border-hairline'}`}
      >
        <CellsContext.Provider value={{ td: () => head.set(false) }}>
          {props.children}
        </CellsContext.Provider>
      </View>
    </RowHeadContext.Provider>
  );
}

const CellsContext = context<{ td: () => void }>({ td: () => {} });

export type CellProps = {
  children?: JSX.Element;
  align?: 'start' | 'center' | 'end';
};

/** A header cell. */
export function Th(props: CellProps): JSX.Element {
  return (
    <View role="columnheader" class="min-w-0 flex-1 px-3 py-1.5">
      <NshText
        class={`${TYPE.data} ${TYPE.bold} text-foreground ${ALIGN_TEXT[props.align ?? 'start']}`}
      >
        {props.children}
      </NshText>
    </View>
  );
}

/** A cell. */
export function Td(props: CellProps): JSX.Element {
  CellsContext().td();
  return (
    <View role="cell" class="min-w-0 flex-1 px-3 py-1.5">
      <NshText
        class={`${TYPE.data} text-foreground ${ALIGN_TEXT[props.align ?? 'start']}`}
      >
        {props.children}
      </NshText>
    </View>
  );
}

export type QuoteProps = {
  children?: JSX.Element;
  /** Who said it. */
  author?: string;
  /** Where, such as "idle-shutdown.ts:142". */
  location?: string;
};

/** Something someone said, such as a review comment. */
export function Quote(props: QuoteProps): JSX.Element {
  return (
    <View class={`min-w-0 gap-1 ${BLOCK_RADIUS} bg-surface-bubble px-3 py-2.5`}>
      {props.author || props.location ? (
        <NshText class={`${TYPE.small} text-muted-foreground`}>
          {props.author ? (
            <NshText class={`${TYPE.bold} text-foreground`}>
              {props.author}
            </NshText>
          ) : null}
          {props.author && props.location ? ' · ' : ''}
          {props.location ?? ''}
        </NshText>
      ) : null}
      <Flow class={`${TYPE.data} text-foreground`}>{props.children}</Flow>
    </View>
  );
}

export type CodeProps = {
  /** The text, kept as written. */
  children?: string;
  /** `diff` colours added and removed lines. */
  language?: 'text' | 'diff';
};

/** Preformatted text, such as a log excerpt or a diff; scrolls sideways. */
export function Code(props: CodeProps): JSX.Element {
  const lines = () => (props.children ?? '').split('\n');
  const change = (line: string) =>
    props.language !== 'diff'
      ? 'text-foreground'
      : line.startsWith('+')
        ? 'bg-success-tint text-success-tint-foreground'
        : line.startsWith('-')
          ? 'bg-danger-tint text-danger-tint-foreground'
          : 'text-muted-foreground';
  return (
    <View class={`min-w-0 overflow-hidden ${BLOCK_RADIUS} bg-muted py-2.5`}>
      <Scroll horizontal class="self-stretch">
        <View class="min-w-full px-3" selectable>
          <Each of={lines()} key="index">
            {(line) => (
              <NshText class={`${TYPE.mono} font-mono ${change(line())}`}>
                {line() || ' '}
              </NshText>
            )}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}

export type TrendProps = {
  /** The numbers, oldest first. */
  values: number[];
  /** Highlights bars above it. */
  threshold?: number;
  /** Such as "¥" or "ms". */
  unit?: string;
  /** What is charted. */
  label?: string;
};

/** A small bar chart; bars over the threshold are highlighted. */
export function Trend(props: TrendProps): JSX.Element {
  const values = () => props.values.filter((value) => Number.isFinite(value));
  const top = () =>
    Math.max(...values(), props.threshold ?? Number.NEGATIVE_INFINITY, 0);
  const height = (value: number): `${number}%` =>
    top() > 0 ? `${Math.max(3, (Math.max(0, value) / top()) * 100)}%` : '3%';
  const description = () =>
    `${props.label ?? 'Trend'}: ${values()
      .map((value) => `${props.unit ?? ''}${value}`)
      .join(', ')}`;
  return values().length === 0 ? null : (
    <View class="min-w-0 gap-1.5">
      {props.label ? (
        <NshText class={`${TYPE.small} text-muted-foreground`}>
          {props.label}
        </NshText>
      ) : null}
      <View
        role="image"
        accessibilityLabel={description()}
        class="relative h-15 flex-row items-end gap-1.5"
      >
        {props.threshold !== undefined && top() > 0 ? (
          <View
            class="absolute inset-x-0 h-px border-t border-dashed border-danger-strong"
            style={{
              bottom:
                `${(Math.max(0, props.threshold) / top()) * 100}%` as `${number}%`,
            }}
          />
        ) : null}
        <Each of={values()} key="index">
          {(value) => (
            <View
              class={`min-w-0 flex-1 rounded-t-(--radius-xs) ${props.threshold !== undefined && value() > props.threshold ? 'bg-danger-strong' : 'bg-primary/45'}`}
              style={{ height: height(value()) }}
            />
          )}
        </Each>
      </View>
    </View>
  );
}

export type CalloutProps = {
  children?: JSX.Element;
  tone?: ContentTone;
  /** A bold first line. */
  title?: string;
};

/** A highlighted note. */
export function Callout(props: CalloutProps): JSX.Element {
  const ink = () => TONE_ON_TINT[props.tone ?? 'neutral'];
  return (
    <View
      class={`min-w-0 gap-0.5 ${BLOCK_RADIUS} ${TONE_SURFACE[props.tone ?? 'neutral']} px-3 py-2.5`}
    >
      {props.title ? (
        <NshText class={`${TYPE.text.lg} ${TYPE.bold} ${ink()}`}>
          {props.title}
        </NshText>
      ) : null}
      <Flow class={`${TYPE.data} ${ink()}`}>{props.children}</Flow>
    </View>
  );
}

/** The card's icon tile, at the start of its head. */
export function CardIconTile(props: { name: CardIconName }): JSX.Element {
  return (
    <View
      class="size-6.5 items-center justify-center rounded-(--radius-sm) bg-foreground"
      importantForAccessibility="no-hide-descendants"
    >
      <Glyph icon={CARD_ICON_DATA[props.name]} size="sm" color="background" />
    </View>
  );
}

/** The status pill and the urgent flag, in the card's fixed place. */
export function CardHead(props: {
  icon?: CardIconName;
  status?: { label: string; tone: ContentTone } | null;
  flag?: string | null;
}): JSX.Element {
  return props.icon || props.status || props.flag ? (
    <View class="flex-row flex-wrap items-center gap-1.5">
      {props.icon ? <CardIconTile name={props.icon} /> : null}
      {props.status ? (
        <View
          class={`h-6 flex-row items-center gap-1.5 rounded-full px-2.5 ${TONE_TINT[props.status.tone]}`}
        >
          <View
            class={`size-1.5 rounded-full ${TONE_DOT[props.status.tone]}`}
          />
          <NshText class={`${TYPE.pill} ${TONE_ON_TINT[props.status.tone]}`}>
            {props.status.label}
          </NshText>
        </View>
      ) : null}
      {props.flag ? (
        <View class="h-6 flex-row items-center rounded-full bg-danger px-2.5">
          <NshText class={`${TYPE.pill} text-destructive-foreground`}>
            {props.flag}
          </NshText>
        </View>
      ) : null}
    </View>
  ) : null;
}
