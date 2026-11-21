// Desk on native. Every colour, radius, font, weight and shadow is read from
// the shared token file; nothing here is a design value of its own. The web
// builds its Mantine theme from the same file (`src/ui/theme/theme.ts`).
import tokens from '../../../packages/hatch-design-tokens/tokens.json';

export type AccentName = keyof typeof tokens.accents;
export const accentNames = Object.keys(tokens.accents) as AccentName[];
export const defaultAccent = tokens.defaultAccent as AccentName;

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16),
  ) as [number, number, number];
}

function mix(hex: string, toward: number, amount: number): string {
  return `#${channels(hex)
    .map((channel) =>
      Math.round(channel + (toward - channel) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
}

/**
 * The ramp steps DESIGN.md names ("Ramps"): the token is the fill, `tint` is
 * shade 1 (86 % white), `tintStrong` shade 2 (72 % white), `pressed` shade 7
 * (16 % black) and `ink` shade 8 (32 % black). Same steps as the web's
 * `colorRamp()`, so a tint or a label is the same colour on every platform.
 */
function ramp(fill: string) {
  return {
    fill,
    tint: mix(fill, 255, 0.86),
    tintStrong: mix(fill, 255, 0.72),
    pressed: mix(fill, 0, 0.16),
    ink: mix(fill, 0, 0.32),
    onFill: tokens.light['primary-foreground'],
  } as const;
}

export type Accent = ReturnType<typeof ramp>;

/**
 * The accent is the theme's one input. Components read it through
 * `useAccent()` (`./accent.tsx`) at render time, never at module scope, so the
 * whole app follows whatever name the provider is given.
 */
export function accentOf(name: AccentName): Accent {
  return ramp(tokens.accents[name]);
}

export const palette = {
  ground: tokens.light.background,
  ink: tokens.light.foreground,
  inkSoft: tokens.light['muted-foreground'],
  card: tokens.light.card,
  muted: tokens.light.muted,
  sunken: tokens.surfaces.sunken,
  panel: tokens.surfaces.panel,
  hairline: tokens.surfaces.hairline,
  hover: tokens.surfaces.hover,
  pressed: tokens.surfaces.pressed,
  scrim: tokens.surfaces.scrim,
  input: tokens.light.input,
  ring: tokens.light.ring,
  /** Inactive pager dots and switch tracks. */
  idle: tokens.neutral[4],
  /** Dashed outlines of "add" tiles; decoration, never text. */
  outline: tokens.neutral[5],
  onFill: tokens.light['primary-foreground'],
  danger: tokens.light.destructive,
  dangerSoft: mix(tokens.light.destructive, 255, 0.86),
} as const;

/** Status colours: colour never carries state alone, pair it with a word. */
export const status = {
  danger: ramp(tokens.light.destructive),
  success: ramp(tokens.hues.green),
  warning: ramp(tokens.hues.amber),
  info: ramp(tokens.hues.blue),
} as const;

/** Fills for monogram and row tiles; every one carries white text at AA. */
export const tiles: readonly string[] = tokens.tiles;

/** Same hash as the web `AppGlyph`, so an App keeps its tint everywhere. */
export function tileFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1)
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return tiles[hash % tiles.length];
}

export const radii = tokens.radius;
/** Fully rounded ends; geometry, not a palette value. */
export const pill = 999;

/**
 * Nunito and JetBrains Mono ship in the binary (see `app.config.ts`). Neither
 * has CJK glyphs: iOS falls back to PingFang and Android to Noto Sans CJK.
 * System controls (navigation bars, tab bars, native fields and menus) keep
 * the system font.
 */
export const fonts = tokens.fonts;

type Weight = '500' | '600' | '700' | '800';
export const weights = {
  body: String(tokens.fontWeights.body) as Weight,
  strong: String(tokens.fontWeights.strong) as Weight,
  label: String(tokens.fontWeights.label) as Weight,
  heading: String(tokens.fontWeights.heading) as Weight,
} as const;

/** CSS shadows, used as React Native `boxShadow` values. */
export const shadows = tokens.shadows;

export const motion = tokens.motion;
