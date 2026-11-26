import { beforeEach, describe, expect, it, vi } from 'vitest';
import tokens from '../../packages/hatch-design-tokens/tokens.json';
import { resolvePreset } from '../../packages/hatch-design-tokens/src';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  getTheme,
  getThemeState,
  resetTheme,
  setThemeAccent,
  updateTheme,
  validateTheme,
} = await import('./theme-settings');
const { subscribePlatformEvents } = await import('./platform-events');

beforeEach(async () => {
  await db.delete(schema.platformConfig);
});

describe('instance theme', () => {
  it('starts with no accent, desk showing the default accent colour, and offers every token accent', async () => {
    const state = await getThemeState();
    expect(state.accent).toBeNull();
    expect(state.light.primary).toBe(
      tokens.accents[tokens.defaultAccent as keyof typeof tokens.accents],
    );
    expect(state.accentOverrides).toEqual([]);
    expect(state.defaultAccent).toBe(tokens.defaultAccent);
    expect(state.accents).toEqual(
      Object.entries(tokens.accents).map(([name, color]) => ({ name, color })),
    );
  });

  it('stores a chosen accent and tells connected clients', async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      const other = Object.keys(tokens.accents).find(
        (name) => name !== tokens.defaultAccent,
      )!;
      expect((await setThemeAccent(other)).accent).toBe(other);
      expect((await getThemeState()).accent).toBe(other);
      expect(events).toEqual([{ type: 'theme.updated', accent: other }]);
    } finally {
      unsubscribe();
    }
  });

  it('rejects an accent the tokens do not define and keeps the stored one', async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      for (const accent of ['orange', '', 'toString', 'Indigo'])
        await expect(setThemeAccent(accent)).rejects.toMatchObject({
          status: 400,
        });
      expect((await getThemeState()).accent).toBeNull();
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('falls back to the default accent when the stored one is no longer defined', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await db.insert(schema.platformConfig).values({
        key: 'ui.theme',
        value: { accent: 'retired-accent', dockLabels: true },
      });
      const state = await getThemeState();
      expect(state.accent).toBe(tokens.defaultAccent);
      // The other setting survives the retired accent.
      expect(state.dockLabels).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('hides dock names by default and changes them without touching the accent', async () => {
    const other = Object.keys(tokens.accents).find(
      (name) => name !== tokens.defaultAccent,
    )!;
    // A row written before dock names existed.
    await db
      .insert(schema.platformConfig)
      .values({ key: 'ui.theme', value: { accent: other } });
    expect(await getThemeState()).toMatchObject({
      accent: other,
      dockLabels: false,
    });

    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      expect(await updateTheme({ dockLabels: true })).toMatchObject({
        accent: other,
        dockLabels: true,
      });
      expect(await setThemeAccent(tokens.defaultAccent)).toMatchObject({
        accent: tokens.defaultAccent,
        dockLabels: true,
      });
      expect(events).toHaveLength(2);
      await expect(updateTheme({})).rejects.toMatchObject({ status: 400 });
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('keeps both of two theme changes made at the same moment', async () => {
    const other = Object.keys(tokens.accents).find(
      (name) => name !== tokens.defaultAccent,
    )!;
    await Promise.all([
      updateTheme({ accent: other }),
      updateTheme({ dockLabels: true }),
    ]);
    expect(await getThemeState()).toMatchObject({
      accent: other,
      dockLabels: true,
    });
  });
});

/** A valid custom light theme; invented values. */
const meadow = {
  name: 'Meadow',
  appearance: 'light',
  colors: {
    background: '#F3F6EF',
    foreground: '#1C2A1F',
    card: '#FFFFFF',
    primary: '#2F6B3A',
    secondary: '#E8EFE3',
    muted: '#E8EFE3',
    'muted-foreground': '#4B5B4E',
    border: '#D9E3D3',
    destructive: '#B91C1C',
  },
  radius: 6,
  fonts: { sans: 'Nunito', mono: 'JetBrains Mono' },
};

describe('instance theme: modes, presets and custom themes', () => {
  it('reads light mode with the desk presets, also from rows that only know the accent', async () => {
    const defaults = {
      mode: 'light',
      light: { appearance: 'light', preset: 'desk', name: 'Desk' },
      dark: { appearance: 'dark', preset: 'desk-dark', name: 'Desk dark' },
    };
    expect(await getThemeState()).toMatchObject(defaults);
    await db
      .insert(schema.platformConfig)
      .values({ key: 'ui.theme', value: { accent: 'teal' } });
    expect(await getThemeState()).toMatchObject({
      accent: 'teal',
      ...defaults,
    });
  });

  it('falls back field by field when a stored theme is no longer valid', async () => {
    await db.insert(schema.platformConfig).values({
      key: 'ui.theme',
      value: {
        accent: 'clay',
        mode: 'sepia',
        // A preset of the wrong appearance, then a document that fails
        // contrast: each slot falls back to its own preset.
        light: 'desk-dark',
        dark: { ...meadow, appearance: 'dark' },
      },
    });
    expect(await getThemeState()).toMatchObject({
      accent: 'clay',
      mode: 'light',
      light: { preset: 'desk' },
      dark: { preset: 'desk-dark' },
    });
  });

  it('changes mode, presets and custom themes, keeping what is left out', async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      await updateTheme({ accent: 'teal', dockLabels: true });
      const custom = await updateTheme({
        mode: 'system',
        theme: { appearance: 'light', custom: meadow },
      });
      expect(custom).toMatchObject({
        accent: 'teal',
        dockLabels: true,
        mode: 'system',
        light: { preset: null, custom: meadow, name: 'Meadow' },
        dark: { preset: 'desk-dark' },
      });
      // A preset replaces the custom theme of its appearance only.
      expect(
        await updateTheme({ theme: { appearance: 'light', preset: 'desk' } }),
      ).toMatchObject({ mode: 'system', light: { preset: 'desk' } });
      expect(events).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });

  it('resolves each requested appearance with the accent replacing primary', async () => {
    await updateTheme({ theme: { appearance: 'light', custom: meadow } });
    await updateTheme({ accent: null });
    let { resolved } = await getTheme(['light', 'dark']);
    expect(resolved.map((theme) => [theme.appearance, theme.name])).toEqual([
      ['light', 'Meadow'],
      ['dark', 'desk-dark'],
    ]);
    expect(resolved[0].colors.primary).toBe(meadow.colors.primary);
    await setThemeAccent('violet');
    ({ resolved } = await getTheme(['dark']));
    expect(resolved[0].colors.primary).toBe(tokens.accents.violet);
    expect((await getTheme()).resolved).toEqual([]);
  });

  it('rejects unusable changes and keeps the stored theme', async () => {
    const before = await getThemeState();
    for (const change of [
      { mode: 'dim' },
      { theme: { appearance: 'sepia', preset: 'desk' } },
      { theme: { appearance: 'light' } },
      { theme: { appearance: 'light', preset: 'desk', custom: meadow } },
      { theme: { appearance: 'light', preset: 'nope' } },
      // A dark preset cannot be the light theme, nor a light document the
      // dark one.
      { theme: { appearance: 'light', preset: 'desk-dark' } },
      { theme: { appearance: 'dark', custom: meadow } },
      { theme: { appearance: 'light', custom: { ...meadow, glow: true } } },
    ])
      await expect(updateTheme(change)).rejects.toMatchObject({ status: 400 });
    const lowContrast = updateTheme({
      theme: {
        appearance: 'light',
        custom: {
          ...meadow,
          colors: { ...meadow.colors, 'muted-foreground': '#9AA79C' },
        },
      },
    });
    await expect(lowContrast).rejects.toMatchObject({
      status: 400,
      code: 'theme_invalid',
      message: expect.stringContaining(
        'muted-foreground on background has a contrast of',
      ),
    });
    expect(await getThemeState()).toEqual(before);
  });

  it('checks contrast with the accent that will be drawn, in both directions', async () => {
    // A mid-grey ground: the theme's own deep green reads as link text on
    // it, the teal accent does not.
    const stone = {
      ...meadow,
      name: 'Stone',
      colors: {
        ...meadow.colors,
        background: '#ABABAB',
        foreground: '#000000',
        primary: '#1B3D22',
        secondary: '#C8C8C8',
        muted: '#C8C8C8',
        'muted-foreground': '#1A1A1A',
        border: '#999999',
      },
    };
    expect((await validateTheme(stone)).ok).toBe(true);
    await updateTheme({ accent: null });
    await updateTheme({ theme: { appearance: 'light', custom: stone } });
    // An accent over the custom theme.
    await expect(setThemeAccent('teal')).rejects.toMatchObject({
      code: 'theme_invalid',
      message: expect.stringContaining(
        'In the light theme with the teal accent: primary-text on background',
      ),
    });
    expect((await getThemeState()).accent).toBeNull();
    // The custom theme under an accent.
    await updateTheme({ theme: { appearance: 'light', preset: 'desk' } });
    await setThemeAccent('teal');
    await expect(
      updateTheme({ theme: { appearance: 'light', custom: stone } }),
    ).rejects.toMatchObject({ code: 'theme_invalid' });
    expect((await getThemeState()).light).toMatchObject({ preset: 'desk' });
    expect((await validateTheme(stone, { withCurrentAccent: true })).ok).toBe(
      false,
    );
  });

  it('validates a document without saving it', async () => {
    const before = await getThemeState();
    const ok = await validateTheme(meadow);
    expect(ok).toMatchObject({ ok: true, problems: [] });
    expect(ok.resolved?.name).toBe('Meadow');
    const bad = await validateTheme({ ...meadow, fonts: { sans: 'Papyrus' } });
    expect(bad).toMatchObject({
      ok: false,
      resolved: null,
      problems: [{ code: 'unknown_font', path: 'fonts.sans' }],
    });
    expect(await getThemeState()).toEqual(before);
  });

  it('resets to desk, light mode and no accent, drawn exactly as the default accent was, and keeps dock labels', async () => {
    await updateTheme({
      accent: 'clay',
      dockLabels: true,
      mode: 'dark',
      theme: { appearance: 'light', custom: meadow },
    });
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      expect(await resetTheme()).toMatchObject({
        accent: null,
        dockLabels: true,
        mode: 'light',
        light: { preset: 'desk' },
        dark: { preset: 'desk-dark' },
        accentOverrides: [],
      });
      // No accent draws desk exactly as the default accent did: a custom
      // theme set afterwards keeps its own primary.
      const indigo =
        tokens.accents[tokens.defaultAccent as keyof typeof tokens.accents];
      expect((await getTheme(['light', 'dark'])).resolved).toEqual([
        resolvePreset('desk', indigo),
        resolvePreset('desk-dark', indigo),
      ]);
      expect(events).toEqual([
        { type: 'theme.updated', accent: tokens.defaultAccent },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('lists each appearance whose own primary the chosen accent replaces', async () => {
    await updateTheme({ theme: { appearance: 'light', custom: meadow } });
    expect((await getThemeState()).accentOverrides).toEqual([]);
    // Teal hides Meadow's green and desk-dark's indigo.
    expect(await setThemeAccent('teal')).toMatchObject({
      light: { primary: meadow.colors.primary },
      dark: { primary: '#3F51C7' },
      accentOverrides: ['light', 'dark'],
    });
    // Indigo equals desk-dark's own primary, so only Meadow is overridden.
    expect((await setThemeAccent('indigo')).accentOverrides).toEqual(['light']);
    expect((await updateTheme({ accent: null })).accentOverrides).toEqual([]);
  });
});
