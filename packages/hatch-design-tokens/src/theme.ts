/**
 * Theme documents and their resolution into the full token set.
 *
 * A theme document holds a small set of semantic values (DESIGN.md
 * "Themes"). `resolveTheme` derives everything else from it: ten-step ramps,
 * paired `-foreground` colours, translucent surfaces, dividers, hover and
 * pressed washes, shadows and the desk ground tints. Every client applies
 * the resolved set; none of them derives tokens itself.
 */
import tokens from '../tokens.json' with { type: 'json' };
import { contrast, mix, mostLegible, normalizeColor, withAlpha } from './color';

export const THEME_APPEARANCES = ['light', 'dark'] as const;
export type ThemeAppearance = (typeof THEME_APPEARANCES)[number];

/** How a client picks the appearance: fixed, or following its device. */
export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** The colours a theme document sets; every other colour is derived. */
export const THEME_COLOR_KEYS = [
  'background',
  'foreground',
  'card',
  'primary',
  'secondary',
  'muted',
  'muted-foreground',
  'border',
  'destructive',
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/**
 * Faces every shell ships (web, mobile, macOS and the native App player),
 * plus `system`, the platform's own face. A theme can only name these.
 */
export const BUNDLED_FONTS = {
  sans: [tokens.fonts.sans, 'system'],
  mono: [tokens.fonts.mono, 'system'],
} as const;

export type ThemeFonts = { sans: string; mono: string };

export type ThemeDocument = {
  /** Shown in settings; not an identifier. */
  name?: string;
  appearance: ThemeAppearance;
  colors: Record<ThemeColorKey, string>;
  /** The base corner radius in px; every radius scales from it. */
  radius: number;
  fonts: ThemeFonts;
};

/** The base radius `radius` scales; `desk`'s medium radius. */
export const BASE_RADIUS = tokens.radius.md;
export const MAX_RADIUS = 32;

export type RadiusName = keyof typeof tokens.radius;
export const RADIUS_NAMES = Object.keys(tokens.radius) as RadiusName[];

/** Hues the platform uses for status and charts; fixed across themes. */
export type HueName = keyof typeof tokens.hues;
export const HUE_NAMES = Object.keys(tokens.hues) as HueName[];

export type RampName = 'primary' | 'neutral' | HueName;

/** Every colour the resolved theme names, besides the ramps. */
export const RESOLVED_COLOR_KEYS = [
  // shadcn/ui `cssVars` roles.
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'border',
  'input',
  'ring',
  'destructive',
  'destructive-foreground',
  /** Error text on the ground and on cards. */
  'destructive-text',
  // Desk surfaces (DESIGN.md "Roles").
  'surface-panel',
  'surface-dock',
  'surface-widget',
  'surface-window',
  'surface-bubble',
  'surface-sunken',
  'surface-hover',
  'surface-pressed',
  'surface-scrim',
  'hairline',
  'composer-border',
  /** The 1px light edge of translucent panels. */
  'glass-edge',
  /** Text and glyphs on a filled tile, chip or button. */
  'on-fill',
  'ground-accent',
  'ground-warm',
  'ground-fresh',
] as const;
export type ResolvedColorKey = (typeof RESOLVED_COLOR_KEYS)[number];

export type ShadowName = keyof typeof tokens.shadows;

export type ResolvedTheme = {
  /** The preset's name, or the custom document's `name`. */
  name: string;
  source: 'preset' | 'custom';
  appearance: ThemeAppearance;
  colors: Record<ResolvedColorKey, string>;
  /**
   * Ten shades each, ordered from the surface to the ink: shade 6 is the
   * fill, shades 0–5 tint towards the surface, 7–9 move towards the text
   * colour. On a dark theme "towards the ink" means lighter.
   */
  ramps: Record<RampName, string[]>;
  radius: Record<RadiusName, number>;
  fonts: ThemeFonts;
  shadows: Record<ShadowName, string>;
};

/** Values a preset fixes by hand instead of deriving (see `presets.ts`). */
export type ThemePins = {
  neutral?: string[];
  colors?: Partial<Record<ResolvedColorKey, string>>;
};

const WHITE = '#FFFFFF';
const BLACK = '#000000';

/**
 * Light ramps are Mantine's `lighten`/`darken` steps, so `desk` keeps the
 * shades the web has always drawn. Dark ramps tint towards the card and
 * lighten towards white, so shade 7 (text, links) and shade 8 (text on the
 * shade-1 tint) stay readable on a dark surface.
 */
const LIGHT_TINTS = [0.92, 0.86, 0.72, 0.5, 0.3, 0.14];
const LIGHT_INKS = [0.16, 0.32, 0.48];
const DARK_TINTS = [0.85, 0.75, 0.6, 0.42, 0.25, 0.12];
const DARK_INKS = [0.4, 0.6, 0.75];

export function colorRamp(
  base: string,
  appearance: ThemeAppearance = 'light',
  surface: string = WHITE,
): string[] {
  const fill = normalizeColor(base);
  if (appearance === 'light')
    return [
      ...LIGHT_TINTS.map((amount) => mix(fill, WHITE, amount)),
      fill,
      ...LIGHT_INKS.map((amount) => mix(fill, BLACK, amount)),
    ];
  return [
    ...DARK_TINTS.map((amount) => mix(fill, surface, amount)),
    fill,
    ...DARK_INKS.map((amount) => mix(fill, WHITE, amount)),
  ];
}

/**
 * The neutral ramp from the four neutrals a document sets: shade 1 is
 * `secondary`, 2 `border`, 6 `muted-foreground`, 9 `foreground`.
 */
function neutralRamp(colors: Record<ThemeColorKey, string>): string[] {
  const {
    card,
    secondary,
    border,
    foreground,
    'muted-foreground': mutedForeground,
  } = colors;
  return [
    mix(secondary, card, 0.4),
    secondary,
    border,
    mix(border, mutedForeground, 0.1),
    mix(border, mutedForeground, 0.35),
    mix(border, mutedForeground, 0.6),
    mutedForeground,
    mix(mutedForeground, foreground, 0.42),
    mix(mutedForeground, foreground, 0.72),
    foreground,
  ];
}

/** Shadow opacities: card, dock, window and the window's contact shadow. */
const SHADOW_ALPHA = {
  light: [0.06, 0.12, 0.16, 0.06],
  dark: [0.32, 0.4, 0.5, 0.3],
};

function shadowsFor(
  appearance: ThemeAppearance,
  ink: string,
): Record<ShadowName, string> {
  const [card, dock, window, contact] = SHADOW_ALPHA[appearance];
  return {
    card: `0 2px 10px ${withAlpha(ink, card)}`,
    dock: `0 10px 28px ${withAlpha(ink, dock)}`,
    window: `0 24px 60px ${withAlpha(ink, window)}, 0 2px 6px ${withAlpha(ink, contact)}`,
  };
}

/** The text on a fill: white, or the theme's dark ink when white fails. */
function onFill(fill: string, darkInk: string): string {
  return mostLegible(fill, [WHITE, darkInk]);
}

/**
 * Error text: the destructive colour itself where it reads on every surface
 * text sits on (desk's red does), else the first of its ramp's text shades
 * (7, then 8) that does.
 */
function errorText(
  destructive: string,
  appearance: ThemeAppearance,
  surfaces: readonly string[],
): string {
  const ramp = colorRamp(destructive, appearance, surfaces[1]);
  const candidates = [destructive, ramp[7], ramp[8]];
  return (
    candidates.find((color) =>
      surfaces.every((surface) => contrast(color, surface) >= 4.5),
    ) ?? ramp[8]
  );
}

/** Every radius scaled from the base, so `BASE_RADIUS` gives the tokens. */
function radiiFor(base: number): Record<RadiusName, number> {
  return Object.fromEntries(
    RADIUS_NAMES.map((name) => [
      name,
      Math.round((tokens.radius[name] * base) / BASE_RADIUS),
    ]),
  ) as Record<RadiusName, number>;
}

export type ResolveOptions = {
  name: string;
  source: 'preset' | 'custom';
  /** An accent colour that replaces the document's `primary`. */
  accent?: string | null;
  pins?: ThemePins;
};

/** Derive the full token set from a theme document. */
export function resolveTheme(
  document: ThemeDocument,
  options: ResolveOptions,
): ResolvedTheme {
  const { appearance } = document;
  const colors = Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => [key, normalizeColor(document.colors[key])]),
  ) as Record<ThemeColorKey, string>;
  if (options.accent) colors.primary = normalizeColor(options.accent);
  const { background, foreground, card, primary, destructive } = colors;
  // The darker of the two ends: text on light fills, and the shadow ink.
  const darkInk = appearance === 'light' ? foreground : background;
  const neutral = options.pins?.neutral ?? neutralRamp(colors);
  const hueRamps = Object.fromEntries(
    HUE_NAMES.map((hue) => [
      hue,
      colorRamp(tokens.hues[hue], appearance, card),
    ]),
  ) as Record<HueName, string[]>;

  const derived: Record<ResolvedColorKey, string> = {
    ...colors,
    'card-foreground': foreground,
    popover: card,
    'popover-foreground': foreground,
    'primary-foreground': onFill(primary, darkInk),
    'secondary-foreground': foreground,
    input: mix(colors.border, foreground, 0.12),
    ring: foreground,
    'destructive-foreground': onFill(destructive, darkInk),
    'destructive-text': errorText(destructive, appearance, [
      background,
      card,
      colors.muted,
    ]),
    'surface-panel': withAlpha(card, 0.72),
    'surface-dock': withAlpha(card, 0.82),
    'surface-widget': withAlpha(card, 0.8),
    'surface-window': neutral[0],
    'surface-bubble': mix(colors.secondary, colors.border, 0.27),
    'surface-sunken': mix(background, foreground, 0.045),
    'surface-hover': withAlpha(foreground, 0.06),
    'surface-pressed': withAlpha(foreground, 0.1),
    'surface-scrim': withAlpha(
      appearance === 'light' ? foreground : BLACK,
      0.45,
    ),
    hairline: withAlpha(foreground, 0.14),
    'composer-border': neutral[3],
    'glass-edge': appearance === 'light' ? card : withAlpha(foreground, 0.08),
    'on-fill': WHITE,
    'ground-accent': mix(primary, card, 1 - tokens.ground.accentTint / 100),
    'ground-warm': mix(card, tokens.hues.orange, 0.18),
    'ground-fresh': mix(card, tokens.hues.green, 0.16),
  };

  return {
    name: options.name,
    source: options.source,
    appearance,
    colors: { ...derived, ...options.pins?.colors },
    ramps: {
      primary: colorRamp(primary, appearance, card),
      neutral,
      ...hueRamps,
    },
    radius: radiiFor(document.radius),
    fonts: { ...document.fonts },
    shadows: shadowsFor(appearance, darkInk),
  };
}

/**
 * The shade a ramp uses as text and links on the theme's surfaces
 * (Mantine's `-text`, `-outline` and anchor roles).
 */
export const TEXT_SHADE = 7;

/**
 * The shade a filled control takes while hovered or pressed: one step from
 * the fill (5 or 7), whichever moves away from its label colour, so the label
 * reads at least as well as on the fill. White labels get the darker step
 * (7 on a light ramp, 5 on a dark one); a dark label on a pale fill, the
 * lighter one.
 */
export function pressedShade(
  ramp: readonly string[],
  foreground: string,
): 5 | 7 {
  return contrast(foreground, ramp[7]) >= contrast(foreground, ramp[5]) ? 7 : 5;
}

/**
 * Whether a value read from a cache or the network is a complete resolved
 * theme of `appearance`: every colour, ramp, radius, font and shadow a
 * client draws. A client keeps its previous theme otherwise.
 */
export function isResolvedTheme(
  value: unknown,
  appearance: ThemeAppearance,
): value is ResolvedTheme {
  const theme = value as Partial<ResolvedTheme> | null;
  if (typeof theme !== 'object' || theme === null) return false;
  const strings = (record: unknown, keys: readonly string[]) =>
    typeof record === 'object' &&
    record !== null &&
    keys.every(
      (key) => typeof (record as Record<string, unknown>)[key] === 'string',
    );
  const ramps = theme.ramps as Record<string, unknown> | undefined;
  return (
    theme.appearance === appearance &&
    typeof theme.name === 'string' &&
    (theme.source === 'preset' || theme.source === 'custom') &&
    strings(theme.colors, RESOLVED_COLOR_KEYS) &&
    typeof ramps === 'object' &&
    ramps !== null &&
    ['primary', 'neutral', ...HUE_NAMES].every((name) => {
      const ramp = ramps[name];
      return (
        Array.isArray(ramp) &&
        ramp.length === 10 &&
        ramp.every((shade) => typeof shade === 'string')
      );
    }) &&
    typeof theme.radius === 'object' &&
    theme.radius !== null &&
    RADIUS_NAMES.every((name) => typeof theme.radius?.[name] === 'number') &&
    strings(theme.fonts, ['sans', 'mono']) &&
    strings(theme.shadows, Object.keys(tokens.shadows))
  );
}
