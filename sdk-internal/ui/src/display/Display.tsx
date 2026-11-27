import { Text as NshText, View } from 'nsh';
import type { JSX } from 'nsh';
import { Avatar as BaseAvatar, Progress as BaseProgress } from 'nsh/base';
import { Each } from '../core/control';
import { byLook } from '../core/env';
import { TONE_FILL, TONE_TEXT, TONE_TINT } from '../core/styles';
import type { Action, IconData, Tone } from '../core/types';
import { Glyph } from '../icons/Icon';
import type { GlyphColor } from '../icons/Icon';
import { IconArrowDown, IconArrowUp, IconMinus } from '../icons/icons.gen';
import { Button } from '../input/Button';
import { BODY, HeadingText, TITLE } from './Text';

export type BadgeProps = {
  /** One or two words in sentence case: "Active", "3 due". */
  label: string;
  /** Default `neutral`. Keep ordinary metadata neutral. */
  tone?: Tone;
  /** A dot before the label, for a status. */
  dot?: boolean;
};

/** A short label for a status or a count (DESIGN.md "Status chip"). On
 * Android it is Material's outlined chip, the tone in its text and dot. */
export function Badge(props: BadgeProps): JSX.Element {
  const tone = () => props.tone ?? 'neutral';
  if (BADGE) {
    return (
      <View class="flex-row">
        <View
          class={`${BADGE.chip} ${BADGE.outlined ? '' : TONE_TINT[tone()]}`}
        >
          {props.dot ? (
            <View class={`size-2 rounded-full ${TONE_FILL[tone()]}`} />
          ) : null}
          <NshText
            class={`${BADGE.text} ${BADGE.outlined ? (tone() === 'neutral' ? 'text-foreground' : TONE_TEXT[tone()]) : ''}`}
          >
            {props.label}
          </NshText>
        </View>
      </View>
    );
  }
  return (
    <View class="flex-row">
      <View
        class={`h-5.5 flex-row items-center gap-1.5 rounded-full px-2.5 ${TONE_TINT[tone()]}`}
      >
        {props.dot ? (
          <View class={`size-1.75 rounded-full ${TONE_FILL[tone()]}`} />
        ) : null}
        <NshText class="text-caption font-label">{props.label}</NshText>
      </View>
    </View>
  );
}

const BADGE = byLook({
  web: null,
  ios: {
    chip: 'h-5.5 flex-row items-center gap-1.5 rounded-full px-2.5',
    text: 'text-ios-caption font-semibold',
    outlined: false,
  },
  android: {
    chip: 'h-8 flex-row items-center gap-2 rounded-(--radius-sm) border border-control-border px-3',
    text: 'text-m3-label-lg font-medium',
    outlined: true,
  },
  macos: {
    chip: 'h-5 flex-row items-center gap-1.5 rounded-full px-2',
    text: 'text-mac-callout font-semibold',
    outlined: false,
  },
  windows: {
    chip: 'h-5 flex-row items-center gap-1.5 rounded-(--radius-xs) px-2',
    text: 'text-win-caption font-semibold',
    outlined: false,
  },
});

/** A figure's sheet: on iOS and Android, as a `Card` there, without an
 * edge. */
const STAT = byLook({
  web: 'self-stretch gap-1.5 rounded-(--radius-lg) border border-hairline bg-card p-4',
  ios: 'self-stretch gap-1.5 rounded-(--radius-lg) bg-card p-4',
  android: 'self-stretch gap-1.5 rounded-(--radius-lg) bg-card p-4',
  macos:
    'self-stretch gap-1.5 rounded-(--radius-lg) border border-hairline bg-card p-4',
  windows:
    'self-stretch gap-1.5 rounded-(--radius-sm) border border-hairline bg-card p-4',
});

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export type AvatarProps = {
  /** The person's or the thing's name: its first letter is the monogram,
   * and screen readers read it. */
  name: string;
  /** An image URL; the monogram shows while it loads and when it fails. */
  src?: string;
  /** Picks the monogram colour; default the name. Pass an id so the colour
   * stays when the name changes. */
  colorKey?: string;
  /** `sm` 24, `md` 32 (default), `lg` 40, `xl` 56 points. */
  size?: AvatarSize;
  /** `circle` for people (default), `tile` for things such as a project. */
  shape?: 'circle' | 'tile';
};

const AVATAR_SIZE: Record<AvatarSize, string> = {
  sm: 'size-6',
  md: 'size-8',
  lg: 'size-10',
  xl: 'size-14',
};

const AVATAR_TEXT: Record<AvatarSize, string> = {
  sm: 'text-caption',
  md: 'text-body',
  lg: 'text-control',
  xl: 'text-section',
};

const TILE_RADIUS: Record<AvatarSize, string> = {
  sm: 'rounded-(--radius-xs)',
  md: 'rounded-(--radius-sm)',
  lg: 'rounded-(--radius-md)',
  xl: 'rounded-(--radius-tile)',
};

/** One class per `tiles` token; the token test keeps the count in step. */
export const TILE_FILL = [
  'bg-tile-0',
  'bg-tile-1',
  'bg-tile-2',
  'bg-tile-3',
  'bg-tile-4',
  'bg-tile-5',
  'bg-tile-6',
  'bg-tile-7',
  'bg-tile-8',
  'bg-tile-9',
  'bg-tile-10',
] as const;

/** A stable index into the tile colours for a key (FNV-1a). */
export function tileIndex(key: string): number {
  let hash = 0x811c9dc5;
  for (const char of key) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % TILE_FILL.length;
}

/** A person's picture, or a monogram on a colour chosen from their name. */
export function Avatar(props: AvatarProps): JSX.Element {
  const size = () => props.size ?? 'md';
  const radius = () =>
    props.shape === 'tile' ? TILE_RADIUS[size()] : 'rounded-full';
  const monogram = () => [...props.name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <BaseAvatar
      src={props.src ?? null}
      name={props.name}
      accessibilityLabel={props.name}
      class={`shrink-0 ${AVATAR_SIZE[size()]}`}
      imageClass={`size-full ${radius()}`}
      fallbackClass={`size-full items-center justify-center ${radius()} ${TILE_FILL[tileIndex(props.colorKey ?? props.name)]}`}
      fallback={
        <NshText
          class={`${AVATAR_TEXT[size()]} font-heading text-tile-foreground`}
        >
          {monogram()}
        </NshText>
      }
    />
  );
}

export type StatProps = {
  /** What is measured: "Harvested this month". */
  label: string;
  /** The figure, formatted: "12.4 kg", "86 %". */
  value: string;
  /** The change against a comparison, formatted: "+8 %". */
  change?: string;
  /** Whether the change is up, down or flat. */
  trend?: 'up' | 'down' | 'flat';
  /** Whether up is good (default) or bad, such as for costs. */
  upIsGood?: boolean;
  /** What the change compares with: "vs last month". */
  comparison?: string;
  icon?: IconData;
};

/** A key figure with its label and change. */
export function Stat(props: StatProps): JSX.Element {
  const good = () => {
    if (!props.trend || props.trend === 'flat') return null;
    const up = props.trend === 'up';
    return props.upIsGood === false ? !up : up;
  };
  const trendColor = (): GlyphColor =>
    good() === null
      ? 'muted-foreground'
      : good()
        ? 'success-strong'
        : 'danger-strong';
  const trendText = () =>
    good() === null
      ? 'text-muted-foreground'
      : good()
        ? 'text-success-strong'
        : 'text-danger-strong';
  return (
    <View class={STAT}>
      <View class="flex-row items-center gap-2">
        {props.icon ? (
          <Glyph icon={props.icon} size="md" color="muted-foreground" />
        ) : null}
        <NshText class="flex-1 truncate text-caption font-label text-muted-foreground">
          {props.label}
        </NshText>
      </View>
      <NshText class="text-title font-heading tracking-heading text-foreground">
        {props.value}
      </NshText>
      {props.change ? (
        <View class="flex-row items-center gap-1">
          <Glyph
            icon={
              props.trend === 'up'
                ? IconArrowUp
                : props.trend === 'down'
                  ? IconArrowDown
                  : IconMinus
            }
            size="sm"
            color={trendColor()}
          />
          <NshText class={`text-caption font-label ${trendText()}`}>
            {props.change}
          </NshText>
          {props.comparison ? (
            <NshText class="text-caption text-muted-foreground">
              {props.comparison}
            </NshText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export type ProgressProps = {
  /** What is in progress, for screen readers and shown above the bar. */
  label: string;
  /** From 0 to 100. */
  value?: number;
  /** Work whose end is not known: the bar moves without a value. */
  indeterminate?: boolean;
  /** Writes the value beside the label; default the percentage. Pass
   * `false` to hide it. */
  showValue?: boolean;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
};

/** How far a task has come. */
export function Progress(props: ProgressProps): JSX.Element {
  const value = () => Math.max(0, Math.min(100, props.value ?? 0));
  return (
    <View class="self-stretch gap-1.5">
      <View class="flex-row justify-between gap-3">
        <NshText class="flex-1 text-caption font-label text-foreground">
          {props.label}
        </NshText>
        {props.showValue !== false && !props.indeterminate ? (
          <NshText class="text-caption font-label text-muted-foreground">
            {`${Math.round(value())} %`}
          </NshText>
        ) : null}
      </View>
      <BaseProgress
        value={value()}
        indeterminate={props.indeterminate}
        accessibilityLabel={props.label}
        class="self-stretch"
        trackClass="h-1.5 self-stretch overflow-hidden rounded-full bg-track"
        indicatorClass={`h-full rounded-full ${TONE_FILL[props.tone ?? 'accent']} ${props.indeterminate ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''}`}
      />
    </View>
  );
}

export type EmptyStateProps = {
  /** What would be here: "No harvests yet". */
  title: string;
  /** One or two sentences: why it is empty and what to do. */
  description?: string;
  icon?: IconData;
  /** The way forward: at most one, shown as the primary button. */
  action?: Action;
  /** A second, quieter way forward. */
  secondaryAction?: Action;
  /** `accent` tints the icon tile; default `neutral`. */
  tone?: 'neutral' | 'accent';
  /** One muted line in place of a list's rows, for an empty list or a
   * search without results. */
  compact?: boolean;
};

/** What a page or a list shows while it has nothing to show. */
export function EmptyState(props: EmptyStateProps): JSX.Element {
  if (props.compact) {
    return (
      <View class="self-stretch items-center px-4 py-6">
        <NshText class={`text-center ${BODY.body} text-muted-foreground`}>
          {props.title}
        </NshText>
      </View>
    );
  }
  return (
    <View class="w-full max-w-105 self-center items-center gap-3 px-4 py-10">
      {props.icon ? (
        <View
          class={`size-14 items-center justify-center rounded-(--radius-lg) ${props.tone === 'accent' ? 'bg-primary-tint' : 'bg-surface-hover'}`}
        >
          <Glyph
            icon={props.icon}
            size="2xl"
            color={
              props.tone === 'accent'
                ? 'primary-tint-foreground'
                : 'muted-foreground'
            }
          />
        </View>
      ) : null}
      <HeadingText
        level={2}
        class={`text-center ${TITLE.section} text-foreground text-balance`}
      >
        {props.title}
      </HeadingText>
      {props.description ? (
        <NshText
          class={`text-center ${BODY.body} text-muted-foreground text-pretty`}
        >
          {props.description}
        </NshText>
      ) : null}
      {props.action || props.secondaryAction ? (
        <View class="flex-row flex-wrap justify-center gap-2 pt-1">
          {props.secondaryAction ? (
            <Button
              label={props.secondaryAction.label}
              icon={props.secondaryAction.icon}
              kind="subtle"
              disabled={props.secondaryAction.disabled}
              onPress={props.secondaryAction.onPress}
            />
          ) : null}
          {props.action ? (
            <Button
              label={props.action.label}
              icon={props.action.icon}
              kind="primary"
              disabled={props.action.disabled}
              onPress={props.action.onPress}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export type SkeletonProps = {
  /** `text` lines (default), a `circle` such as an avatar, or a `block`
   * such as an image or a card. */
  shape?: 'text' | 'circle' | 'block';
  /** Lines of text; default 3. The last is shorter. */
  lines?: 1 | 2 | 3 | 4 | 5;
};

const PULSE = 'animate-pulse motion-reduce:animate-none bg-surface-hover';

/** A placeholder in the shape of content that is loading. */
export function Skeleton(props: SkeletonProps): JSX.Element {
  const shape = () => props.shape ?? 'text';
  if (shape() === 'circle') {
    return (
      <View
        accessibilityLabel="Loading"
        class={`size-10 rounded-full ${PULSE}`}
      />
    );
  }
  if (shape() === 'block') {
    return (
      <View
        accessibilityLabel="Loading"
        class={`h-32 self-stretch rounded-(--radius-lg) ${PULSE}`}
      />
    );
  }
  const lines = () =>
    Array.from({ length: props.lines ?? 3 }, (_, index) => index);
  return (
    <View accessibilityLabel="Loading" class="self-stretch gap-2.5">
      <Each of={lines()} key="index">
        {(index) => (
          <View
            class={`h-3 rounded-full ${PULSE} ${index() === lines().length - 1 && lines().length > 1 ? 'w-3/5' : 'self-stretch'}`}
          />
        )}
      </Each>
    </View>
  );
}
