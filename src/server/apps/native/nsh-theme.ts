/**
 * The NSH theme of a native App: the design tokens plus the instance accent,
 * in the shadcn `cssVars` shape NSH reads from `nsh.json` `"theme"` and from
 * `setTheme`. Built only from `packages/hatch-design-tokens/tokens.json`, the
 * source every shell already ships, so the web player and the native shells
 * resolve the same values.
 */
import tokens from '../../../../packages/hatch-design-tokens/tokens.json';
import {
  NATIVE_APP_SDK_DEFINITIONS,
  type SdkNshTheme,
} from '../../../../sdk-internal/definitions';
import {
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

/**
 * The theme native Apps get: the UI library's own (complete, its custom
 * tokens included) when one is listed, else {@link tokenTheme}.
 */
export function nshTheme(accent: AccentName = DEFAULT_ACCENT): SdkNshTheme {
  const library = NATIVE_APP_SDK_DEFINITIONS.find(
    (definition) => definition.nsh?.theme,
  );
  return library?.nsh?.theme?.(accent) ?? tokenTheme(accent);
}

/** `nsh.json` "tailwind" from the UI library, if it has one. */
export function nshTailwind(): Record<string, unknown> | undefined {
  return NATIVE_APP_SDK_DEFINITIONS.find(
    (definition) => definition.nsh?.tailwind,
  )?.nsh?.tailwind;
}

/** The shadcn names NSH types as tokens, filled from the Desk tokens. */
export function tokenTheme(accent: AccentName = DEFAULT_ACCENT): NshTheme {
  const light = tokens.light;
  const primary = tokens.accents[accent];
  const hues = Object.values(tokens.hues);
  return {
    cssVars: {
      theme: {
        radius: `${tokens.radius.md}px`,
      },
      light: {
        ...light,
        primary,
        // shadcn's `accent` is the hover/selected surface, not the brand.
        accent: light.secondary,
        'accent-foreground': light['secondary-foreground'],
        ...Object.fromEntries(
          [0, 1, 2, 3, 4].map((index) => [
            `chart-${index + 1}`,
            hues[index % hues.length],
          ]),
        ),
        sidebar: tokens.surfaces.window,
        'sidebar-foreground': light.foreground,
        'sidebar-primary': primary,
        'sidebar-primary-foreground': light['primary-foreground'],
        'sidebar-accent': light.secondary,
        'sidebar-accent-foreground': light['secondary-foreground'],
        'sidebar-border': light.border,
        'sidebar-ring': light.ring,
      },
    },
  };
}

/** One theme per accent, so a player can follow accent changes locally. */
export function nshThemesByAccent(): Record<AccentName, SdkNshTheme> {
  return Object.fromEntries(
    ACCENT_NAMES.map((accent) => [accent, nshTheme(accent)]),
  ) as Record<AccentName, SdkNshTheme>;
}
