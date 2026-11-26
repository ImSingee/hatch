/**
 * Builds the NSH theme of a native-runtime App from the Desk design tokens.
 *
 * Pure TypeScript with no `nsh` import: the platform, a web player page and a
 * native shell's build script all call it, and the `@hatch/ui` generator
 * writes its output as the App's built-in `theme.json`. The host sends the
 * result whole (`hatch.theme.get`, the `hatch.theme` event): NSH's `setTheme`
 * replaces the entire theme, so a partial theme would leave every class that
 * names a missing token unresolved.
 */
import tokens from '../../../packages/hatch-design-tokens/tokens.json' with { type: 'json' };

export type AccentName = keyof typeof tokens.accents;

export const ACCENT_NAMES = Object.keys(tokens.accents) as AccentName[];

export const DEFAULT_ACCENT = tokens.defaultAccent as AccentName;

/** NSH's theme document: shadcn/ui's `cssVars`. */
export type NshTheme = {
  cssVars: {
    theme: Record<string, string>;
    light: Record<string, string>;
  };
};

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected a #RRGGBB colour, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, '0').toUpperCase())
    .join('')}`;
}

/** Mantine's `lighten`: each channel moves `amount` of the way to white. */
function lighten(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  const light = (channel: number) =>
    Math.round(channel + (255 - channel) * amount);
  return toHex({ r: light(r), g: light(g), b: light(b) });
}

/** Mantine's `darken`: each channel is scaled by `1 - amount`. */
function darken(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  const dark = (channel: number) => Math.round(channel * (1 - amount));
  return toHex({ r: dark(r), g: dark(g), b: dark(b) });
}

/**
 * The ten-step ramp of one token colour, as `colorRamp()` in
 * `src/ui/theme/theme.ts` builds it for the platform: the token is shade 6,
 * shades 0–5 mix it with white, shades 7–9 with black.
 */
export function colorRamp(base: string): string[] {
  return [
    lighten(base, 0.92),
    lighten(base, 0.86),
    lighten(base, 0.72),
    lighten(base, 0.5),
    lighten(base, 0.3),
    lighten(base, 0.14),
    base.toUpperCase(),
    darken(base, 0.16),
    darken(base, 0.32),
    darken(base, 0.48),
  ];
}

/**
 * The roles a chromatic colour plays (DESIGN.md "Ramps"): the fill, its
 * stronger shade for hover and for text or links, and the tint variant.
 */
function toneRoles(name: string, base: string): Record<string, string> {
  const ramp = colorRamp(base);
  return {
    [name]: ramp[6],
    [`${name}-strong`]: ramp[7],
    [`${name}-tint`]: ramp[1],
    [`${name}-tint-hover`]: ramp[2],
    [`${name}-tint-foreground`]: ramp[8],
  };
}

/** `amount`% of `hex` over white, as CSS `color-mix(in srgb, …)` gives it. */
function tintOnWhite(hex: string, percent: number): string {
  return lighten(hex, 1 - percent / 100);
}

const neutral = tokens.neutral;
const light = tokens.light;
const surfaces = tokens.surfaces;

const sansFamily = `${tokens.fonts.sans}, PingFang SC, Microsoft YaHei UI, Noto Sans SC, system-ui, sans-serif`;
const monoFamily = `${tokens.fonts.mono}, ui-monospace, Menlo, Consolas, monospace`;

function px(value: number): string {
  return `${value}px`;
}

/** The complete theme of an App for one accent. */
export function buildAppTheme(options: { accent?: AccentName } = {}): NshTheme {
  const accent = options.accent ?? DEFAULT_ACCENT;
  const accentColor = tokens.accents[accent];
  if (!accentColor) throw new Error(`Unknown accent ${String(accent)}`);
  const primary = toneRoles('primary', accentColor);

  return {
    cssVars: {
      theme: {
        radius: px(tokens.radius.md),
        'radius-xs': px(tokens.radius.xs),
        'radius-sm': px(tokens.radius.sm),
        'radius-md': px(tokens.radius.md),
        'radius-lg': px(tokens.radius.lg),
        'radius-tile': px(tokens.radius.tile),
        'radius-xl': px(tokens.radius.xl),
        'radius-window': px(tokens.radius.window),
        'font-sans': sansFamily,
        'font-mono': monoFamily,
      },
      light: {
        // shadcn/ui roles, which NSH's own components read as well.
        background: light.background,
        foreground: light.foreground,
        card: light.card,
        'card-foreground': light['card-foreground'],
        popover: light.popover,
        'popover-foreground': light['popover-foreground'],
        ...primary,
        'primary-foreground': light['primary-foreground'],
        secondary: light.secondary,
        'secondary-foreground': light['secondary-foreground'],
        muted: light.muted,
        'muted-foreground': light['muted-foreground'],
        accent: surfaces.hover,
        'accent-foreground': light.foreground,
        border: light.border,
        input: light.input,
        ring: light.ring,
        destructive: light.destructive,
        'destructive-foreground': light['destructive-foreground'],
        'chart-1': accentColor,
        'chart-2': tokens.hues.teal,
        'chart-3': tokens.hues.amber,
        'chart-4': tokens.hues.violet,
        'chart-5': tokens.hues.pink,
        sidebar: light.muted,
        'sidebar-foreground': light.foreground,
        'sidebar-primary': accentColor,
        'sidebar-primary-foreground': light['primary-foreground'],
        'sidebar-accent': primary['primary-tint'],
        'sidebar-accent-foreground': primary['primary-tint-foreground'],
        'sidebar-border': surfaces.hairline,
        'sidebar-ring': light.ring,

        // Desk surfaces (DESIGN.md "Roles").
        'surface-window': surfaces.window,
        'surface-panel': surfaces.panel,
        'surface-dock': surfaces.dock,
        'surface-widget': surfaces.widget,
        'surface-bubble': surfaces.bubble,
        'surface-sunken': surfaces.sunken,
        'surface-hover': surfaces.hover,
        'surface-pressed': surfaces.pressed,
        scrim: surfaces.scrim,
        hairline: surfaces.hairline,
        'ground-accent': tintOnWhite(accentColor, tokens.ground.accentTint),
        'ground-warm': tokens.ground.warm,
        'ground-fresh': tokens.ground.fresh,

        // Neutral shades the component specification names.
        'field-label': neutral[7],
        'control-border': neutral[5],
        track: neutral[4],
        'neutral-strong': neutral[7],
        'neutral-fill': neutral[2],
        'neutral-fill-hover': neutral[3],

        // Status colours: red, amber, green and blue (DESIGN.md "Hues").
        ...toneRoles('danger', tokens.hues.red),
        ...toneRoles('warning', tokens.hues.amber),
        ...toneRoles('success', tokens.hues.green),
        ...toneRoles('info', tokens.hues.blue),

        // Monogram tile fills; each carries white text at 4.5:1.
        ...Object.fromEntries(
          tokens.tiles.map((fill, index) => [`tile-${index}`, fill]),
        ),
        'tile-foreground': light.card,
      },
    },
  };
}

/** The number of monogram tile fills (`tile-0` …). */
export const TILE_COUNT = tokens.tiles.length;
