/** Server-only: theme values as their public RPC messages. */
import type { JsonObject } from '@bufbuild/protobuf';
import type {
  ResolvedTheme,
  ThemeProblem,
} from '../../../packages/hatch-design-tokens/src';
import type { ThemeEntry, ThemeState } from '~server/theme-settings';

export function themeProblemMessage(problem: ThemeProblem) {
  return {
    code: problem.code,
    path: problem.path,
    message: problem.message,
    foreground: problem.pair?.foreground ?? '',
    background: problem.pair?.background ?? '',
    ratio: problem.pair?.ratio ?? 0,
    requiredRatio: problem.pair?.required ?? 0,
  };
}

export function themeEntryMessage(entry: ThemeEntry) {
  return {
    id: entry.id,
    name: entry.name,
    source: entry.source,
    appearance: entry.appearance,
    primary: entry.primary,
    document: entry.document as unknown as JsonObject,
    valid: entry.valid,
    problems: entry.problems.map(themeProblemMessage),
  };
}

export function themeStateMessage(theme: ThemeState) {
  return {
    accent: theme.accent ?? '',
    defaultAccent: theme.defaultAccent,
    accents: theme.accents,
    dockLabels: theme.dockLabels,
    theme: themeEntryMessage(theme.theme),
    accentOverridesPrimary: theme.accentOverridesPrimary,
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
