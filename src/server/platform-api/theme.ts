/** Server-only: theme values as their public RPC messages. */
import type { JsonObject } from '@bufbuild/protobuf';
import type { ResolvedTheme } from '../../../packages/hatch-design-tokens/src';
import type { ThemeChoice, ThemeState } from '~server/theme-settings';

function choiceMessage(choice: ThemeChoice) {
  return {
    appearance: choice.appearance,
    preset: choice.preset ?? '',
    custom:
      choice.preset === null
        ? (choice.custom as unknown as JsonObject)
        : undefined,
    name: choice.name,
    primary: choice.primary,
  };
}

export function themeStateMessage(theme: ThemeState) {
  return {
    accent: theme.accent ?? '',
    defaultAccent: theme.defaultAccent,
    accents: theme.accents,
    dockLabels: theme.dockLabels,
    mode: theme.mode,
    light: choiceMessage(theme.light),
    dark: choiceMessage(theme.dark),
    accentOverrides: theme.accentOverrides,
  };
}

export function resolvedThemeMessage(theme: ResolvedTheme) {
  return {
    appearance: theme.appearance,
    name: theme.name,
    source: theme.source,
    colors: theme.colors,
    ramps: Object.fromEntries(
      Object.entries(theme.ramps).map(([name, shades]) => [name, { shades }]),
    ),
    radius: theme.radius,
    fonts: theme.fonts,
    shadows: theme.shadows,
  };
}
