/**
 * The built-in themes. `desk` is the look the platform has always had (its
 * values are `tokens.json`'s `light` block and the token surfaces) and the
 * default; `desk-dark` is its dark counterpart (`tokens.json` `dark`).
 */
import tokens from '../tokens.json' with { type: 'json' };
import {
  BASE_RADIUS,
  resolveTheme,
  type ResolvedTheme,
  type ThemeAppearance,
  type ThemeDocument,
  type ThemePins,
} from './theme';

export const THEME_PRESET_NAMES = ['desk', 'desk-dark'] as const;
export type ThemePresetName = (typeof THEME_PRESET_NAMES)[number];

export const DEFAULT_PRESETS: Record<ThemeAppearance, ThemePresetName> = {
  light: 'desk',
  dark: 'desk-dark',
};

export type ThemePreset = {
  name: ThemePresetName;
  document: ThemeDocument;
  /**
   * Values the designer tuned by hand that the derivation only approximates
   * (DESIGN.md "Themes"). Only presets carry pins; a custom theme is always
   * derived. The `desk` test checks that the unpinned derivation stays close
   * to them.
   */
  pins?: ThemePins;
};

const light = tokens.light;
const fonts = { sans: tokens.fonts.sans, mono: tokens.fonts.mono };

const desk: ThemePreset = {
  name: 'desk',
  document: {
    name: 'Desk',
    appearance: 'light',
    colors: {
      background: light.background,
      foreground: light.foreground,
      card: light.card,
      primary:
        tokens.accents[tokens.defaultAccent as keyof typeof tokens.accents],
      secondary: light.secondary,
      muted: light.muted,
      'muted-foreground': light['muted-foreground'],
      border: light.border,
      destructive: light.destructive,
    },
    radius: BASE_RADIUS,
    fonts,
  },
  pins: {
    neutral: tokens.neutral,
    colors: {
      input: light.input,
      'surface-window': tokens.surfaces.window,
      'surface-bubble': tokens.surfaces.bubble,
      'surface-sunken': tokens.surfaces.sunken,
      'composer-border': tokens.surfaces.composerBorder,
      'ground-warm': tokens.ground.warm,
      'ground-fresh': tokens.ground.fresh,
    },
  },
};

const deskDark: ThemePreset = {
  name: 'desk-dark',
  document: {
    name: 'Desk dark',
    appearance: 'dark',
    colors: tokens.dark,
    radius: BASE_RADIUS,
    fonts,
  },
};

export const THEME_PRESETS: Record<ThemePresetName, ThemePreset> = {
  desk,
  'desk-dark': deskDark,
};

export function isThemePresetName(value: unknown): value is ThemePresetName {
  return (
    typeof value === 'string' &&
    (THEME_PRESET_NAMES as readonly string[]).includes(value)
  );
}

/** A preset resolved, with an accent replacing its `primary` if given. */
export function resolvePreset(
  name: ThemePresetName,
  accent?: string | null,
): ResolvedTheme {
  const preset = THEME_PRESETS[name];
  return resolveTheme(preset.document, {
    name,
    source: 'preset',
    accent,
    pins: preset.pins,
  });
}

/** The built-in default every shell draws before an instance answers. */
export const BUILT_IN_THEME: ResolvedTheme = resolvePreset('desk');
