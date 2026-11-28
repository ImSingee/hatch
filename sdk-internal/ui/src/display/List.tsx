import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { Each, If } from '../core/control';
import { byLook, look, mobileLook } from '../core/env';
import { SurfaceContext } from '../core/surface';
import { FOCUS_RING_INSET } from '../core/styles';
import type { Action, IconData } from '../core/types';
import { Glyph } from '../icons/Icon';
import { IconChevronRight } from '../icons/icons.gen';
import { IconButton } from '../input/Button';
import { Avatar, Badge, Skeleton } from './Display';
import type { BadgeProps } from './Display';

export type ListProps<T> = {
  /** A short label above the list, written in sentence case; it shows as
   * a small uppercase group label. */
  title?: string;
  /** The items, with `renderItem`; or pass `ListItem`s as children. */
  items?: readonly T[];
  /** One `ListItem` per item; `item()` follows the row. */
  renderItem?: (item: () => T) => JSX.Element;
  /** Keeps rows by an id of each item; default the item itself. */
  getKey?: (item: T) => string;
  /** Rows as children, when there is no `items`. */
  children?: JSX.Element;
  /** The line shown when `items` is empty. */
  empty?: string;
  /** Shows placeholder rows while the items load. */
  loading?: boolean;
};

/**
 * The list's frame on each look: the Desk's sheet with hairlines, iOS's
 * inset grouped list (no edge, separators inset to the text), Material's
 * flat list on the page's ground; on the desktops the Desk's sheet with the
 * platform's corner.
 */
const FRAME = byLook({
  web: {
    title:
      'px-1 text-eyebrow font-heading uppercase tracking-eyebrow text-muted-foreground',
    sheet:
      'self-stretch overflow-hidden rounded-(--radius-lg) border border-hairline bg-card',
    rows: '',
    empty: 'text-center text-body text-muted-foreground',
  },
  ios: {
    title: 'px-4 text-ios-footnote font-regular text-muted-foreground',
    sheet: 'self-stretch overflow-hidden rounded-(--radius-md) bg-card',
    // Each row draws the separator under it; the sheet clips the last.
    rows: 'self-stretch -mb-px',
    empty: 'text-center text-ios-body font-regular text-muted-foreground',
  },
  android: {
    title: 'text-m3-title-sm font-medium text-muted-foreground',
    sheet: 'self-stretch',
    rows: '',
    empty: 'text-center text-m3-body-lg font-regular text-muted-foreground',
  },
  macos: {
    title: 'px-1 text-mac-body font-semibold text-muted-foreground',
    sheet:
      'self-stretch overflow-hidden rounded-(--radius-md) border border-hairline bg-card',
    rows: '',
    empty: 'text-center text-mac-body font-regular text-muted-foreground',
  },
  windows: {
    title: 'px-1 text-win-body font-semibold text-foreground',
    sheet:
      'self-stretch overflow-hidden rounded-(--radius-sm) border border-hairline bg-card',
    rows: '',
    empty: 'text-center text-win-body font-regular text-muted-foreground',
  },
});

/** Rows of related items on one sheet, divided by hairlines. */
export function List<T>(props: ListProps<T>): JSX.Element {
  const empty = () =>
    !props.loading && props.items !== undefined && props.items.length === 0;
  // `If` on booleans, not ternaries over `items`: a ternary would rebuild
  // every row (losing focus and row state) whenever the App passes a new
  // array; `Each` keeps the rows by key instead.
  const rows = () => (
    <If
      when={props.loading === true}
      else={
        <If
          when={empty()}
          else={
            <If
              when={props.items !== undefined && props.renderItem !== undefined}
              else={props.children}
            >
              <Each of={props.items} key={props.getKey}>
                {(item) => props.renderItem?.(item)}
              </Each>
            </If>
          }
        >
          <View class="items-center px-4 py-6">
            <Text class={FRAME.empty}>
              {props.empty ?? 'Nothing here yet.'}
            </Text>
          </View>
        </If>
      }
    >
      <View class="gap-4 p-4">
        <Skeleton lines={2} />
        <Skeleton lines={2} />
      </View>
    </If>
  );
  return (
    <View class="self-stretch gap-2">
      {props.title ? <Text class={FRAME.title}>{props.title}</Text> : null}
      <View
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- NSH has no list element; the role is its list.
        role="list"
        accessibilityLabel={props.title}
        class={FRAME.sheet}
      >
        {/* The rows are made here, inside the surface they sit on: on iOS
            the list's own card, so their controls take the opposite fill. */}
        {look === 'ios' ? (
          <SurfaceContext.Provider value="card">
            <View class={FRAME.rows}>{rows()}</View>
          </SurfaceContext.Provider>
        ) : (
          rows()
        )}
      </View>
    </View>
  );
}

export type ListItemProps = {
  title: string;
  /** One meta line under the title. */
  description?: string;
  /** A 34-point tile with this icon at the start. */
  icon?: IconData;
  /** An avatar at the start, for people. */
  avatar?: { name: string; src?: string };
  /** A value at the end: "6 plants", "Tomorrow". */
  value?: string;
  /** A status chip at the end. */
  badge?: BadgeProps;
  /** A control at the end, such as a `Switch` without its own label row. */
  control?: JSX.Element;
  /** Makes the row open something; it gets a chevron. */
  onPress?: () => void;
  /** The current item of a navigation list. */
  selected?: boolean;
  disabled?: boolean;
  /** Icon actions at the end: shown on hover and keyboard focus with a
   * pointer, always on touch screens. */
  actions?: readonly Action[];
};

/** One row of a `List` (DESIGN.md "List row"). */
export function ListItem(props: ListItemProps): JSX.Element {
  if (mobileLook) return <PlatformListItem {...props} />;
  const style = DESK_ROW;
  // The selected row is tinted with the accent, or on Windows marked by
  // the accent line at its start on a neutral fill.
  const tinted = () => props.selected === true && style.selectedTint;
  const body = (
    <>
      {props.icon ? (
        <View
          class={`${style.tile} ${props.selected ? 'bg-card' : 'bg-muted'}`}
        >
          <Glyph
            icon={props.icon}
            size="lg"
            color={tinted() ? 'primary-tint-foreground' : 'foreground'}
          />
        </View>
      ) : null}
      {props.avatar ? (
        <Avatar name={props.avatar.name} src={props.avatar.src} size="md" />
      ) : null}
      <View class={style.text}>
        <Text
          class={`${style.title} truncate ${tinted() ? 'text-primary-tint-foreground' : 'text-foreground'}`}
        >
          {props.title}
        </Text>
        {props.description ? (
          <Text class={`${style.description} text-muted-foreground truncate`}>
            {props.description}
          </Text>
        ) : null}
      </View>
      {props.value ? (
        <Text class={`${style.value} text-muted-foreground`}>
          {props.value}
        </Text>
      ) : null}
      {props.badge ? <Badge {...props.badge} /> : null}
      {props.onPress ? (
        <Glyph icon={IconChevronRight} size="md" color="muted-foreground" />
      ) : null}
    </>
  );
  const rowClass = () => `${style.row} ${props.selected ? style.selected : ''}`;
  return (
    <View
      class="group flex-row items-center border-t border-hairline first:border-t-0 focus-within:bg-surface-hover"
      classList={{ 'opacity-50': props.disabled === true }}
    >
      {props.selected && !style.selectedTint ? (
        <View
          class="pointer-events-none absolute inset-y-0 left-0 justify-center"
          importantForAccessibility="no-hide-descendants"
        >
          <View class="h-4 w-0.75 rounded-full bg-primary" />
        </View>
      ) : null}
      {props.onPress ? (
        <BaseButton
          onPress={props.onPress}
          disabled={props.disabled}
          selected={props.selected}
          accessibilityLabel={
            props.description
              ? `${props.title}, ${props.description}`
              : props.title
          }
          class={`${rowClass()} ${props.selected ? '' : style.press} ${FOCUS_RING_INSET}`}
        >
          {body}
        </BaseButton>
      ) : (
        <View class={rowClass()}>{body}</View>
      )}
      {props.control ? <View class="pr-4">{props.control}</View> : null}
      {/* `If` on a boolean: a ternary reading `actions` would rebuild the
          buttons, and lose the focused one, when the App passes a new list. */}
      <If when={(props.actions?.length ?? 0) > 0}>
        <View class="flex-row gap-0.5 pr-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
          <Each of={props.actions}>
            {(action) => (
              <IconButton
                icon={action().icon ?? IconChevronRight}
                label={action().label}
                size="sm"
                disabled={props.disabled === true || action().disabled}
                onPress={action().onPress}
              />
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

type DeskRow = {
  tile: string;
  text: string;
  title: string;
  description: string;
  value: string;
  row: string;
  press: string;
  selected: string;
  /** The selection tints the row with the accent. */
  selectedTint: boolean;
};

/** A row's classes on the web and the desktops: the Desk's 46-point row;
 * macOS's 40-point row, which a pointer does not highlight; Fluent's list
 * item, whose selection is a neutral fill with the accent line. */
const DESK_ROW = byLook<DeskRow | null>({
  web: {
    tile: 'size-8.5 items-center justify-center rounded-(--radius-md)',
    text: 'flex-1 gap-0.5 py-2',
    title: 'text-body font-label',
    description: 'text-caption',
    value: 'text-body',
    row: 'min-h-11.5 flex-1 flex-row items-center gap-3 px-4 pointer-coarse:min-h-13',
    press: 'hover:bg-surface-hover active:bg-surface-pressed',
    selected: 'bg-primary-tint',
    selectedTint: true,
  },
  ios: null,
  android: null,
  macos: {
    tile: 'size-7 items-center justify-center rounded-(--radius-xs)',
    text: 'flex-1 gap-0.5 py-1.5',
    title: 'text-mac-body font-medium',
    description: 'text-mac-callout font-regular',
    value: 'text-mac-body font-regular',
    row: 'min-h-10 flex-1 flex-row items-center gap-2.5 px-3',
    press: 'active:bg-surface-pressed',
    selected: 'bg-primary-tint',
    selectedTint: true,
  },
  windows: {
    tile: 'size-8 items-center justify-center rounded-(--radius-xs)',
    text: 'flex-1 gap-0.5 py-2',
    title: 'text-win-body font-regular',
    description: 'text-win-caption font-regular',
    value: 'text-win-body font-regular',
    row: 'min-h-10 flex-1 flex-row items-center gap-3 px-4',
    press: 'hover:bg-surface-hover active:bg-surface-pressed',
    selected: 'bg-surface-hover',
    selectedTint: false,
  },
  // iOS and Android draw `PlatformListItem` instead.
}) as DeskRow;

/** A row's classes on iOS and Android. */
const ROW = byLook({
  web: null,
  ios: {
    row: 'group flex-row items-stretch',
    content: 'flex-1 flex-row items-center gap-3 pl-4',
    press: 'active:bg-surface-pressed',
    tile: 'size-7.5 items-center justify-center rounded-(--radius-sm)',
    // The separator starts at the text, as iOS's do.
    body: 'min-h-11 flex-1 flex-row items-center gap-2 self-stretch border-b border-hairline pr-4',
    text: 'flex-1 gap-0.5 py-2.5',
    title: 'text-ios-body font-regular',
    description: 'text-ios-footnote font-regular text-muted-foreground',
    value: 'text-ios-body font-regular text-muted-foreground',
    chevron: true,
  },
  android: {
    row: 'group flex-row items-stretch',
    content: 'flex-1 flex-row items-center gap-4 rounded-(--radius-md)',
    press: 'active:bg-surface-pressed',
    tile: 'size-10 items-center justify-center rounded-(--radius-md)',
    body: 'min-h-14 flex-1 flex-row items-center gap-4 self-stretch',
    text: 'flex-1 gap-0.5 py-2',
    title: 'text-m3-body-lg font-regular',
    description: 'text-m3-body-md font-regular text-muted-foreground',
    value: 'text-m3-body-md font-regular text-muted-foreground',
    chevron: false,
  },
  macos: null,
  windows: null,
});

/** `ListItem` on iOS and Android. */
function PlatformListItem(props: ListItemProps): JSX.Element {
  const style = ROW as NonNullable<typeof ROW>;
  // A control and actions stay out of the row's own button.
  const trailing = (
    <>
      {props.control ? <View>{props.control}</View> : null}
      <If when={(props.actions?.length ?? 0) > 0}>
        <View class="flex-row gap-0.5">
          <Each of={props.actions}>
            {(action) => (
              <IconButton
                icon={action().icon ?? IconChevronRight}
                label={action().label}
                size="sm"
                disabled={props.disabled === true || action().disabled}
                onPress={action().onPress}
              />
            )}
          </Each>
        </View>
      </If>
    </>
  );
  const content = (
    <>
      {props.icon ? (
        <View
          class={`${style.tile} ${props.selected ? 'bg-card' : 'bg-muted'}`}
        >
          <Glyph
            icon={props.icon}
            size="lg"
            color={props.selected ? 'primary-tint-foreground' : 'foreground'}
          />
        </View>
      ) : null}
      {props.avatar ? (
        <Avatar name={props.avatar.name} src={props.avatar.src} size="md" />
      ) : null}
      <View class={style.body}>
        <View class={style.text}>
          <Text
            class={`${style.title} truncate ${props.selected ? 'text-primary-tint-foreground' : 'text-foreground'}`}
          >
            {props.title}
          </Text>
          {props.description ? (
            <Text class={`${style.description} truncate`}>
              {props.description}
            </Text>
          ) : null}
        </View>
        {props.value ? <Text class={style.value}>{props.value}</Text> : null}
        {props.badge ? <Badge {...props.badge} /> : null}
        {props.onPress && style.chevron ? (
          <Glyph icon={IconChevronRight} size="md" color="muted-foreground" />
        ) : null}
        {props.onPress ? null : trailing}
      </View>
    </>
  );
  return (
    <View
      class={`${style.row} ${props.selected ? 'bg-primary-tint' : ''}`}
      classList={{ 'opacity-50': props.disabled === true }}
    >
      {props.onPress ? (
        <>
          <BaseButton
            onPress={props.onPress}
            disabled={props.disabled}
            selected={props.selected}
            accessibilityLabel={
              props.description
                ? `${props.title}, ${props.description}`
                : props.title
            }
            class={`${style.content} ${props.selected ? '' : style.press} ${FOCUS_RING_INSET}`}
          >
            {content}
          </BaseButton>
          {props.control || (props.actions?.length ?? 0) > 0 ? (
            <View class="flex-row items-center pr-2">{trailing}</View>
          ) : null}
        </>
      ) : (
        <View class={style.content}>{content}</View>
      )}
    </View>
  );
}
