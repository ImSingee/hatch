/** Server-only: the instance-wide theme every client applies. */
import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  isAccentName,
  type AccentName,
} from '~/ui/theme/accents';
import { AppError } from '~server/errors';
import { getPlatformConfig, setPlatformConfig } from '~server/platform-config';
import { publishPlatformEvent } from '~server/platform-events';

export type ThemeState = {
  accent: AccentName;
  defaultAccent: AccentName;
  /** Every accent that can be chosen, in token order. */
  accents: { name: AccentName; color: string }[];
};

function themeState(accent: AccentName): ThemeState {
  return {
    accent,
    defaultAccent: DEFAULT_ACCENT,
    accents: ACCENT_NAMES.map((name) => ({ name, color: ACCENT_COLORS[name] })),
  };
}

export async function getThemeState(): Promise<ThemeState> {
  return themeState((await getPlatformConfig('ui.theme')).accent);
}

/** Choose the accent; connected clients are told to re-read the theme. */
export async function setThemeAccent(accent: string): Promise<ThemeState> {
  if (!isAccentName(accent))
    throw new AppError(
      `Unknown accent. Use one of: ${ACCENT_NAMES.join(', ')}.`,
      400,
    );
  await setPlatformConfig('ui.theme', { accent });
  publishPlatformEvent({ type: 'theme.updated', accent });
  return themeState(accent);
}
