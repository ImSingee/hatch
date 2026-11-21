import { cssVariablesResolver } from './cssVariableResolver';
import { deskTheme } from './theme';
import type { CSSVariablesResolver, MantineThemeOverride } from '@mantine/core';

export { TILE_COLORS, accentRamp } from './theme';
export type { AccentName } from './theme';

export const appTheme: MantineThemeOverride = deskTheme;
export const appCssVariablesResolver: CSSVariablesResolver =
  cssVariablesResolver;
