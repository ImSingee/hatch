/** Server-only: the instance-wide theme every client applies. */
import {
  THEME_APPEARANCES,
  THEME_PRESETS,
  THEME_PRESET_NAMES,
  contrastProblems,
  isThemePresetName,
  normalizeColor,
  resolvePreset,
  resolveTheme,
  validateThemeDocument,
  type ResolvedTheme,
  type ThemeAppearance,
  type ThemeDocument,
  type ThemeMode,
  type ThemePresetName,
  type ThemeProblem,
} from '../../packages/hatch-design-tokens/src';
import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  isAccentName,
  type AccentName,
} from '~/ui/theme/accents';
import { AppError } from '~server/errors';
import { ThemeValidationError } from '~server/theme-errors';
import {
  getPlatformConfig,
  updatePlatformConfig,
  DEFAULT_UI_THEME,
  type ThemeChoiceConfig,
  type UiThemeConfig,
} from '~server/platform-config';
import { publishPlatformEvent } from '~server/platform-events';

/** The theme one appearance uses. */
export type ThemeChoice = (
  | { appearance: ThemeAppearance; preset: ThemePresetName; name: string }
  | {
      appearance: ThemeAppearance;
      preset: null;
      custom: ThemeDocument;
      name: string;
    }
) & {
  /** The theme's own primary (`#RRGGBB`), shown while no accent is chosen. */
  primary: string;
};

export type ThemeState = {
  /** null: no accent, each theme's own `primary` shows. */
  accent: AccentName | null;
  defaultAccent: AccentName;
  /** Every accent that can be chosen, in token order. */
  accents: { name: AccentName; color: string }[];
  /** Whether the web dock shows each tile's name under it; off by default. */
  dockLabels: boolean;
  mode: ThemeMode;
  light: ThemeChoice;
  dark: ThemeChoice;
  /**
   * Appearances whose theme has its own primary that the chosen accent
   * replaces; empty while no accent is chosen or the colours agree.
   */
  accentOverrides: ThemeAppearance[];
};

function choiceOf(
  appearance: ThemeAppearance,
  stored: ThemeChoiceConfig,
): ThemeChoice {
  return typeof stored === 'string'
    ? {
        appearance,
        preset: stored,
        name: THEME_PRESETS[stored].document.name ?? stored,
        primary: normalizeColor(THEME_PRESETS[stored].document.colors.primary),
      }
    : {
        appearance,
        preset: null,
        custom: stored,
        name: stored.name ?? 'Custom',
        primary: normalizeColor(stored.colors.primary),
      };
}

function themeState(config: UiThemeConfig): ThemeState {
  const light = choiceOf('light', config.light);
  const dark = choiceOf('dark', config.dark);
  const accent = accentColor(config.accent);
  return {
    accent: config.accent,
    defaultAccent: DEFAULT_ACCENT,
    accents: ACCENT_NAMES.map((name) => ({ name, color: ACCENT_COLORS[name] })),
    dockLabels: config.dockLabels,
    mode: config.mode,
    light,
    dark,
    accentOverrides: accent
      ? [light, dark]
          .filter((choice) => choice.primary !== normalizeColor(accent))
          .map((choice) => choice.appearance)
      : [],
  };
}

function accentColor(accent: AccentName | null): string | null {
  return accent ? ACCENT_COLORS[accent] : null;
}

/** Every token of one appearance's theme, with the accent applied. */
export function resolveChoice(
  stored: ThemeChoiceConfig,
  accent: AccentName | null,
): ResolvedTheme {
  return typeof stored === 'string'
    ? resolvePreset(stored, accentColor(accent))
    : resolveTheme(stored, {
        name: stored.name ?? 'Custom',
        source: 'custom',
        accent: accentColor(accent),
      });
}

export async function getThemeState(): Promise<ThemeState> {
  return themeState(await getPlatformConfig('ui.theme'));
}

/** The theme with each requested appearance resolved. */
export async function getTheme(resolve: readonly ThemeAppearance[] = []) {
  const config = await getPlatformConfig('ui.theme');
  return {
    theme: themeState(config),
    resolved: resolve.map((appearance) =>
      resolveChoice(config[appearance], config.accent),
    ),
  };
}

/** The appearance a client in `mode` draws, given what its device prefers. */
export function appearanceFor(
  mode: ThemeMode,
  prefers: ThemeAppearance,
): ThemeAppearance {
  return mode === 'system' ? prefers : mode;
}

export type ThemeChange = {
  /** An accent name, or null to clear it. */
  accent?: string | null;
  dockLabels?: boolean;
  mode?: string;
  /** Replaces one appearance's theme. */
  theme?: {
    appearance: string;
    preset?: string;
    /** A custom theme document, checked here. */
    custom?: unknown;
  };
};

function badRequest(message: string): AppError {
  return new AppError(message, 400);
}

/** Check a change and turn it into stored values; throws on any problem. */
function readChange(change: ThemeChange): {
  accent?: AccentName | null;
  dockLabels?: boolean;
  mode?: ThemeMode;
  theme?: { appearance: ThemeAppearance; choice: ThemeChoiceConfig };
} {
  if (
    change.accent === undefined &&
    change.dockLabels === undefined &&
    change.mode === undefined &&
    change.theme === undefined
  )
    throw badRequest(
      'Give an accent, the dock labels setting, a mode or a theme for an appearance.',
    );
  if (
    change.accent !== undefined &&
    change.accent !== null &&
    !isAccentName(change.accent)
  )
    throw badRequest(`Unknown accent. Use one of: ${ACCENT_NAMES.join(', ')}.`);
  if (
    change.mode !== undefined &&
    !(['light', 'dark', 'system'] as const).includes(change.mode as ThemeMode)
  )
    throw badRequest('Unknown mode. Use light, dark or system.');

  let theme:
    | { appearance: ThemeAppearance; choice: ThemeChoiceConfig }
    | undefined;
  if (change.theme) {
    const { appearance, preset, custom } = change.theme;
    if (!(THEME_APPEARANCES as readonly string[]).includes(appearance))
      throw badRequest('Unknown appearance. Use light or dark.');
    const target = appearance as ThemeAppearance;
    if ((preset === undefined) === (custom === undefined))
      throw badRequest('Give exactly one of a preset and a custom theme.');
    if (preset !== undefined) {
      if (!isThemePresetName(preset))
        throw badRequest(
          `Unknown preset. Use one of: ${THEME_PRESET_NAMES.join(', ')}.`,
        );
      if (THEME_PRESETS[preset].document.appearance !== target)
        throw badRequest(
          `${preset} is a ${THEME_PRESETS[preset].document.appearance} theme; it cannot be the ${target} theme.`,
        );
      theme = { appearance: target, choice: preset };
    } else {
      const result = validateThemeDocument(custom);
      if (!result.ok) throw new ThemeValidationError(result.problems);
      if (result.document.appearance !== target)
        throw new ThemeValidationError([
          {
            code: 'invalid_value',
            path: 'appearance',
            message: `The document's appearance is ${result.document.appearance}; it cannot be the ${target} theme.`,
          },
        ]);
      theme = { appearance: target, choice: result.document };
    }
  }
  return {
    ...(change.accent === undefined
      ? {}
      : { accent: change.accent as AccentName | null }),
    ...(change.dockLabels === undefined
      ? {}
      : { dockLabels: change.dockLabels }),
    ...(change.mode === undefined ? {} : { mode: change.mode as ThemeMode }),
    ...(theme ? { theme } : {}),
  };
}

/**
 * Text must stay readable with the accent that will be drawn: a new custom
 * theme under the current accent, or a new accent over each custom theme.
 */
function checkEffectiveContrast(config: UiThemeConfig): void {
  const problems: ThemeProblem[] = [];
  for (const appearance of THEME_APPEARANCES) {
    const stored = config[appearance];
    if (typeof stored === 'string') continue;
    for (const problem of contrastProblems(
      resolveChoice(stored, config.accent),
    ))
      problems.push({
        ...problem,
        message: `In the ${appearance} theme with the ${config.accent ?? 'theme'} accent: ${problem.message}`,
      });
  }
  if (problems.length) throw new ThemeValidationError(problems);
}

/**
 * Change the instance theme. Each field left out keeps its stored value; at
 * least one must be given. Connected clients are told to re-read the theme.
 */
export async function updateTheme(change: ThemeChange): Promise<ThemeState> {
  const checked = readChange(change);
  // Fields left out keep their latest stored value, even when another change
  // to the theme lands at the same moment.
  const next = await updatePlatformConfig('ui.theme', (current) => {
    const value: UiThemeConfig = {
      accent: checked.accent === undefined ? current.accent : checked.accent,
      dockLabels: checked.dockLabels ?? current.dockLabels,
      mode: checked.mode ?? current.mode,
      light: current.light,
      dark: current.dark,
    };
    if (checked.theme) value[checked.theme.appearance] = checked.theme.choice;
    if (checked.accent !== undefined || checked.theme)
      checkEffectiveContrast(value);
    return value;
  });
  publishThemeUpdated(next);
  return themeState(next);
}

function publishThemeUpdated(config: UiThemeConfig): void {
  // `accent` stays in the event for clients that only know accents.
  publishPlatformEvent({
    type: 'theme.updated',
    accent: config.accent ?? DEFAULT_ACCENT,
  });
}

/**
 * Back to `desk` and `desk-dark`, light mode and no accent (each theme's own
 * primary; `desk`'s is the default accent); keeps dock labels.
 */
export async function resetTheme(): Promise<ThemeState> {
  const next = await updatePlatformConfig('ui.theme', (current) => ({
    ...DEFAULT_UI_THEME,
    dockLabels: current.dockLabels,
  }));
  publishThemeUpdated(next);
  return themeState(next);
}

/** Choose the accent and keep the other theme settings. */
export function setThemeAccent(accent: string): Promise<ThemeState> {
  return updateTheme({ accent });
}

export type ThemePresetInfo = {
  name: ThemePresetName;
  appearance: ThemeAppearance;
  document: ThemeDocument;
};

export function listThemePresets(): ThemePresetInfo[] {
  return THEME_PRESET_NAMES.map((name) => ({
    name,
    appearance: THEME_PRESETS[name].document.appearance,
    document: THEME_PRESETS[name].document,
  }));
}

/** Check a document without saving it; optionally with the current accent. */
export async function validateTheme(
  document: unknown,
  options: { withCurrentAccent?: boolean } = {},
): Promise<
  | { ok: true; problems: []; resolved: ResolvedTheme }
  | { ok: false; problems: ThemeProblem[]; resolved: null }
> {
  const accent = options.withCurrentAccent
    ? (await getPlatformConfig('ui.theme')).accent
    : null;
  const result = validateThemeDocument(document, {
    accent: accentColor(accent),
  });
  if (!result.ok)
    return { ok: false, problems: result.problems, resolved: null };
  return {
    ok: true,
    problems: [],
    resolved: resolveChoice(result.document, accent),
  };
}
