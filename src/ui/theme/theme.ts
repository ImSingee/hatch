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
  darken,
  lighten,
  rem,
} from '@mantine/core';
import type { MantineColorsTuple, MantineThemeOverride } from '@mantine/core';
import tokens from '../../../packages/hatch-design-tokens/tokens.json';

export type AccentName = keyof typeof tokens.accents;

/**
 * Build the ten-step ramp Mantine needs from one token colour. The colour
 * itself is shade 6 (the filled shade); lighter steps carry tints, hovers and
 * selection, darker steps carry text, links and pressed states.
 */
export function colorRamp(base: string): MantineColorsTuple {
  return [
    lighten(base, 0.92),
    lighten(base, 0.86),
    lighten(base, 0.72),
    lighten(base, 0.5),
    lighten(base, 0.3),
    lighten(base, 0.14),
    base,
    darken(base, 0.16),
    darken(base, 0.32),
    darken(base, 0.48),
  ];
}

/** The `primary` ramp for one of the accents the user can choose. */
export function accentRamp(accent: AccentName): MantineColorsTuple {
  return colorRamp(tokens.accents[accent]);
}

const neutralRamp = tokens.neutral as unknown as MantineColorsTuple;

/**
 * Mantine colour names backed by a token hue. Several names share one hue so
 * that existing `color="yellow"` or `color="grape"` props stay inside the
 * palette.
 */
const HUE_BY_COLOR_NAME = {
  red: tokens.hues.red,
  orange: tokens.hues.orange,
  yellow: tokens.hues.amber,
  amber: tokens.hues.amber,
  green: tokens.hues.green,
  teal: tokens.hues.teal,
  blue: tokens.hues.blue,
  violet: tokens.hues.violet,
  grape: tokens.hues.violet,
  pink: tokens.hues.pink,
} as const;

/** Every chromatic palette; drives the variant roles in the CSS resolver. */
export const HUE_COLOR_NAMES: readonly string[] = [
  'primary',
  ...Object.keys(HUE_BY_COLOR_NAME),
];

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

const sansStack = `'${tokens.fonts.sans} Variable', '${tokens.fonts.sans}', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans SC', 'Segoe UI', Roboto, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'`;
const monoStack = `'${tokens.fonts.mono} Variable', '${tokens.fonts.mono}', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;

export const deskTheme: MantineThemeOverride = createTheme({
  white: tokens.light.card,
  black: tokens.light.foreground,
  colors: {
    primary: accentRamp(tokens.defaultAccent as AccentName),
    gray: neutralRamp,
    dark: neutralRamp,
    ...(Object.fromEntries(
      Object.entries(HUE_BY_COLOR_NAME).map(([name, hue]) => [
        name,
        colorRamp(hue),
      ]),
    ) as Record<keyof typeof HUE_BY_COLOR_NAME, MantineColorsTuple>),
  },
  primaryColor: 'primary',
  primaryShade: 6,
  autoContrast: true,
  luminanceThreshold: 0.3,
  focusRing: 'auto',
  cursorType: 'pointer',
  fontFamily: sansStack,
  fontFamilyMonospace: monoStack,
  radius: {
    xs: rem(tokens.radius.xs),
    sm: rem(tokens.radius.sm),
    md: rem(tokens.radius.md),
    lg: rem(tokens.radius.lg),
    xl: rem(tokens.radius.xl),
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
    xs: tokens.shadows.card,
    sm: tokens.shadows.card,
    md: tokens.shadows.dock,
    lg: tokens.shadows.dock,
    xl: tokens.shadows.window,
  },
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
      defaultProps: { radius: rem(tokens.radius.window), shadow: 'xl' },
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
