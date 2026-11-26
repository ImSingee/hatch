import { Canvas, Path2D, token } from 'nsh';
import type { JSX, Tokens } from 'nsh';
import type { ThemeColor } from '../core/tokens.gen';
import type { IconData } from './icon-data';

/** Icon sizes: 12, 14, 16, 18, 20 and 26 points. */
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/** What an icon's colour means. */
export type IconTone =
  | 'default'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export const ICON_SIZE_CLASS: Record<IconSize, string> = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-4.5',
  xl: 'size-5',
  '2xl': 'size-6.5',
};

/** A token that colours a glyph. Internal: components pass the token of the
 * text the icon stands beside. */
export type GlyphColor = ThemeColor;

/** A colour token's value, reactive: a theme change redraws what read it. */
export function colorToken(name: ThemeColor): string {
  return token(name as keyof Tokens) as string;
}

const TONE_COLOR: Record<IconTone, GlyphColor> = {
  default: 'foreground',
  muted: 'muted-foreground',
  accent: 'primary-strong',
  success: 'success-strong',
  warning: 'warning-strong',
  danger: 'danger-strong',
  info: 'info-strong',
};

const paths = new Map<string, Path2D>();

function pathOf(icon: IconData): Path2D {
  let path = paths.get(icon.d);
  if (!path) {
    path = new Path2D(icon.d);
    paths.set(icon.d, path);
  }
  return path;
}

/** The 24-point grid Tabler draws on, and its stroke. */
const GRID = 24;
const STROKE = 2;

/** Draws an icon in a token colour. Internal building block of `Icon` and of
 * every component that shows an icon. */
export function Glyph(props: {
  icon: IconData;
  size: IconSize;
  color: GlyphColor;
  label?: string;
}): JSX.Element {
  return (
    <Canvas
      class={`shrink-0 ${ICON_SIZE_CLASS[props.size]}`}
      accessible={props.label !== undefined}
      role={props.label === undefined ? undefined : 'image'}
      accessibilityLabel={props.label}
      importantForAccessibility={
        props.label === undefined ? 'no-hide-descendants' : 'yes'
      }
      draw={(cx, { width }) => {
        const scale = width / GRID;
        cx.scale(scale, scale);
        cx.lineWidth = STROKE;
        cx.lineCap = 'round';
        cx.lineJoin = 'round';
        cx.strokeStyle = colorToken(props.color);
        cx.stroke(pathOf(props.icon));
      }}
    />
  );
}

export type IconProps = {
  /** The icon: one of the `Icon…` constants exported by `@hatch/ui`. */
  icon: IconData;
  /** 12 (`xs`) to 26 (`2xl`) points; default `md` (16). */
  size?: IconSize;
  /** Default ink. A tone never carries meaning alone: pair it with text. */
  tone?: IconTone;
  /** Makes the icon an image a screen reader announces. Leave it out when
   * text beside the icon says the same thing. */
  label?: string;
};

/** An icon from the `@hatch/ui` set, drawn natively. */
export function Icon(props: IconProps): JSX.Element {
  return (
    <Glyph
      icon={props.icon}
      size={props.size ?? 'md'}
      color={TONE_COLOR[props.tone ?? 'default']}
      label={props.label}
    />
  );
}
