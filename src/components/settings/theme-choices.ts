/** What the appearance settings show of each theme choice. */
import {
  THEME_PRESETS,
  THEME_PRESET_NAMES,
  type ThemeAppearance,
  type ThemeDocument,
  type ThemePresetName,
} from '../../../packages/hatch-design-tokens/src';
import type { ThemeChoice } from '~server/theme-settings';

/** The document a choice draws: the preset's, or the custom one. */
export function themeChoiceDocument(choice: ThemeChoice): ThemeDocument {
  return choice.preset === null
    ? choice.custom
    : THEME_PRESETS[choice.preset].document;
}

/** The theme's own primary, shown while no accent replaces it. */
export function themeChoicePrimary(choice: ThemeChoice): string {
  return choice.primary;
}

/** The presets that can be the theme of one appearance. */
export function presetsFor(appearance: ThemeAppearance): ThemePresetName[] {
  return THEME_PRESET_NAMES.filter(
    (name) => THEME_PRESETS[name].document.appearance === appearance,
  );
}
