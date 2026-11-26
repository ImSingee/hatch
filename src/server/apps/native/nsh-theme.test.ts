/** Native Apps keep the pre-theme `desk` look and follow resolved themes. */
import { describe, expect, it } from 'vitest';
import tokens from '../../../../packages/hatch-design-tokens/tokens.json';
import golden from '../../../../packages/hatch-design-tokens/test/desk-golden.json';
import {
  resolvePreset,
  resolveTheme,
  THEME_PRESETS,
} from '../../../../packages/hatch-design-tokens/src';
import { buildAppTheme } from '../../../../sdk-internal/ui/theme/build';
import type { AccentName } from '../../../ui/theme/accents';
import { nshThemeFor, tokenTheme, tokenThemeFor } from './nsh-theme';

const ACCENTS = Object.keys(tokens.accents) as AccentName[];
const before = golden as Record<string, (typeof golden)['indigo']>;

describe('native App themes', () => {
  it.each(ACCENTS)('match the pre-theme desk output with %s', (accent) => {
    expect(buildAppTheme({ accent })).toEqual(before[accent].nshLibrary);
    expect(tokenTheme(accent)).toEqual(before[accent].nshTokens);
    expect(
      buildAppTheme({
        theme: resolvePreset('desk', tokens.accents[accent]),
      }),
    ).toEqual(before[accent].nshLibrary);
  });

  it('name the same tokens in every theme, since setTheme replaces the whole theme', () => {
    const custom = resolveTheme(
      {
        ...THEME_PRESETS.desk.document,
        radius: 4,
        fonts: { sans: 'system', mono: 'system' },
      },
      { name: 'Custom', source: 'custom' },
    );
    for (const build of [
      (theme: Parameters<typeof tokenThemeFor>[0]) => buildAppTheme({ theme }),
      tokenThemeFor,
      nshThemeFor,
    ]) {
      const desk = build(resolvePreset('desk'));
      for (const theme of [resolvePreset('desk-dark'), custom]) {
        const other = build(theme);
        expect(Object.keys(other.cssVars.light ?? {}).sort()).toEqual(
          Object.keys(desk.cssVars.light ?? {}).sort(),
        );
        expect(Object.keys(other.cssVars.theme ?? {}).sort()).toEqual(
          Object.keys(desk.cssVars.theme ?? {}).sort(),
        );
      }
    }
  });

  it('draw a dark theme in its own colours', () => {
    const dark = buildAppTheme({ theme: resolvePreset('desk-dark') });
    expect(dark.cssVars.light.background).toBe(tokens.dark.background);
    expect(dark.cssVars.light.foreground).toBe(tokens.dark.foreground);
    expect(
      nshThemeFor(resolvePreset('desk-dark')).cssVars.light?.background,
    ).toBe(tokens.dark.background);
  });
});
