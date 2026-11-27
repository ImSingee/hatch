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
import {
  colorRamp as tokenRamp,
  destructiveRamp,
  pressedShade,
  mix,
  resolvePreset,
  type ResolvedTheme,
} from '../../../packages/hatch-design-tokens/src/index.ts';

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

/**
 * The ten-step ramp of one token colour on a light theme, as the platform
 * builds it (`packages/hatch-design-tokens`): the token is shade 6, shades
 * 0–5 mix it with white, shades 7–9 with black.
 */
export function colorRamp(base: string): string[] {
  return tokenRamp(base);
}

/**
 * The roles a chromatic colour plays (DESIGN.md "Ramps"): the fill, its
 * stronger shade for text, links and icons, the shade a hovered or pressed
 * fill takes (one step away from the fill's `label`), and the tint variant.
 */
function toneRoles(
  name: string,
  ramp: readonly string[],
  label: string,
): Record<string, string> {
  return {
    [name]: ramp[6],
    [`${name}-strong`]: ramp[7],
    [`${name}-pressed`]: ramp[pressedShade(ramp, label)],
    [`${name}-tint`]: ramp[1],
    [`${name}-tint-hover`]: ramp[2],
    [`${name}-tint-foreground`]: ramp[8],
  };
}

const SANS_FALLBACK =
  'PingFang SC, Microsoft YaHei UI, Noto Sans SC, system-ui, sans-serif';
const MONO_FALLBACK = 'ui-monospace, Menlo, Consolas, monospace';

/** A bundled face first, or the platform's own for `system`. */
function family(face: string, fallback: string): string {
  return face === 'system' ? fallback : `${face}, ${fallback}`;
}

function px(value: number): string {
  return `${value}px`;
}

/**
 * The complete theme of an App: for a resolved instance theme (`theme`),
 * else for the built-in `desk` theme with `accent`.
 */
export function buildAppTheme(
  options: { accent?: AccentName; theme?: ResolvedTheme } = {},
): NshTheme {
  const accent = options.accent ?? DEFAULT_ACCENT;
  const accentColor = tokens.accents[accent];
  if (!options.theme && !accentColor)
    throw new Error(`Unknown accent ${String(accent)}`);
  const theme = options.theme ?? resolvePreset('desk', accentColor);
  const c = theme.colors;
  const neutral = theme.ramps.neutral;
  const primaryColor = c.primary;
  const primary = toneRoles(
    'primary',
    theme.ramps.primary,
    c['primary-foreground'],
  );

  return {
    cssVars: {
      theme: {
        radius: px(theme.radius.md),
        'radius-xs': px(theme.radius.xs),
        'radius-sm': px(theme.radius.sm),
        'radius-md': px(theme.radius.md),
        'radius-lg': px(theme.radius.lg),
        'radius-tile': px(theme.radius.tile),
        'radius-xl': px(theme.radius.xl),
        'radius-window': px(theme.radius.window),
        'font-sans': family(theme.fonts.sans, SANS_FALLBACK),
        'font-mono': family(theme.fonts.mono, MONO_FALLBACK),
      },
      // NSH applies `light` as the theme; a dark theme's values go here too.
      light: {
        // shadcn/ui roles, which NSH's own components read as well.
        background: c.background,
        foreground: c.foreground,
        card: c.card,
        'card-foreground': c['card-foreground'],
        popover: c.popover,
        'popover-foreground': c['popover-foreground'],
        ...primary,
        'primary-foreground': c['primary-foreground'],
        secondary: c.secondary,
        'secondary-foreground': c['secondary-foreground'],
        muted: c.muted,
        'muted-foreground': c['muted-foreground'],
        accent: c['surface-hover'],
        'accent-foreground': c.foreground,
        border: c.border,
        input: c.input,
        ring: c.ring,
        destructive: c.destructive,
        'destructive-foreground': c['destructive-foreground'],
        'chart-1': primaryColor,
        'chart-2': theme.ramps.teal[6],
        'chart-3': theme.ramps.amber[6],
        'chart-4': theme.ramps.violet[6],
        'chart-5': theme.ramps.pink[6],
        sidebar: c.muted,
        'sidebar-foreground': c.foreground,
        'sidebar-primary': primaryColor,
        'sidebar-primary-foreground': c['primary-foreground'],
        'sidebar-accent': primary['primary-tint'],
        'sidebar-accent-foreground': primary['primary-tint-foreground'],
        'sidebar-border': c.hairline,
        'sidebar-ring': c.ring,

        // Desk surfaces (DESIGN.md "Roles").
        'surface-window': c['surface-window'],
        'surface-panel': c['surface-panel'],
        'surface-dock': c['surface-dock'],
        'surface-widget': c['surface-widget'],
        'surface-bubble': c['surface-bubble'],
        'surface-sunken': c['surface-sunken'],
        'surface-hover': c['surface-hover'],
        'surface-pressed': c['surface-pressed'],
        scrim: c['surface-scrim'],
        hairline: c.hairline,
        'ground-accent': mix(
          primaryColor,
          c.card,
          1 - tokens.ground.accentTint / 100,
        ),
        'ground-warm': c['ground-warm'],
        'ground-fresh': c['ground-fresh'],

        // Neutral shades the component specification names.
        'field-label': neutral[7],
        'control-border': neutral[5],
        track: neutral[4],
        'neutral-strong': neutral[7],
        'neutral-fill': neutral[2],
        'neutral-fill-hover': neutral[3],

        // Status colours: red, amber, green and blue (DESIGN.md "Hues").
        // The theme's own destructive colour, so a danger fill keeps the
        // `destructive-foreground` derived (and contrast-checked) for it.
        ...toneRoles(
          'danger',
          destructiveRamp(theme),
          c['destructive-foreground'],
        ),
        ...toneRoles('warning', theme.ramps.amber, c['on-fill']),
        ...toneRoles('success', theme.ramps.green, c['on-fill']),
        ...toneRoles('info', theme.ramps.blue, c['on-fill']),

        // Monogram tile fills; each carries white text at 4.5:1.
        ...Object.fromEntries(
          tokens.tiles.map((fill, index) => [`tile-${index}`, fill]),
        ),
        'tile-foreground': c['on-fill'],
      },
    },
  };
}

/** The number of monogram tile fills (`tile-0` …). */
export const TILE_COUNT = tokens.tiles.length;
