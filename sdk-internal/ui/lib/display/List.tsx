import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { Each } from '../core/control';
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

/** Rows of related items on one sheet, divided by hairlines. */
export function List<T>(props: ListProps<T>): JSX.Element {
  const empty = () =>
    !props.loading && props.items !== undefined && props.items.length === 0;
  return (
    <View class="self-stretch gap-2">
      {props.title ? (
        <Text class="px-1 text-eyebrow font-heading uppercase tracking-eyebrow text-muted-foreground">
          {props.title}
        </Text>
      ) : null}
      <View
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- NSH has no list element; the role is its list.
        role="list"
        accessibilityLabel={props.title}
        class="self-stretch overflow-hidden rounded-(--radius-lg) border border-hairline bg-card"
      >
        {props.loading ? (
          <View class="gap-4 p-4">
            <Skeleton lines={2} />
            <Skeleton lines={2} />
          </View>
        ) : empty() ? (
          <View class="items-center px-4 py-6">
            <Text class="text-center text-body text-muted-foreground">
              {props.empty ?? 'Nothing here yet.'}
            </Text>
          </View>
        ) : props.items && props.renderItem ? (
          <Each of={props.items} key={props.getKey}>
            {(item) => props.renderItem?.(item)}
          </Each>
        ) : (
          props.children
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
  const body = (
    <>
      {props.icon ? (
        <View
          class={`size-8.5 items-center justify-center rounded-(--radius-md) ${props.selected ? 'bg-card' : 'bg-muted'}`}
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
      <View class="flex-1 gap-0.5 py-2">
        <Text
          class={`text-body font-label truncate ${props.selected ? 'text-primary-tint-foreground' : 'text-foreground'}`}
        >
          {props.title}
        </Text>
        {props.description ? (
          <Text class="text-caption text-muted-foreground truncate">
            {props.description}
          </Text>
        ) : null}
      </View>
      {props.value ? (
        <Text class="text-body text-muted-foreground">{props.value}</Text>
      ) : null}
      {props.badge ? <Badge {...props.badge} /> : null}
      {props.onPress ? (
        <Glyph icon={IconChevronRight} size="md" color="muted-foreground" />
      ) : null}
    </>
  );
  const rowClass = () =>
    `min-h-11.5 flex-1 flex-row items-center gap-3 px-4 pointer-coarse:min-h-13 ${props.selected ? 'bg-primary-tint' : ''}`;
  return (
    <View
      class="group flex-row items-center border-t border-hairline first:border-t-0 focus-within:bg-surface-hover"
      classList={{ 'opacity-50': props.disabled === true }}
    >
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
          class={`${rowClass()} ${props.selected ? '' : 'hover:bg-surface-hover active:bg-surface-pressed'} ${FOCUS_RING_INSET}`}
        >
          {body}
        </BaseButton>
      ) : (
        <View class={rowClass()}>{body}</View>
      )}
      {props.control ? <View class="pr-4">{props.control}</View> : null}
      {props.actions && props.actions.length > 0 ? (
        <View class="flex-row gap-0.5 pr-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
          <Each of={props.actions}>
            {(action) => (
              <IconButton
                icon={action().icon ?? IconChevronRight}
                label={action().label}
                size="sm"
                disabled={action().disabled}
                onPress={action().onPress}
              />
            )}
          </Each>
        </View>
      ) : null}
    </View>
  );
}
