/** Native Apps keep the pre-theme `desk` look and follow resolved themes. */
import { describe, expect, it } from 'vitest';
import tokens from '../../../../packages/hatch-design-tokens/tokens.json';
import golden from '../../../../packages/hatch-design-tokens/test/desk-golden.json';
import {
  contrast,
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
    const library = before[accent].nshLibrary;
    // Added since: the pressed fill of each tone, which on a light theme is
    // the shade its hover always used.
    const pressed = Object.fromEntries(
      ['primary', 'danger', 'warning', 'success', 'info'].map((tone) => [
        `${tone}-pressed`,
        (library.cssVars.light as Record<string, string>)[`${tone}-strong`],
      ]),
    );
    const expected = {
      cssVars: {
        // Added since: a sheet's corner, which iOS and Android set to their
        // own (`@hatch/ui` `platformTheme`); the window's on the web.
        theme: {
          ...library.cssVars.theme,
          'radius-sheet': library.cssVars.theme['radius-window'],
        },
        light: { ...library.cssVars.light, ...pressed },
      },
    };
    expect(buildAppTheme({ accent })).toEqual(expected);
    expect(
      buildAppTheme({
        theme: resolvePreset('desk', tokens.accents[accent]),
      }),
    ).toEqual(expected);
    // Added since: the theme's fonts, so native Apps follow a font change.
    const tokenOnly = before[accent].nshTokens;
    expect(tokenTheme(accent)).toEqual({
      cssVars: {
        theme: {
          ...tokenOnly.cssVars.theme,
          'font-sans': expect.stringMatching(/^Nunito, /),
          'font-mono': expect.stringMatching(/^JetBrains Mono, /),
        },
        light: tokenOnly.cssVars.light,
      },
    });
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

  it('pair the danger fill with the destructive foreground of the theme', () => {
    // A light destructive colour takes dark text; the danger fill must be
    // that same colour, or the label lands on the fixed red.
    const theme = resolveTheme(
      {
        ...THEME_PRESETS.desk.document,
        colors: {
          ...THEME_PRESETS.desk.document.colors,
          destructive: '#FFFF00',
        },
      },
      { name: 'Custom', source: 'custom' },
    );
    for (const built of [buildAppTheme({ theme }), nshThemeFor(theme)]) {
      const light = built.cssVars.light as Record<string, string>;
      expect(light.danger ?? light.destructive).toBe('#FFFF00');
      expect(
        contrast(
          light['destructive-foreground'],
          light.danger ?? light.destructive,
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('carry the theme fonts, so a font change reaches native Apps', () => {
    const system = resolveTheme(
      {
        ...THEME_PRESETS.desk.document,
        fonts: { sans: 'system', mono: 'system' },
      },
      { name: 'Custom', source: 'custom' },
    );
    for (const build of [
      (theme: Parameters<typeof tokenThemeFor>[0]) => buildAppTheme({ theme }),
      tokenThemeFor,
    ]) {
      const desk = build(resolvePreset('desk')).cssVars.theme ?? {};
      const own = build(system).cssVars.theme ?? {};
      expect(desk['font-sans']).toMatch(/^Nunito, /);
      expect(own['font-sans']).not.toContain('Nunito');
      expect(own['font-mono']).not.toContain('JetBrains Mono');
    }
  });
});
