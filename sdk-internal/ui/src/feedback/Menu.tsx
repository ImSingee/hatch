import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Menu as BaseMenu, MenuItem, MenuSeparator } from 'nsh/base';
import { Each } from '../core/control';
import { byLook, look, mobileLook, touch } from '../core/env';
import {
  BACKDROP,
  FOCUS_RING,
  POPUP,
  POPUP_ENDING,
  POPUP_ITEM,
  POPUP_ITEM_TEXT,
  POPUP_STARTING,
} from '../core/styles';
import type { GlyphColor } from '../icons/Icon';
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

/** The triggers on each look: iOS's plain accent icon and gray button,
 * Android's 48-point circle and outlined pill, the desktops' pull-down
 * buttons (28 points on macOS, 32 on Windows). */
const TRIGGER = byLook({
  web: {
    icon: `size-9 items-center justify-center rounded-(--radius-md) hover:bg-surface-hover aria-expanded:bg-surface-pressed pointer-coarse:size-11 ${FOCUS_RING}`,
    button: `h-9 flex-row items-center gap-2 rounded-(--radius-md) border border-hairline bg-card px-4 hover:bg-surface-hover aria-expanded:bg-surface-pressed pointer-coarse:h-11 ${FOCUS_RING}`,
    label: 'text-body font-label text-foreground',
    glyph: 'foreground' as GlyphColor,
    buttonGlyph: 'foreground' as GlyphColor,
  },
  ios: {
    icon: `size-11 items-center justify-center rounded-full active:opacity-50 ${FOCUS_RING}`,
    button: `h-11 flex-row items-center gap-2 rounded-(--radius-md) bg-background px-4 active:opacity-60 ${FOCUS_RING}`,
    label: 'text-ios-body font-regular text-foreground',
    glyph: 'primary-strong' as GlyphColor,
    buttonGlyph: 'foreground' as GlyphColor,
  },
  android: {
    icon: `size-12 items-center justify-center rounded-full active:bg-surface-pressed aria-expanded:bg-surface-pressed ${FOCUS_RING}`,
    button: `h-10 flex-row items-center gap-2 rounded-full border border-control-border px-4 active:bg-surface-pressed ${FOCUS_RING}`,
    label: 'text-m3-label-lg font-medium text-foreground',
    glyph: 'foreground' as GlyphColor,
    buttonGlyph: 'foreground' as GlyphColor,
  },
  macos: {
    icon: `size-7 items-center justify-center rounded-(--radius-xs) hover:bg-surface-hover aria-expanded:bg-surface-pressed ${FOCUS_RING}`,
    button: `h-7 flex-row items-center gap-1.5 rounded-(--radius-xs) border border-hairline bg-card px-3 shadow-card hover:bg-surface-hover aria-expanded:bg-surface-pressed ${FOCUS_RING}`,
    label: 'text-mac-body font-semibold text-foreground',
    glyph: 'foreground' as GlyphColor,
    buttonGlyph: 'foreground' as GlyphColor,
  },
  windows: {
    icon: `size-8 items-center justify-center rounded-(--radius-xs) hover:bg-surface-hover aria-expanded:bg-surface-pressed ${FOCUS_RING}`,
    button: `h-8 flex-row items-center gap-2 rounded-(--radius-xs) border border-hairline border-b-control-border bg-card px-3 hover:bg-muted aria-expanded:bg-surface-pressed ${FOCUS_RING}`,
    label: 'text-win-label font-semibold text-foreground',
    glyph: 'foreground' as GlyphColor,
    buttonGlyph: 'foreground' as GlyphColor,
  },
});

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
          <View class={TRIGGER.button} accessibilityLabel={props.label}>
            {props.icon ? (
              <Glyph icon={props.icon} size="md" color={TRIGGER.buttonGlyph} />
            ) : null}
            <Text class={TRIGGER.label}>{props.label}</Text>
            <Glyph
              icon={IconChevronDown}
              size="md"
              color={TRIGGER.buttonGlyph}
            />
          </View>
        ) : (
          <View
            class={TRIGGER.icon}
            accessibilityLabel={props.label}
            tooltip={touch ? undefined : <TooltipBubble label={props.label} />}
          >
            <Glyph
              icon={props.icon ?? IconDots}
              size={mobileLook ? '2xl' : 'md'}
              color={TRIGGER.glyph}
            />
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
              {/* iOS puts a menu item's icon at its end. */}
              {item.icon && look !== 'ios' ? (
                <Glyph
                  icon={item.icon}
                  size="md"
                  color={
                    item.destructive ? 'danger-strong' : 'muted-foreground'
                  }
                />
              ) : null}
              <Text
                class={`flex-1 ${POPUP_ITEM_TEXT} ${item.destructive ? 'text-danger-strong' : 'text-popover-foreground'}`}
              >
                {item.label}
              </Text>
              {item.icon && look === 'ios' ? (
                <Glyph
                  icon={item.icon}
                  size="lg"
                  color={item.destructive ? 'danger-strong' : 'foreground'}
                />
              ) : null}
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
