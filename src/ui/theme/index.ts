import { cssVariablesResolver } from './cssVariableResolver';
import { deskTheme } from './theme';
import type { CSSVariablesResolver, MantineThemeOverride } from '@mantine/core';

export { ACCENT_CSS, TILE_COLORS, accentRamp, deskThemeFor } from './theme';
export {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  isAccentName,
} from './accents';
export type { AccentName } from './accents';
export { ACCENT_BOOT_SCRIPT, applyAccent, useAccent } from './accent-store';

export const appTheme: MantineThemeOverride = deskTheme;
export const appCssVariablesResolver: CSSVariablesResolver =
  cssVariablesResolver;
