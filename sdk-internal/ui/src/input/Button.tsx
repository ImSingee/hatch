import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { FOCUS_RING } from '../core/styles';
import type { ControlSize, IconData } from '../core/types';
import { Spinner } from '../display/Spinner';
import { TooltipBubble } from '../feedback/Tooltip';
import { byLook, look, touch } from '../core/env';
import {
  BarActionsContext,
  InOverlayContext,
  StackedActionsContext,
} from '../core/overlay';
import { Glyph } from '../icons/Icon';
import type { GlyphColor, IconSize } from '../icons/Icon';
import { SurfaceContext } from '../core/surface';
import type { Surface } from '../core/surface';
import { FormContext } from './form-context';

/**
 * `primary` for the one main action of a view; `default` for others;
 * `tint` for a secondary action that should still read as the accent;
 * `subtle` for low-emphasis actions in toolbars and rows; `danger` for
 * destructive actions.
 */
export type ButtonKind = 'primary' | 'default' | 'tint' | 'subtle' | 'danger';

const KIND: Record<ButtonKind, string> = {
  primary:
    'bg-primary hover:bg-primary-pressed active:bg-primary-pressed active:translate-y-px',
  default:
    'border border-hairline bg-card hover:bg-surface-hover active:bg-surface-pressed',
  tint: 'bg-primary-tint hover:bg-primary-tint-hover active:bg-primary-tint-hover',
  subtle: 'hover:bg-surface-hover active:bg-surface-pressed',
  danger:
    'bg-danger hover:bg-danger-pressed active:bg-danger-pressed active:translate-y-px',
};

const LABEL_COLOR: Record<ButtonKind, string> = {
  primary: 'text-primary-foreground',
  default: 'text-foreground',
  tint: 'text-primary-tint-foreground',
  subtle: 'text-foreground',
  danger: 'text-destructive-foreground',
};

const GLYPH_COLOR: Record<ButtonKind, GlyphColor> = {
  primary: 'primary-foreground',
  default: 'foreground',
  tint: 'primary-tint-foreground',
  subtle: 'foreground',
  danger: 'destructive-foreground',
};

/** DESIGN.md "Button"; touch screens get 44-point targets. */
const SIZE: Record<ControlSize, string> = {
  sm: 'h-7.5 px-3 pointer-coarse:h-9',
  md: 'h-9 px-4 pointer-coarse:h-11',
  lg: 'h-11.5 px-5 pointer-coarse:h-12.5',
};

const INNER_GAP: Record<ControlSize, string> = {
  sm: 'gap-1.5',
  md: 'gap-2',
  lg: 'gap-2',
};

const SQUARE: Record<ControlSize, string> = {
  sm: 'size-7.5 pointer-coarse:size-9',
  md: 'size-9 pointer-coarse:size-11',
  lg: 'size-11.5 pointer-coarse:size-12.5',
};

const LABEL: Record<ControlSize, string> = {
  sm: 'text-control-sm font-label',
  md: 'text-body font-label pointer-coarse:text-control',
  lg: 'text-control font-heading',
};

const ICON: Record<ControlSize, IconSize> = { sm: 'sm', md: 'md', lg: 'lg' };

/** Icon buttons on iOS and Android draw 20- and 24-point icons. */
const PLATFORM_ICON: Record<ControlSize, IconSize> = {
  sm: 'lg',
  md: '2xl',
  lg: '2xl',
};

const BASE = `flex-row items-center justify-center rounded-(--radius-md) transition-colors disabled:opacity-50 ${FOCUS_RING}`;

/**
 * iOS: filled, tinted and gray buttons with rounded corners, plain ones in
 * the accent; a press darkens or dims them. 34, 44 and 50 points tall;
 * `sm` is a capsule.
 */
const IOS_KIND: Record<ButtonKind, string> = {
  primary: 'bg-primary active:bg-primary-pressed',
  // The gray fill: the page's ground on a card, a card on the ground
  // (`iosDefaultFill`); both are fills the theme validation checks.
  default: 'active:opacity-60',
  tint: 'bg-primary-tint active:bg-primary-tint-hover',
  subtle: 'active:opacity-50',
  danger: 'bg-danger active:bg-danger-pressed',
};

const IOS_LABEL_COLOR: Record<ButtonKind, string> = {
  ...LABEL_COLOR,
  subtle: 'text-primary-strong',
};

const IOS_GLYPH_COLOR: Record<ButtonKind, GlyphColor> = {
  ...GLYPH_COLOR,
  subtle: 'primary-strong',
};

const IOS_SIZE: Record<ControlSize, string> = {
  sm: 'h-8.5 rounded-full px-4',
  md: 'h-11 px-5',
  lg: 'h-12.5 px-6',
};

const IOS_SQUARE: Record<ControlSize, string> = {
  sm: 'size-8.5 rounded-full',
  md: 'size-11',
  lg: 'size-12.5',
};

const IOS_LABEL: Record<ControlSize, string> = {
  sm: 'text-ios-subhead font-semibold',
  md: 'text-ios-body font-semibold',
  lg: 'text-ios-body font-semibold',
};

/**
 * Android (Material 3): pill-shaped filled, outlined, tonal and text
 * buttons, 40, 48 and 56 points tall; a press lays the state colour over
 * them. Icon buttons are circles.
 */
const ANDROID_KIND: Record<ButtonKind, string> = {
  primary: 'bg-primary active:bg-primary-pressed',
  default: 'border border-control-border active:bg-surface-pressed',
  tint: 'bg-primary-tint active:bg-primary-tint-hover',
  subtle: 'active:bg-surface-pressed',
  danger: 'bg-danger active:bg-danger-pressed',
};

const ANDROID_LABEL_COLOR: Record<ButtonKind, string> = {
  ...LABEL_COLOR,
  default: 'text-primary-strong',
  subtle: 'text-primary-strong',
};

const ANDROID_GLYPH_COLOR: Record<ButtonKind, GlyphColor> = {
  ...GLYPH_COLOR,
  default: 'primary-strong',
  subtle: 'primary-strong',
};

const ANDROID_SIZE: Record<ControlSize, string> = {
  sm: 'h-10 px-4',
  md: 'h-12 px-6',
  lg: 'h-14 px-8',
};

const ANDROID_SQUARE: Record<ControlSize, string> = {
  sm: 'size-10',
  md: 'size-12',
  lg: 'size-14',
};

const ANDROID_LABEL: Record<ControlSize, string> = {
  sm: 'text-m3-label-lg font-medium',
  md: 'text-m3-label-lg font-medium',
  lg: 'text-m3-title-md font-medium',
};

/** A button's classes on the App's look. */
const STYLE = byLook({
  web: {
    base: BASE,
    kind: KIND,
    size: SIZE,
    square: SQUARE,
    label: LABEL,
    labelColor: LABEL_COLOR,
    glyphColor: GLYPH_COLOR,
    iconKind: KIND,
    iconGlyph: GLYPH_COLOR,
  },
  ios: {
    base: `flex-row items-center justify-center rounded-(--radius-md) transition-opacity disabled:opacity-40 ${FOCUS_RING}`,
    kind: IOS_KIND,
    size: IOS_SIZE,
    square: IOS_SQUARE,
    label: IOS_LABEL,
    labelColor: IOS_LABEL_COLOR,
    glyphColor: IOS_GLYPH_COLOR,
    // Bar and row icons are plain, in the accent.
    iconKind: IOS_KIND,
    iconGlyph: IOS_GLYPH_COLOR,
  },
  android: {
    base: `flex-row items-center justify-center rounded-full transition-colors disabled:opacity-40 ${FOCUS_RING}`,
    kind: ANDROID_KIND,
    size: ANDROID_SIZE,
    square: ANDROID_SQUARE,
    label: ANDROID_LABEL,
    labelColor: ANDROID_LABEL_COLOR,
    glyphColor: ANDROID_GLYPH_COLOR,
    // Icon buttons keep the content colour; the accent marks actions.
    iconKind: { ...ANDROID_KIND, subtle: 'active:bg-surface-pressed' },
    iconGlyph: { ...ANDROID_GLYPH_COLOR, subtle: 'foreground' as GlyphColor },
  },
});

export type ButtonProps = {
  /** The button's text, in sentence case: a verb for what it does. */
  label: string;
  kind?: ButtonKind;
  /** `sm` 30, `md` 36 (default), `lg` 46 points tall; taller on touch. */
  size?: ControlSize;
  /** An icon before the label. */
  icon?: IconData;
  /** An icon after the label, such as a chevron for a menu. */
  iconEnd?: IconData;
  /** Shows a spinner in place of the label and ignores presses. */
  loading?: boolean;
  disabled?: boolean;
  /** Fills the width of its container. */
  fullWidth?: boolean;
  /** `submit` submits the `Form` the button is in. */
  type?: 'button' | 'submit';
  onPress?: () => void;
};

/** A button in a page's bar on iOS and Android: iOS's plain bar button,
 * Material's action icon or text button. */
function BarButton(props: ButtonProps): JSX.Element {
  const form = FormContext();
  const ios = look === 'ios';
  const busy = () =>
    props.loading === true ||
    (props.type === 'submit' && form !== null && form.submitting());
  const press = () => {
    if (busy()) return;
    if (props.type === 'submit' && form) form.submit();
    props.onPress?.();
  };
  const tone = (): GlyphColor =>
    props.kind === 'danger' ? 'danger-strong' : 'primary-strong';
  const textTone = () =>
    props.kind === 'danger' ? 'text-danger-strong' : 'text-primary-strong';
  const icon = props.icon;
  return (
    <BaseButton
      onPress={press}
      disabled={
        props.disabled === true ||
        (props.type === 'submit' && form !== null && form.disabled())
      }
      accessibilityLabel={busy() ? `${props.label}, working` : props.label}
      class={[
        'flex-row items-center justify-center disabled:opacity-40',
        ios
          ? 'h-11 min-w-11 rounded-(--radius-md) px-2 active:opacity-50'
          : icon
            ? 'size-12 rounded-full active:bg-surface-pressed'
            : 'h-10 rounded-full px-3 active:bg-surface-pressed',
        FOCUS_RING,
      ].join(' ')}
    >
      {busy() ? (
        <Spinner size="lg" color={tone()} />
      ) : icon ? (
        <Glyph
          icon={icon}
          size="2xl"
          color={ios || props.kind === 'danger' ? tone() : 'foreground'}
        />
      ) : (
        <Text
          class={
            ios
              ? `text-ios-body ${props.kind === 'primary' || props.type === 'submit' ? 'font-semibold' : 'font-regular'} ${textTone()}`
              : `text-m3-label-lg font-medium ${textTone()}`
          }
        >
          {props.label}
        </Text>
      )}
    </BaseButton>
  );
}

/** iOS's gray button on the fill it sits on. */
function iosDefaultFill(surface: Surface): string {
  return surface === 'card' ? 'bg-background' : 'bg-card';
}

/** A button that runs an action of the App. */
export function Button(props: ButtonProps): JSX.Element {
  if (BarActionsContext()) return <BarButton {...props} />;
  const form = FormContext();
  const surface = SurfaceContext();
  const stacked = StackedActionsContext();
  const kind = () =>
    props.kind ?? (props.type === 'submit' ? 'primary' : 'default');
  const size = () => props.size ?? (stacked ? 'lg' : 'md');
  const fullWidth = () => props.fullWidth === true || stacked;
  const busy = () =>
    props.loading === true ||
    (props.type === 'submit' && form !== null && form.submitting());
  const press = () => {
    if (busy()) return;
    if (props.type === 'submit' && form) form.submit();
    props.onPress?.();
  };
  return (
    <View class={fullWidth() ? 'flex-row self-stretch' : 'flex-row'}>
      <BaseButton
        onPress={press}
        disabled={
          props.disabled === true ||
          (props.type === 'submit' && form !== null && form.disabled())
        }
        accessibilityLabel={busy() ? `${props.label}, working` : props.label}
        class={[
          STYLE.base,
          look === 'ios' && kind() === 'default'
            ? `${STYLE.kind[kind()]} ${iosDefaultFill(surface)}`
            : STYLE.kind[kind()],
          STYLE.size[size()],
          fullWidth() ? 'flex-1' : '',
        ].join(' ')}
      >
        <View
          class={`flex-row items-center justify-center ${INNER_GAP[size()]}`}
          classList={{ invisible: busy() }}
        >
          {props.icon ? (
            <Glyph
              icon={props.icon}
              size={ICON[size()]}
              color={STYLE.glyphColor[kind()]}
            />
          ) : null}
          <Text
            class={`${STYLE.label[size()]} ${STYLE.labelColor[kind()]} truncate`}
          >
            {props.label}
          </Text>
          {props.iconEnd ? (
            <Glyph
              icon={props.iconEnd}
              size={ICON[size()]}
              color={STYLE.glyphColor[kind()]}
            />
          ) : null}
        </View>
        {busy() ? (
          <View class="absolute inset-0 items-center justify-center">
            <Spinner size={ICON[size()]} color={STYLE.glyphColor[kind()]} />
          </View>
        ) : null}
      </BaseButton>
    </View>
  );
}

export type IconButtonProps = {
  icon: IconData;
  /** What the button does. Screen readers read it, and desktops show it as
   * a tooltip. */
  label: string;
  /** Default `subtle`. */
  kind?: ButtonKind;
  size?: ControlSize;
  disabled?: boolean;
  /** A toggle that is on (a pressed state for screen readers). */
  selected?: boolean;
  onPress?: () => void;
};

/** A square button with an icon only. */
export function IconButton(props: IconButtonProps): JSX.Element {
  const inOverlay = InOverlayContext();
  const surface = SurfaceContext();
  const kind = () => props.kind ?? 'subtle';
  const size = () => props.size ?? 'md';
  return (
    <BaseButton
      onPress={props.onPress}
      disabled={props.disabled}
      selected={props.selected}
      accessibilityLabel={props.label}
      tooltip={
        touch || inOverlay ? undefined : <TooltipBubble label={props.label} />
      }
      class={[
        STYLE.base,
        props.selected
          ? 'bg-primary-tint'
          : look === 'ios' && kind() === 'default'
            ? `${STYLE.iconKind[kind()]} ${iosDefaultFill(surface)}`
            : STYLE.iconKind[kind()],
        STYLE.square[size()],
      ].join(' ')}
    >
      <Glyph
        icon={props.icon}
        size={look === 'web' ? ICON[size()] : PLATFORM_ICON[size()]}
        color={
          props.selected ? 'primary-tint-foreground' : STYLE.iconGlyph[kind()]
        }
      />
    </BaseButton>
  );
}
