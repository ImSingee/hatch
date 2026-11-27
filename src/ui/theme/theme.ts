import {
  Anchor,
  Card,
  Container,
  HoverCard,
  Menu,
  Modal,
  Popover,
  Select,
  Tooltip,
  createTheme,
  defaultVariantColorsResolver,
  parseThemeColor,
  rem,
} from '@mantine/core';
import type { VariantColorsResolver } from '@mantine/core';
import type { MantineColorsTuple, MantineThemeOverride } from '@mantine/core';
import tokens from '../../../packages/hatch-design-tokens/tokens.json';
import {
  BUILT_IN_THEME,
  colorRamp as tokenRamp,
  mix,
  type ResolvedTheme,
} from '../../../packages/hatch-design-tokens/src';
import { ACCENT_COLORS, type AccentName } from './accents';

/**
 * The ten-step ramp of one colour on a light theme: the colour is shade 6
 * (the filled shade); lighter steps carry tints, hovers and selection,
 * darker steps carry text, links and pressed states.
 */
export function colorRamp(base: string): MantineColorsTuple {
  return tokenRamp(base) as unknown as MantineColorsTuple;
}

/** The `primary` ramp for one of the accents on the light `desk` theme. */
export function accentRamp(accent: AccentName): MantineColorsTuple {
  return colorRamp(ACCENT_COLORS[accent]);
}

/**
 * Mantine colour names backed by a token hue. Several names share one hue so
 * that existing `color="yellow"` or `color="grape"` props stay inside the
 * palette.
 */
const HUE_BY_COLOR_NAME = {
  red: 'red',
  orange: 'orange',
  yellow: 'amber',
  amber: 'amber',
  green: 'green',
  teal: 'teal',
  blue: 'blue',
  violet: 'violet',
  grape: 'violet',
  pink: 'pink',
} as const satisfies Record<string, keyof typeof tokens.hues>;

/** Every chromatic palette; drives the variant roles in the CSS resolver. */
export const HUE_COLOR_NAMES: readonly string[] = [
  'primary',
  ...Object.keys(HUE_BY_COLOR_NAME),
];

/** The resolved ramp behind one of the chromatic Mantine palettes. */
export function rampOf(theme: ResolvedTheme, name: string): string[] {
  return name === 'primary'
    ? theme.ramps.primary
    : theme.ramps[HUE_BY_COLOR_NAME[name as keyof typeof HUE_BY_COLOR_NAME]];
}

const tuple = (shades: readonly string[]) =>
  shades as unknown as MantineColorsTuple;

/**
 * Mantine's `dark` palette, which its dark colour scheme reads for surfaces
 * and text: shade 0 is the text, 7 the body, 6 fields and buttons, 4
 * borders. A light theme keeps the neutral ramp there, as it always has.
 */
function darkSchemeRamp(theme: ResolvedTheme): MantineColorsTuple {
  const c = theme.colors;
  if (theme.appearance === 'light') return tuple(theme.ramps.neutral);
  return tuple([
    c.foreground,
    mix(c.foreground, c['muted-foreground'], 0.5),
    c['muted-foreground'],
    mix(c['muted-foreground'], c.border, 0.5),
    c.border,
    mix(c.card, c.foreground, 0.08),
    c.card,
    c.background,
    mix(c.background, '#000000', 0.25),
    mix(c.background, '#000000', 0.45),
  ]);
}

/** Tile fills for monogram glyphs; every one carries white text at AA. */
export const TILE_COLORS: readonly string[] = tokens.tiles;

const CONTAINER_SIZES: Record<string, string> = {
  xxs: rem(200),
  xs: rem(300),
  sm: rem(400),
  md: rem(500),
  lg: rem(600),
  xl: rem(1400),
  xxl: rem(1600),
};

const SANS_FALLBACK = `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans SC', 'Segoe UI', Roboto, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'`;
const MONO_FALLBACK = `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;

/** A bundled face first (its variable cut, then the static one). */
const fontStack = (face: string, fallback: string) =>
  face === 'system' ? fallback : `'${face} Variable', '${face}', ${fallback}`;

/**
 * Filled `primary` controls carry the theme's own `primary-foreground` (the
 * pair validation checked) instead of Mantine's luminance guess, which can
 * put white on a pale primary. `--mantine-primary-color-contrast` holds it
 * (see `cssVariableResolver.ts`).
 */
const filledPrimaryLabel: VariantColorsResolver = (input) => {
  const colors = defaultVariantColorsResolver(input);
  if (input.variant !== 'filled') return colors;
  const parsed = parseThemeColor({
    color: input.color ?? input.theme.primaryColor,
    theme: input.theme,
  });
  return parsed.isThemeColor &&
    parsed.color === 'primary' &&
    parsed.shade === undefined
    ? { ...colors, color: 'var(--mantine-primary-color-contrast)' }
    : colors;
};

const buildDeskTheme = (resolved: ResolvedTheme): MantineThemeOverride => {
  const light = resolved.appearance === 'light';
  const radius = resolved.radius;
  return createTheme({
    // A light theme draws Mantine's surfaces in white (the card); a dark
    // one uses the `dark` palette for them and white only for text.
    white: light ? resolved.colors.card : resolved.colors['on-fill'],
    black: light ? resolved.colors.foreground : resolved.colors.background,
    colors: {
      primary: tuple(resolved.ramps.primary),
      gray: tuple(resolved.ramps.neutral),
      dark: darkSchemeRamp(resolved),
      ...(Object.fromEntries(
        Object.entries(HUE_BY_COLOR_NAME).map(([name, hue]) => [
          name,
          tuple(resolved.ramps[hue]),
        ]),
      ) as Record<keyof typeof HUE_BY_COLOR_NAME, MantineColorsTuple>),
    },
    primaryColor: 'primary',
    variantColorResolver: filledPrimaryLabel,
    primaryShade: 6,
    autoContrast: true,
    luminanceThreshold: 0.3,
    focusRing: 'auto',
    cursorType: 'pointer',
    fontFamily: fontStack(resolved.fonts.sans, SANS_FALLBACK),
    fontFamilyMonospace: fontStack(resolved.fonts.mono, MONO_FALLBACK),
    radius: {
      xs: rem(radius.xs),
      sm: rem(radius.sm),
      md: rem(radius.md),
      lg: rem(radius.lg),
      xl: rem(radius.xl),
    },
    defaultRadius: 'md',
    spacing: {
      '4xs': rem(2),
      '3xs': rem(4),
      '2xs': rem(8),
      xs: rem(10),
      sm: rem(12),
      md: rem(16),
      lg: rem(20),
      xl: rem(24),
      '2xl': rem(28),
      '3xl': rem(32),
      '4xl': rem(40),
    },
    fontSizes: {
      xs: rem(12),
      sm: rem(14),
      md: rem(16),
      lg: rem(18),
      xl: rem(20),
      '2xl': rem(24),
      '3xl': rem(30),
      '4xl': rem(36),
      '5xl': rem(48),
    },
    lineHeights: {
      xs: rem(18),
      sm: rem(20),
      md: rem(24),
      lg: rem(28),
    },
    headings: {
      fontWeight: String(tokens.fontWeights.heading),
      sizes: {
        h1: { fontSize: rem(30), lineHeight: rem(38) },
        h2: { fontSize: rem(24), lineHeight: rem(32) },
        h3: { fontSize: rem(20), lineHeight: rem(28) },
        h4: { fontSize: rem(17), lineHeight: rem(24) },
      },
    },
    shadows: {
      xs: resolved.shadows.card,
      sm: resolved.shadows.card,
      md: resolved.shadows.dock,
      lg: resolved.shadows.dock,
      xl: resolved.shadows.window,
    },
    other: { resolved },
    components: {
      Container: Container.extend({
        vars: (_, { size, fluid }) => ({
          root: {
            '--container-size': fluid
              ? '100%'
              : size !== undefined && size in CONTAINER_SIZES
                ? CONTAINER_SIZES[size]
                : rem(size),
          },
        }),
      }),
      Select: Select.extend({
        defaultProps: { checkIconPosition: 'right' },
      }),
      Anchor: Anchor.extend({
        defaultProps: { underline: 'always' },
      }),
      Card: Card.extend({
        defaultProps: { p: 'xl', radius: 'xl', shadow: 'sm' },
      }),
      Modal: Modal.extend({
        defaultProps: { radius: rem(radius.window), shadow: 'xl' },
      }),
      Menu: Menu.extend({
        defaultProps: { radius: 'lg', shadow: 'md' },
      }),
      Popover: Popover.extend({
        defaultProps: { radius: 'lg', shadow: 'md' },
      }),
      HoverCard: HoverCard.extend({
        defaultProps: { radius: 'lg', shadow: 'md' },
      }),
      Tooltip: Tooltip.extend({
        defaultProps: { radius: 'sm' },
      }),
    },
  });
};

const THEMES = new WeakMap<ResolvedTheme, MantineThemeOverride>();

/** The Mantine theme drawing a resolved theme; one object per theme. */
export function deskThemeFor(resolved: ResolvedTheme): MantineThemeOverride {
  let theme = THEMES.get(resolved);
  if (!theme) {
    theme = buildDeskTheme(resolved);
    THEMES.set(resolved, theme);
  }
  return theme;
}

/** The built-in `desk` theme with the default accent. */
export const deskTheme: MantineThemeOverride = deskThemeFor(BUILT_IN_THEME);

/** The resolved theme a Mantine theme was built from. */
export function resolvedThemeOf(theme: { other?: unknown }): ResolvedTheme {
  const other = theme.other as { resolved?: ResolvedTheme } | undefined;
  return other?.resolved ?? BUILT_IN_THEME;
}
