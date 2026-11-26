import { createContext, useContext, type PropsWithChildren } from 'react';
import {
  BUILT_IN_THEMES,
  mobileThemeOf,
  type Accent,
  type MobileTheme,
  type Palette,
  type Status,
} from './theme';

const ThemeContext = createContext<MobileTheme>(
  mobileThemeOf(BUILT_IN_THEMES.light),
);

/**
 * The single place the theme enters the app. Every colour, radius, font and
 * shadow on screen comes from these hooks while rendering, never from module
 * scope, so changing `theme` here restyles everything in place.
 */
export function ThemeProvider({
  theme,
  children,
}: PropsWithChildren<{ theme: MobileTheme }>) {
  return (
    <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): MobileTheme {
  return useContext(ThemeContext);
}

export function usePalette(): Palette {
  return useTheme().palette;
}

export function useStatus(): Status {
  return useTheme().status;
}

/** The accent: the theme's `primary` ramp. */
export function useAccent(): Accent {
  return useTheme().accent;
}

/**
 * Styles that read the theme, built once per theme. Declare them at module
 * scope with `themedStyles((theme) => StyleSheet.create({...}))` and call the
 * returned hook while rendering.
 */
export function themedStyles<T>(build: (theme: MobileTheme) => T): () => T {
  const cache = new WeakMap<MobileTheme, T>();
  return function useThemedStyles() {
    const theme = useTheme();
    let styles = cache.get(theme);
    if (styles === undefined) {
      styles = build(theme);
      cache.set(theme, styles);
    }
    return styles;
  };
}
