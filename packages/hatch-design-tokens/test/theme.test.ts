import { describe, expect, it } from 'vitest';
import tokens from '../tokens.json';
import {
  CONTRAST_PAIRS,
  HUE_NAMES,
  THEME_COLOR_KEYS,
  THEME_PRESETS,
  THEME_PRESET_NAMES,
  contrast,
  contrastProblems,
  luminance,
  parseColor,
  pressedShade,
  resolvePreset,
  resolveTheme,
  validateThemeDocument,
  type ThemeDocument,
} from '../src';
import golden from './desk-golden.json';

/**
 * `desk-golden.json` is what the web, the native UI library and the mobile
 * app drew before themes became data, captured from that code for every
 * accent. The `desk` preset must keep producing it.
 */
type Golden = (typeof golden)['indigo'];
const goldenFor = (accent: string) =>
  (golden as Record<string, Golden>)[accent];
const ACCENTS = Object.entries(tokens.accents);

/** `#RRGGBB` for a hex or an opaque `rgba(…, 1)` value. */
function hex(value: string): string {
  const rgba = /^rgba\((\d+), (\d+), (\d+), 1\)$/.exec(value);
  const parsed = rgba
    ? { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]) }
    : parseColor(value);
  if (!parsed) throw new Error(`not a colour: ${value}`);
  return `#${[parsed.r, parsed.g, parsed.b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

const deskDocument = THEME_PRESETS.desk.document;

describe('the desk preset', () => {
  it.each(ACCENTS)(
    'reproduces the pre-theme tokens exactly with %s',
    (accent, color) => {
      const theme = resolvePreset('desk', color);
      const before = goldenFor(accent);
      const web = before.web.theme.colors as Record<string, string[]>;
      const shadcn = before.nshTokens.cssVars.light as Record<string, string>;
      const library = before.nshLibrary.cssVars.light as Record<string, string>;

      expect(theme.ramps.primary).toEqual(web.primary.map(hex));
      expect(theme.ramps.neutral).toEqual(web.gray.map(hex));
      for (const hue of HUE_NAMES)
        expect(theme.ramps[hue]).toEqual(web[hue].map(hex));

      for (const key of [
        'background',
        'foreground',
        'card',
        'card-foreground',
        'popover',
        'popover-foreground',
        'primary',
        'primary-foreground',
        'secondary',
        'secondary-foreground',
        'muted',
        'muted-foreground',
        'border',
        'input',
        'ring',
        'destructive',
        'destructive-foreground',
      ] as const)
        expect({ key, value: theme.colors[key] }).toEqual({
          key,
          value: hex(shadcn[key]),
        });

      expect({
        panel: theme.colors['surface-panel'],
        dock: theme.colors['surface-dock'],
        widget: theme.colors['surface-widget'],
        window: theme.colors['surface-window'],
        bubble: theme.colors['surface-bubble'],
        sunken: theme.colors['surface-sunken'],
        hover: theme.colors['surface-hover'],
        pressed: theme.colors['surface-pressed'],
        scrim: theme.colors['surface-scrim'],
        hairline: theme.colors.hairline,
        composer: theme.colors['composer-border'],
        groundAccent: theme.colors['ground-accent'],
        groundWarm: theme.colors['ground-warm'],
        groundFresh: theme.colors['ground-fresh'],
      }).toEqual({
        panel: library['surface-panel'],
        dock: library['surface-dock'],
        widget: library['surface-widget'],
        window: library['surface-window'],
        bubble: library['surface-bubble'],
        sunken: library['surface-sunken'],
        hover: library['surface-hover'],
        pressed: library['surface-pressed'],
        scrim: library.scrim,
        hairline: library.hairline,
        composer: tokens.surfaces.composerBorder,
        groundAccent: library['ground-accent'],
        groundWarm: library['ground-warm'],
        groundFresh: library['ground-fresh'],
      });
      expect(theme.colors['glass-edge']).toBe(hex(before.web.theme.white));
      expect(theme.shadows).toEqual(before.mobile.shadows);
      expect(theme.radius).toEqual(before.mobile.radii);
      expect(theme.fonts).toEqual(before.mobile.fonts);
    },
  );

  it('derives values close to the hand-tuned ones it pins', () => {
    const pinned = resolvePreset('desk');
    const derived = resolveTheme(deskDocument, {
      name: 'desk',
      source: 'custom',
    });
    const distance = (a: string, b: string) => {
      const x = parseColor(a)!;
      const y = parseColor(b)!;
      return Math.max(
        Math.abs(x.r - y.r),
        Math.abs(x.g - y.g),
        Math.abs(x.b - y.b),
      );
    };
    for (const [index, shade] of pinned.ramps.neutral.entries())
      expect(distance(derived.ramps.neutral[index], shade)).toBeLessThanOrEqual(
        12,
      );
    for (const key of Object.keys(THEME_PRESETS.desk.pins!.colors!) as (
      | 'input'
      | 'surface-window'
    )[])
      expect(
        distance(derived.colors[key], pinned.colors[key]),
      ).toBeLessThanOrEqual(12);
  });
});

describe('derivation', () => {
  const cases = THEME_PRESET_NAMES.flatMap((preset) =>
    ACCENTS.map(([accent, color]) => [preset, accent, color] as const),
  );

  it.each(cases)(
    'keeps every text role readable: %s with %s',
    (preset, _accent, color) => {
      const theme = resolvePreset(preset, color);
      expect(contrastProblems(theme)).toEqual([]);
      for (const name of ['primary', ...HUE_NAMES] as const) {
        const ramp = theme.ramps[name];
        // Text and outlines (shade 7) on the ground and on cards.
        for (const surface of ['background', 'card'] as const)
          expect(
            contrast(ramp[7], theme.colors[surface]),
          ).toBeGreaterThanOrEqual(4.5);
        // A light badge: shade-8 text on the shade-1 tint.
        expect(contrast(ramp[8], ramp[1])).toBeGreaterThanOrEqual(4.5);
        // Filled controls carry white text, also while pressed.
        for (const shade of [6, pressedShade(ramp, theme.colors['on-fill'])])
          expect(
            contrast(theme.colors['on-fill'], ramp[shade]),
          ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(THEME_PRESET_NAMES)(
    'orders every %s ramp from the surface to the ink',
    (preset) => {
      const theme = resolvePreset(preset);
      const towardsInk = theme.appearance === 'light' ? -1 : 1;
      for (const ramp of Object.values(theme.ramps))
        for (let shade = 1; shade < ramp.length; shade += 1)
          expect(
            Math.sign(luminance(ramp[shade]) - luminance(ramp[shade - 1])),
          ).toBe(towardsInk);
    },
  );

  it('steps a pressed fill away from its label, also for a pale primary', () => {
    for (const [document, primary] of [
      [THEME_PRESETS['desk-dark'].document, '#818181'],
      [deskDocument, '#FACC15'],
      [deskDocument, '#3F51C7'],
    ] as const) {
      const theme = resolveTheme(document, {
        name: 'x',
        source: 'custom',
        accent: primary,
      });
      const label = theme.colors['primary-foreground'];
      const ramp = theme.ramps.primary;
      expect(
        contrast(label, ramp[pressedShade(ramp, label)]),
      ).toBeGreaterThanOrEqual(contrast(label, ramp[6]));
    }
    // Desk keeps the shade it always used: darker under white text.
    const desk = resolvePreset('desk');
    expect(pressedShade(desk.ramps.primary, '#FFFFFF')).toBe(7);
    expect(
      pressedShade(resolvePreset('desk-dark').ramps.primary, '#FFFFFF'),
    ).toBe(5);
  });

  it('replaces primary with the accent and derives its pair from it', () => {
    const theme = resolvePreset('desk-dark', tokens.accents.teal);
    expect(theme.colors.primary).toBe(tokens.accents.teal);
    expect(theme.ramps.primary[6]).toBe(tokens.accents.teal);
    expect(theme.appearance).toBe('dark');
    // A light primary gets dark text.
    const yellow = resolveTheme(deskDocument, {
      name: 'x',
      source: 'custom',
      accent: '#FACC15',
    });
    expect(yellow.colors['primary-foreground']).toBe(tokens.light.foreground);
  });

  it('scales every radius from the base and reads fonts from the document', () => {
    const square = resolveTheme(
      { ...deskDocument, radius: 0, fonts: { sans: 'system', mono: 'system' } },
      { name: 'x', source: 'custom' },
    );
    expect(Object.values(square.radius)).toEqual(
      Object.values(tokens.radius).map(() => 0),
    );
    expect(square.fonts).toEqual({ sans: 'system', mono: 'system' });
    const round = resolveTheme(
      { ...deskDocument, radius: 24 },
      { name: 'x', source: 'custom' },
    );
    expect(round.radius.md).toBe(24);
    expect(round.radius.xs).toBe(12);
  });
});

describe('validation', () => {
  const valid: ThemeDocument = {
    name: 'Forest',
    appearance: 'dark',
    colors: {
      background: '#0F1A14',
      foreground: '#E6F0E9',
      card: '#17241C',
      primary: '#2F7D4F',
      secondary: '#1F2E25',
      muted: '#1F2E25',
      'muted-foreground': '#A5B8AC',
      border: '#2A3A30',
      destructive: '#B91C1C',
    },
    radius: 8,
    fonts: { sans: 'Nunito', mono: 'JetBrains Mono' },
  };

  it('accepts a complete document and normalises its colours', () => {
    const result = validateThemeDocument({
      ...valid,
      colors: { ...valid.colors, card: 'rgb(23 36 28)', border: '#2a3a30' },
    });
    expect(result).toEqual({ ok: true, document: valid });
  });

  it('fills radius and fonts from desk when they are left out', () => {
    const { radius: _radius, fonts: _fonts, name: _name, ...rest } = valid;
    expect(validateThemeDocument(rest)).toEqual({
      ok: true,
      document: { ...rest, radius: 12, fonts: deskDocument.fonts },
    });
  });

  it('rejects unknown keys, missing or unparsable colours and fonts it does not bundle', () => {
    const result = validateThemeDocument({
      ...valid,
      shadow: 'big',
      colors: {
        ...valid.colors,
        primary: 'teal',
        border: '#2A3A3080',
        ring: '#FFFFFF',
        muted: undefined,
      },
      fonts: { sans: 'Comic Sans MS', mono: 'JetBrains Mono', serif: 'x' },
      radius: 64,
      appearance: 'sepia',
    });
    expect(result.ok).toBe(false);
    expect(
      !result.ok && result.problems.map(({ code, path }) => `${code} ${path}`),
    ).toEqual(
      expect.arrayContaining([
        'unknown_key shadow',
        'invalid_value appearance',
        'unknown_key colors.ring',
        'invalid_color colors.primary',
        'invalid_color colors.border',
        'missing_key colors.muted',
        'invalid_value radius',
        'unknown_key fonts.serif',
        'unknown_font fonts.sans',
      ]),
    );
    expect(validateThemeDocument([]).ok).toBe(false);
    expect(validateThemeDocument({}).ok).toBe(false);
  });

  it('rejects text below 4.5:1, naming the pair and its ratio', () => {
    const result = validateThemeDocument({
      ...valid,
      colors: { ...valid.colors, 'muted-foreground': '#4A5A50' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.problems.every((problem) => problem.code === 'low_contrast'),
    ).toBe(true);
    const pair = result.problems.find(
      (problem) =>
        problem.pair?.foreground === 'muted-foreground' &&
        problem.pair.background === 'background',
    );
    expect(pair?.pair?.ratio).toBeLessThan(4.5);
    expect(pair?.message).toBe(
      `muted-foreground on background has a contrast of ${pair?.pair?.ratio}:1; it needs at least 4.5:1.`,
    );
  });

  it('rejects a colour whose label is unreadable on its own tints', () => {
    // Readable as a fill and as error text, but the mobile danger button
    // keeps shade 8 on shade 2 while pressed (3.99:1).
    const desk = THEME_PRESETS.desk.document;
    const result = validateThemeDocument({
      ...desk,
      colors: { ...desk.colors, destructive: '#FF55EE' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.pair)).toContainEqual(
      expect.objectContaining({
        foreground: 'destructive-ink',
        background: 'destructive-tint-strong',
      }),
    );
  });

  it('rejects a destructive colour whose text shade is unreadable on the card', () => {
    // Error text itself reads (shade 8 is picked), but native Apps draw
    // field errors and destructive menu items in shade 7 (2.70:1 here).
    const dark = THEME_PRESETS['desk-dark'].document;
    const result = validateThemeDocument({
      ...dark,
      colors: { ...dark.colors, destructive: '#000000' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.pair)).toContainEqual(
      expect.objectContaining({
        foreground: 'destructive-strong',
        background: 'card',
      }),
    );
  });

  it('checks each named pair, including the derived text on primary', () => {
    expect(CONTRAST_PAIRS.slice(0, 4)).toEqual([
      ['foreground', 'background'],
      ['foreground', 'card'],
      ['muted-foreground', 'background'],
      ['primary-foreground', 'primary'],
    ]);
    // Neither white nor the theme's ink reads on a mid grey.
    const result = validateThemeDocument({
      ...valid,
      colors: { ...valid.colors, primary: '#777777' },
    });
    expect(
      !result.ok &&
        result.problems.some(
          (problem) =>
            problem.pair?.foreground === 'primary-foreground' &&
            problem.pair.background === 'primary',
        ),
    ).toBe(true);
  });

  it('checks the effective primary when an accent replaces it', () => {
    const light = { ...valid, appearance: 'light' as const };
    const pale = {
      ...light,
      colors: {
        ...light.colors,
        background: '#FFFFFF',
        foreground: '#111111',
        card: '#FFFFFF',
        secondary: '#F2F2F2',
        muted: '#F2F2F2',
        'muted-foreground': '#555555',
        border: '#E5E5E5',
      },
    };
    expect(validateThemeDocument(pale).ok).toBe(true);
    // A pale accent cannot carry link text on white.
    const result = validateThemeDocument(pale, { accent: '#9CC7FF' });
    expect(result.ok).toBe(false);
    expect(
      !result.ok &&
        result.problems.every((problem) =>
          problem.message.startsWith('With the accent:'),
        ),
    ).toBe(true);
  });

  it('checks the destructive colour as error text on the ground and cards', () => {
    // Desk's red reads as text; desk-dark draws a lighter shade of it.
    expect(resolvePreset('desk').colors['destructive-text']).toBe(
      tokens.light.destructive,
    );
    const dark = resolvePreset('desk-dark');
    expect(dark.colors['destructive-text']).not.toBe(tokens.dark.destructive);
    for (const surface of ['background', 'card'] as const)
      expect(
        contrast(dark.colors['destructive-text'], dark.colors[surface]),
      ).toBeGreaterThanOrEqual(4.5);
    // A yellow destructive cannot carry error text on a light theme.
    const result = validateThemeDocument({
      ...deskDocument,
      colors: { ...deskDocument.colors, destructive: '#FFFF00' },
    });
    expect(
      !result.ok &&
        result.problems.map((problem) =>
          [problem.pair?.foreground, problem.pair?.background].join(' on '),
        ),
    ).toEqual(
      expect.arrayContaining([
        'destructive-text on background',
        'destructive-text on card',
      ]),
    );
  });

  it('accepts every preset document', () => {
    for (const name of THEME_PRESET_NAMES)
      expect(validateThemeDocument(THEME_PRESETS[name].document).ok).toBe(true);
    expect(THEME_COLOR_KEYS).toHaveLength(9);
  });
});
