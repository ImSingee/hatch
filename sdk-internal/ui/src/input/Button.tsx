import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { FOCUS_RING } from '../core/styles';
import type { ControlSize, IconData } from '../core/types';
import { Spinner } from '../display/Spinner';
import { TooltipBubble } from '../feedback/Tooltip';
import { touch } from '../core/env';
import { Glyph } from '../icons/Icon';
import type { GlyphColor, IconSize } from '../icons/Icon';
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
    'bg-primary hover:bg-primary-strong active:bg-primary-strong active:translate-y-px',
  default:
    'border border-hairline bg-card hover:bg-surface-hover active:bg-surface-pressed',
  tint: 'bg-primary-tint hover:bg-primary-tint-hover active:bg-primary-tint-hover',
  subtle: 'hover:bg-surface-hover active:bg-surface-pressed',
  danger:
    'bg-danger hover:bg-danger-strong active:bg-danger-strong active:translate-y-px',
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

const BASE = `flex-row items-center justify-center rounded-(--radius-md) transition-colors disabled:opacity-50 ${FOCUS_RING}`;

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
  /** Read by screen readers after the label, for a result that is not
   * obvious from it. */
  hint?: string;
  onPress?: () => void;
};

/** A button that runs an action of the App. */
export function Button(props: ButtonProps): JSX.Element {
  const form = FormContext();
  const kind = () =>
    props.kind ?? (props.type === 'submit' ? 'primary' : 'default');
  const size = () => props.size ?? 'md';
  const busy = () =>
    props.loading === true ||
    (props.type === 'submit' && form !== null && form.submitting());
  const press = () => {
    if (busy()) return;
    if (props.type === 'submit' && form) form.submit();
    props.onPress?.();
  };
  return (
    <View class={props.fullWidth ? 'flex-row self-stretch' : 'flex-row'}>
      <BaseButton
        onPress={press}
        disabled={
          props.disabled === true ||
          (props.type === 'submit' && form !== null && form.disabled())
        }
        accessibilityLabel={busy() ? `${props.label}, working` : props.label}
        class={[
          BASE,
          KIND[kind()],
          SIZE[size()],
          props.fullWidth ? 'flex-1' : '',
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
              color={GLYPH_COLOR[kind()]}
            />
          ) : null}
          <Text class={`${LABEL[size()]} ${LABEL_COLOR[kind()]} truncate`}>
            {props.label}
          </Text>
          {props.iconEnd ? (
            <Glyph
              icon={props.iconEnd}
              size={ICON[size()]}
              color={GLYPH_COLOR[kind()]}
            />
          ) : null}
        </View>
        {busy() ? (
          <View class="absolute inset-0 items-center justify-center">
            <Spinner size={ICON[size()]} color={GLYPH_COLOR[kind()]} />
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
  const kind = () => props.kind ?? 'subtle';
  const size = () => props.size ?? 'md';
  return (
    <BaseButton
      onPress={props.onPress}
      disabled={props.disabled}
      selected={props.selected}
      accessibilityLabel={props.label}
      tooltip={touch ? undefined : <TooltipBubble label={props.label} />}
      class={[
        BASE,
        props.selected ? 'bg-primary-tint' : KIND[kind()],
        SQUARE[size()],
      ].join(' ')}
    >
      <Glyph
        icon={props.icon}
        size={ICON[size()]}
        color={props.selected ? 'primary-tint-foreground' : GLYPH_COLOR[kind()]}
      />
    </BaseButton>
  );
}
