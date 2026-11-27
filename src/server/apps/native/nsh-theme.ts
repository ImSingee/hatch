/**
 * The NSH theme of a native App: a user's resolved theme (or the built-in
 * `desk` with an accent) in the shadcn `cssVars` shape NSH reads from
 * `nsh.json` `"theme"` and from `setTheme`. The web player and the native
 * shells push the result whole with `hatch.theme`.
 */
import tokens from '../../../../packages/hatch-design-tokens/tokens.json';
import {
  resolvePreset,
  type ResolvedTheme,
} from '../../../../packages/hatch-design-tokens/src';
import {
  NATIVE_APP_SDK_DEFINITIONS,
  type SdkNshTheme,
} from '../../../../sdk-internal/definitions';
import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  type AccentName,
} from '../../../ui/theme/accents';

export type NshTheme = {
  cssVars: {
    theme: Record<string, string>;
    light: Record<string, string>;
  };
};

function library() {
  return NATIVE_APP_SDK_DEFINITIONS.find((definition) => definition.nsh);
}

/**
 * The theme native Apps get for a user's resolved theme: the UI library's
 * own (complete, its custom tokens included) when one is listed, else
 * {@link tokenThemeFor}.
 */
export function nshThemeFor(theme: ResolvedTheme): SdkNshTheme {
  // One builder for every theme: the themes a player switches between must
  // name the same tokens, since `setTheme` replaces the whole theme.
  return library()?.nsh?.resolvedTheme?.(theme) ?? tokenThemeFor(theme);
}

/** The built-in `desk` theme with an accent, as native Apps get it. */
export function nshTheme(accent: AccentName = DEFAULT_ACCENT): SdkNshTheme {
  return (
    library()?.nsh?.theme?.(accent) ??
    tokenThemeFor(resolvePreset('desk', ACCENT_COLORS[accent]))
  );
}

/** `nsh.json` "tailwind" from the UI library, if it has one. */
export function nshTailwind(): Record<string, unknown> | undefined {
  return NATIVE_APP_SDK_DEFINITIONS.find(
    (definition) => definition.nsh?.tailwind,
  )?.nsh?.tailwind;
}

const SANS_FALLBACK =
  'PingFang SC, Microsoft YaHei UI, Noto Sans SC, system-ui, sans-serif';
const MONO_FALLBACK = 'ui-monospace, Menlo, Consolas, monospace';

/** A bundled face first, or the platform's own for `system`. */
function fontFamily(face: string, fallback: string): string {
  return face === 'system' ? fallback : `${face}, ${fallback}`;
}

/** The shadcn names NSH types as tokens, filled from a resolved theme. */
export function tokenThemeFor(theme: ResolvedTheme): NshTheme {
  const c = theme.colors;
  const hues = Object.keys(tokens.hues).map(
    (hue) => theme.ramps[hue as keyof typeof tokens.hues][6],
  );
  const shadcn = Object.fromEntries(
    Object.keys(tokens.light).map((key) => [key, c[key as keyof typeof c]]),
  );
  return {
    cssVars: {
      theme: {
        radius: `${theme.radius.md}px`,
        'font-sans': fontFamily(theme.fonts.sans, SANS_FALLBACK),
        'font-mono': fontFamily(theme.fonts.mono, MONO_FALLBACK),
      },
      // NSH applies `light` as the theme; a dark theme's values go here too.
      light: {
        ...shadcn,
        primary: c.primary,
        // shadcn's `accent` is the hover/selected surface, not the brand.
        accent: c.secondary,
        'accent-foreground': c['secondary-foreground'],
        ...Object.fromEntries(
          [0, 1, 2, 3, 4].map((index) => [
            `chart-${index + 1}`,
            hues[index % hues.length],
          ]),
        ),
        sidebar: c['surface-window'],
        'sidebar-foreground': c.foreground,
        'sidebar-primary': c.primary,
        'sidebar-primary-foreground': c['primary-foreground'],
        'sidebar-accent': c.secondary,
        'sidebar-accent-foreground': c['secondary-foreground'],
        'sidebar-border': c.border,
        'sidebar-ring': c.ring,
      },
    },
  };
}

/** The `desk` theme of an accent; kept for callers that name an accent. */
export function tokenTheme(accent: AccentName = DEFAULT_ACCENT): NshTheme {
  return tokenThemeFor(resolvePreset('desk', ACCENT_COLORS[accent]));
}

/** One theme per accent, so a player can follow accent changes locally. */
export function nshThemesByAccent(): Record<AccentName, SdkNshTheme> {
  return Object.fromEntries(
    ACCENT_NAMES.map((accent) => [accent, nshTheme(accent)]),
  ) as Record<AccentName, SdkNshTheme>;
}
