/** Server-only: the instance-wide theme every client applies. */
import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  isAccentName,
  type AccentName,
} from '~/ui/theme/accents';
import { AppError } from '~server/errors';
import {
  getPlatformConfig,
  updatePlatformConfig,
} from '~server/platform-config';
import { publishPlatformEvent } from '~server/platform-events';

export type ThemeState = {
  accent: AccentName;
  defaultAccent: AccentName;
  /** Every accent that can be chosen, in token order. */
  accents: { name: AccentName; color: string }[];
  /** Whether the web dock shows each tile's name under it; off by default. */
  dockLabels: boolean;
};

function themeState(config: {
  accent: AccentName;
  dockLabels: boolean;
}): ThemeState {
  return {
    accent: config.accent,
    defaultAccent: DEFAULT_ACCENT,
    accents: ACCENT_NAMES.map((name) => ({ name, color: ACCENT_COLORS[name] })),
    dockLabels: config.dockLabels,
  };
}

export async function getThemeState(): Promise<ThemeState> {
  return themeState(await getPlatformConfig('ui.theme'));
}

/**
 * Change the instance theme. Each field left out keeps its stored value; at
 * least one must be given. Connected clients are told to re-read the theme.
 */
export async function updateTheme(change: {
  accent?: string;
  dockLabels?: boolean;
}): Promise<ThemeState> {
  if (change.accent === undefined && change.dockLabels === undefined)
    throw new AppError('Give an accent or the dock labels setting.', 400);
  if (change.accent !== undefined && !isAccentName(change.accent))
    throw new AppError(
      `Unknown accent. Use one of: ${ACCENT_NAMES.join(', ')}.`,
      400,
    );
  // Fields left out keep their latest stored value, even when another change
  // to the theme lands at the same moment.
  const next = await updatePlatformConfig('ui.theme', (current) => ({
    accent: (change.accent as AccentName | undefined) ?? current.accent,
    dockLabels: change.dockLabels ?? current.dockLabels,
  }));
  publishPlatformEvent({ type: 'theme.updated', accent: next.accent });
  return themeState(next);
}

/** Choose the accent and keep the other theme settings. */
export function setThemeAccent(accent: string): Promise<ThemeState> {
  return updateTheme({ accent });
}
