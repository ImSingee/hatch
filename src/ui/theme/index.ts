import { cssVariablesResolver } from './cssVariableResolver';
import { deskTheme } from './theme';
import type { CSSVariablesResolver, MantineThemeOverride } from '@mantine/core';

export { TILE_COLORS, accentRamp, deskThemeFor } from './theme';
export {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  isAccentName,
} from './accents';
export type { AccentName } from './accents';
export { applyAccent, useAccent } from './accent-store';
export {
  THEME_BOOT_SCRIPT,
  activeAppearance,
  applyDocumentTheme,
  applyThemeState,
  useActiveTheme,
  usePrefersDark,
  useSurfaceTheme,
  useThemeState,
} from './theme-store';
export type { SurfaceTheme, WebThemeState } from './theme-store';
export { NATIVE_HOST_BOOT_SCRIPT, useNativeHostDocument } from './native-host';

/** The built-in `desk` theme; the root applies the instance's own. */
export const appTheme: MantineThemeOverride = deskTheme;
export const appCssVariablesResolver: CSSVariablesResolver =
  cssVariablesResolver;
