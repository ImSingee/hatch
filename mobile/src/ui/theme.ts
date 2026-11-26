// Desk on native. Every colour, radius, font and shadow comes from the
// instance theme, resolved by the platform (`ThemeService.GetTheme`) into the
// same token set the web draws; nothing here is a design value of its own.
// Values that do not change with the theme (weights, sizes, tile fills,
// motion) are read from the shared token file.
import tokens from '../../../packages/hatch-design-tokens/tokens.json';
import {
  BUILT_IN_THEME,
  FILL_PRESSED_SHADE,
  colorRamp,
  mix,
  resolvePreset,
  type ResolvedTheme,
  type ThemeAppearance,
} from '../../../packages/hatch-design-tokens/src';

/**
 * The ramp steps DESIGN.md names ("Ramps"): the token is the fill, `tint` is
 * shade 1, `tintStrong` shade 2, `pressed` shade 7 and `ink` shade 8. Same
 * steps as the web, so a tint or a label is the same colour on every
 * platform; on a dark theme the tints darken and the inks lighten.
 */
function rampRoles(
  ramp: readonly string[],
  onFill: string,
  card: string,
  appearance: ThemeAppearance,
) {
  return {
    fill: ramp[6],
    tint: ramp[1],
    tintStrong: ramp[2],
    /** One step darker than the fill: shade 7 on light, 5 on dark. */
    pressed: ramp[FILL_PRESSED_SHADE[appearance]],
    ink: ramp[8],
    onFill,
    /** The colour's ground shape: a faint tint of it on the card. */
    ground: mix(ramp[6], card, 1 - tokens.ground.accentTint / 100),
  } as const;
}

export type Accent = ReturnType<typeof rampRoles>;

function paletteOf(theme: ResolvedTheme) {
  const c = theme.colors;
  return {
    ground: c.background,
    ink: c.foreground,
    inkSoft: c['muted-foreground'],
    card: c.card,
    muted: c.muted,
    sunken: c['surface-sunken'],
    panel: c['surface-panel'],
    hairline: c.hairline,
    hover: c['surface-hover'],
    pressed: c['surface-pressed'],
    scrim: c['surface-scrim'],
    input: c.input,
    ring: c.ring,
    /** Inactive pager dots and switch tracks. */
    idle: theme.ramps.neutral[4],
    /** Dashed outlines of "add" tiles; decoration, never text. */
    outline: theme.ramps.neutral[5],
    onFill: c['primary-foreground'],
    /** Letters and glyphs on the fixed monogram tile fills: always white. */
    onTile: c['on-fill'],
    dock: c['surface-dock'],
    /** Widget cards: the card at 80% over the ground. */
    widget: c['surface-widget'],
    groundWarm: c['ground-warm'],
    groundFresh: c['ground-fresh'],
    danger: c.destructive,
    dangerSoft: colorRamp(c.destructive, theme.appearance, c.card)[1],
  } as const;
}

export type Palette = ReturnType<typeof paletteOf>;

/** Status colours: colour never carries state alone, pair it with a word. */
function statusOf(theme: ResolvedTheme) {
  const c = theme.colors;
  const roles = (ramp: readonly string[]) =>
    rampRoles(ramp, c['on-fill'], c.card, theme.appearance);
  return {
    danger: rampRoles(
      colorRamp(c.destructive, theme.appearance, c.card),
      c['destructive-foreground'],
      c.card,
      theme.appearance,
    ),
    success: roles(theme.ramps.green),
    warning: roles(theme.ramps.amber),
    info: roles(theme.ramps.blue),
    /** Work in progress, such as a card's "Fixing" status. */
    working: roles(theme.ramps.orange),
  } as const;
}

export type Status = ReturnType<typeof statusOf>;

/**
 * Nunito and JetBrains Mono ship in the binary (see `app.config.ts`). Neither
 * has CJK glyphs: iOS falls back to PingFang and Android to Noto Sans CJK.
 * A theme that picks `system` gets the platform face (no family). System
 * controls (navigation bars, tab bars, native fields and menus) keep the
 * system font.
 */
function fontsOf(theme: ResolvedTheme) {
  const face = (name: string) => (name === 'system' ? undefined : name);
  return { sans: face(theme.fonts.sans), mono: face(theme.fonts.mono) };
}

export type MobileTheme = {
  appearance: ThemeAppearance;
  palette: Palette;
  status: Status;
  accent: Accent;
  radii: ResolvedTheme['radius'];
  fonts: ReturnType<typeof fontsOf>;
  /** CSS shadows, used as React Native `boxShadow` values. */
  shadows: ResolvedTheme['shadows'];
};

const built = new WeakMap<ResolvedTheme, MobileTheme>();

/** The app's theme for a resolved instance theme; one object per theme. */
export function mobileThemeOf(theme: ResolvedTheme): MobileTheme {
  let mobile = built.get(theme);
  if (!mobile) {
    mobile = {
      appearance: theme.appearance,
      palette: paletteOf(theme),
      status: statusOf(theme),
      accent: rampRoles(
        theme.ramps.primary,
        theme.colors['primary-foreground'],
        theme.colors.card,
        theme.appearance,
      ),
      radii: theme.radius,
      fonts: fontsOf(theme),
      shadows: theme.shadows,
    };
    built.set(theme, mobile);
  }
  return mobile;
}

/** Drawn before an instance has answered, and while signed out. */
export const BUILT_IN_THEMES: Record<ThemeAppearance, ResolvedTheme> = {
  light: BUILT_IN_THEME,
  dark: resolvePreset('desk-dark'),
};

/** Fills for monogram and row tiles; every one carries white text at AA. */
export const tiles: readonly string[] = tokens.tiles;

/** Same hash as the web `AppGlyph`, so an App keeps its tint everywhere. */
export function tileFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1)
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return tiles[hash % tiles.length];
}

export const sizes = tokens.sizes;
/** Fully rounded ends; geometry, not a palette value. */
export const pill = 999;

type Weight = '500' | '600' | '700' | '800';
export const weights = {
  body: String(tokens.fontWeights.body) as Weight,
  strong: String(tokens.fontWeights.strong) as Weight,
  label: String(tokens.fontWeights.label) as Weight,
  heading: String(tokens.fontWeights.heading) as Weight,
} as const;

/**
 * Top light over a monogram tile fill, used as a React Native
 * `backgroundImage`; keeps the white letter at 4.5:1 on every tile.
 */
export const tileLight: string = tokens.tileLight;

export const motion = tokens.motion;
