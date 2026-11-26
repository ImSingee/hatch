import { describe, expect, it } from 'vitest';
import tokens from '../../../packages/hatch-design-tokens/tokens.json';
import golden from '../../../packages/hatch-design-tokens/test/desk-golden.json';
import {
  THEME_PRESET_NAMES,
  contrast,
  resolvePreset,
} from '../../../packages/hatch-design-tokens/src';
import { mobileThemeOf, tileLight, tiles } from './theme';

const ACCENTS = Object.entries(tokens.accents);
const before = golden as Record<string, (typeof golden)['indigo']>;

// What the app drew from the token file before themes became data, for
// every accent: the `desk` theme keeps drawing exactly that.
describe('the desk theme on mobile', () => {
  it.each(ACCENTS)('matches the pre-theme palette with %s', (name, color) => {
    const theme = mobileThemeOf(resolvePreset('desk', color));
    const old = before[name].mobile;
    expect(theme.accent).toEqual(old.accent);
    // `onTile` is new: the white monogram tiles always carried.
    expect(theme.palette).toEqual({
      ...old.palette,
      onTile: old.palette.onFill,
    });
    expect(theme.status).toEqual(old.status);
    expect(theme.shadows).toEqual(old.shadows);
    expect(theme.radii).toEqual(old.radii);
    expect(theme.fonts).toEqual(old.fonts);
    expect(tileLight).toBe(old.tileLight);
  });
});

// Guards that whatever a preset holds stays readable in the pairings the
// native app actually draws, in light and in dark.
describe.each(THEME_PRESET_NAMES)(
  'mobile readable color contract: %s',
  (preset) => {
    const themes = ACCENTS.map(([name, color]) => ({
      name,
      theme: mobileThemeOf(resolvePreset(preset, color)),
    }));
    const { palette: c, status } = themes[0].theme;

    it.each([c.ground, c.card, c.muted, c.sunken])(
      'keeps body, secondary and error text readable on %s',
      (surface) => {
        for (const ink of [c.ink, c.inkSoft, status.danger.ink])
          expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(themes)('keeps the $name accent readable', ({ theme }) => {
      const { accent } = theme;
      // Filled buttons, the user's chat bubble, the selected conversation.
      expect(contrast(accent.onFill, accent.fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent.onFill, accent.pressed)).toBeGreaterThanOrEqual(
        4.5,
      );
      // Links and quiet buttons on every surface, and labels on the tint.
      for (const surface of [c.ground, c.card, c.muted, accent.tint])
        expect(contrast(accent.ink, surface)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(themes)(
      'keeps text readable on the ground shapes with $name',
      ({ theme }) => {
        // Page titles, dates and tile labels lie directly on the shapes.
        for (const shape of [theme.accent.ground, c.groundWarm, c.groundFresh])
          for (const ink of [c.ink, c.inkSoft, theme.accent.ink])
            expect(contrast(ink, shape)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(Object.entries(status))('keeps %s chips readable', (_name, hue) => {
      expect(contrast(hue.ink, hue.tint)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hue.ink, hue.tintStrong)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(tiles)('keeps the monogram readable on tile %s', (tile) => {
      expect(contrast(c.onTile, tile)).toBeGreaterThanOrEqual(4.5);
    });
  },
);
