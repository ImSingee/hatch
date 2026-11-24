import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Menu as BaseMenu, MenuItem, MenuSeparator } from 'nsh/base';
import { Each } from '../core/control';
import { touch } from '../core/env';
import {
  BACKDROP,
  FOCUS_RING,
  POPUP,
  POPUP_ENDING,
  POPUP_ITEM,
  POPUP_STARTING,
} from '../core/styles';
import type { IconData } from '../core/types';
import { Glyph } from '../icons/Icon';
import { IconCheck, IconChevronDown, IconDots } from '../icons/icons.gen';
import { TooltipBubble } from './Tooltip';

/** One entry of a `Menu`. */
export type MenuEntry =
  | {
      label: string;
      onSelect: () => void;
      icon?: IconData;
      /** Draws the item in red: for deleting and leaving. */
      destructive?: boolean;
      disabled?: boolean;
      /** A check mark: the item is an option that is on. */
      checked?: boolean;
    }
  | 'separator';

export type MenuProps = {
  /** What the menu holds, as the trigger's name: "More actions", "Sort". */
  label: string;
  items: readonly MenuEntry[];
  /** `icon` (default) shows an icon button; `button` a button with the
   * label and a chevron. */
  trigger?: 'icon' | 'button';
  /** The trigger's icon; default three dots. */
  icon?: IconData;
};

const ICON_TRIGGER = `size-9 items-center justify-center rounded-(--radius-md) hover:bg-surface-hover aria-expanded:bg-surface-pressed pointer-coarse:size-11 ${FOCUS_RING}`;
const BUTTON_TRIGGER = `h-9 flex-row items-center gap-2 rounded-(--radius-md) border border-hairline bg-card px-4 hover:bg-surface-hover aria-expanded:bg-surface-pressed pointer-coarse:h-11 ${FOCUS_RING}`;

/**
 * Actions behind a button: a popup on desktops, a sheet on phones. Use it
 * for secondary actions; keep the main action of a view on a visible button.
 */
export function Menu(props: MenuProps): JSX.Element {
  const asButton = () => props.trigger === 'button';
  return (
    <BaseMenu
      offset={4}
      popupClass={`${POPUP} min-w-48`}
      popupStartingClass={POPUP_STARTING}
      popupEndingClass={POPUP_ENDING}
      backdropClass={BACKDROP}
      trigger={
        asButton() ? (
          <View class={BUTTON_TRIGGER} accessibilityLabel={props.label}>
            {props.icon ? (
              <Glyph icon={props.icon} size="md" color="foreground" />
            ) : null}
            <Text class="text-body font-label text-foreground">
              {props.label}
            </Text>
            <Glyph icon={IconChevronDown} size="md" color="foreground" />
          </View>
        ) : (
          <View
            class={ICON_TRIGGER}
            accessibilityLabel={props.label}
            tooltip={touch ? undefined : <TooltipBubble label={props.label} />}
          >
            <Glyph icon={props.icon ?? IconDots} size="md" color="foreground" />
          </View>
        )
      }
    >
      <Each of={props.items}>
        {(entry) => {
          const item = entry();
          if (item === 'separator') {
            return <MenuSeparator class="mx-1 my-1 h-px bg-hairline" />;
          }
          return (
            <MenuItem
              onSelect={item.onSelect}
              disabled={item.disabled}
              checked={item.checked ?? null}
              accessibilityLabel={item.label}
              class={POPUP_ITEM}
            >
              {item.icon ? (
                <Glyph
                  icon={item.icon}
                  size="md"
                  color={
                    item.destructive ? 'danger-strong' : 'muted-foreground'
                  }
                />
              ) : null}
              <Text
                class={`flex-1 text-body font-strong ${item.destructive ? 'text-danger-strong' : 'text-popover-foreground'}`}
              >
                {item.label}
              </Text>
              {item.checked ? (
                <Glyph icon={IconCheck} size="md" color="primary-strong" />
              ) : null}
            </MenuItem>
          );
        }}
      </Each>
    </BaseMenu>
  );
}
