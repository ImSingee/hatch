import { beforeEach, describe, expect, it, vi } from 'vitest';
import tokens from '../../packages/hatch-design-tokens/tokens.json';
import { resolvePreset } from '../../packages/hatch-design-tokens/src';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  createTheme,
  deleteTheme,
  getTheme,
  getThemeState,
  listThemes,
  resetTheme,
  setThemeAccent,
  updateCustomTheme,
  updateTheme,
  validateTheme,
} = await import('./theme-settings');
const { subscribePlatformEvents } = await import('./platform-events');

beforeEach(async () => {
  await db.delete(schema.platformConfig);
  await db.delete(schema.themes);
});

describe('instance theme', () => {
  it('starts with no accent, desk showing the default accent colour, and offers every token accent', async () => {
    const state = await getThemeState();
    expect(state.accent).toBeNull();
    expect(state.theme).toMatchObject({ id: 'desk', source: 'preset' });
    expect(state.theme.primary).toBe(
      tokens.accents[tokens.defaultAccent as keyof typeof tokens.accents],
    );
    expect(state.accentOverridesPrimary).toBe(false);
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

describe('the theme library', () => {
  it('reads desk from rows that only know the accent, and falls back to desk for an unusable theme id', async () => {
    await db
      .insert(schema.platformConfig)
      .values({ key: 'ui.theme', value: { accent: 'teal' } });
    expect(await getThemeState()).toMatchObject({
      accent: 'teal',
      theme: { id: 'desk' },
    });
    await db
      .update(schema.platformConfig)
      .set({ value: { accent: 'teal', theme: 'deleted-theme' } });
    expect((await getThemeState()).theme.id).toBe('desk');
  });

  it('lists the presets, then custom themes, and activates a dark preset like any theme', async () => {
    const saved = await createTheme(meadow);
    expect(saved).toMatchObject({
      name: 'Meadow',
      source: 'custom',
      appearance: 'light',
      primary: meadow.colors.primary,
      valid: true,
    });
    expect((await listThemes()).map((theme) => theme.id)).toEqual([
      'desk',
      'desk-dark',
      saved.id,
    ]);
    // Saving does not activate.
    expect((await getThemeState()).theme.id).toBe('desk');
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      const dark = await updateTheme({ theme: 'desk-dark', accent: null });
      expect(dark.theme).toMatchObject({ id: 'desk-dark', appearance: 'dark' });
      const { resolved } = await getTheme({ resolve: true });
      expect(resolved).toEqual(resolvePreset('desk-dark'));
      await updateTheme({ theme: saved.id });
      expect((await getTheme({ resolve: true })).resolved?.colors.primary).toBe(
        meadow.colors.primary,
      );
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('replaces a custom theme whole and keeps presets read-only', async () => {
    const saved = await createTheme(meadow);
    const edited = await updateCustomTheme(saved.id, {
      ...meadow,
      name: 'Meadow night',
      appearance: 'dark',
      colors: {
        ...meadow.colors,
        background: '#0F1A14',
        foreground: '#E6F0E9',
        card: '#17241C',
        secondary: '#1F2E25',
        muted: '#1F2E25',
        'muted-foreground': '#A5B8AC',
        border: '#2A3A30',
      },
    });
    expect(edited).toMatchObject({
      id: saved.id,
      name: 'Meadow night',
      appearance: 'dark',
    });
    for (const call of [
      () => updateCustomTheme('desk', meadow),
      () => deleteTheme('desk-dark'),
    ])
      await expect(call()).rejects.toMatchObject({
        status: 400,
        code: 'theme_preset_readonly',
      });
    await expect(updateCustomTheme('missing', meadow)).rejects.toMatchObject({
      status: 404,
      code: 'theme_not_found',
    });
  });

  it('deletes a custom theme, but not the active one', async () => {
    const saved = await createTheme(meadow);
    await updateTheme({ theme: saved.id });
    await expect(deleteTheme(saved.id)).rejects.toMatchObject({
      status: 409,
      code: 'theme_active',
    });
    await updateTheme({ theme: 'desk' });
    await deleteTheme(saved.id);
    expect((await listThemes()).map((theme) => theme.id)).toEqual([
      'desk',
      'desk-dark',
    ]);
    await expect(deleteTheme(saved.id)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps theme names unique, ignoring case, presets included', async () => {
    const saved = await createTheme(meadow);
    const taken = { status: 409, code: 'theme_name_taken' };
    for (const name of ['meadow', 'MEADOW', 'Desk', 'desk dark'])
      await expect(createTheme({ ...meadow, name })).rejects.toMatchObject(
        taken,
      );
    const other = await createTheme({ ...meadow, name: 'Moss' });
    await expect(
      updateCustomTheme(other.id, { ...meadow, name: 'Meadow' }),
    ).rejects.toMatchObject(taken);
    // A theme keeps its own name, in any case, when it is saved again.
    await expect(
      updateCustomTheme(saved.id, { ...meadow, name: 'MEADOW' }),
    ).resolves.toMatchObject({ name: 'MEADOW' });
    expect((await listThemes()).map((theme) => theme.name)).toEqual([
      'Desk',
      'Desk dark',
      'MEADOW',
      'Moss',
    ]);
    // Two saves racing past the check still cannot share a name.
    await expect(
      db
        .insert(schema.themes)
        .values({ id: 'race', name: 'moss', document: meadow }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'themes_name_idx' },
    });
  });

  it('rejects unusable themes and changes, keeping what is stored', async () => {
    const saved = await createTheme(meadow);
    const before = await getThemeState();
    for (const document of [
      { ...meadow, glow: true },
      { ...meadow, colors: { ...meadow.colors, card: 'cream' } },
      { ...meadow, fonts: { sans: 'Papyrus' } },
      {
        ...meadow,
        colors: { ...meadow.colors, 'muted-foreground': '#9AA79C' },
      },
    ]) {
      await expect(createTheme(document)).rejects.toMatchObject({
        status: 400,
        code: 'theme_invalid',
      });
      await expect(updateCustomTheme(saved.id, document)).rejects.toMatchObject(
        {
          code: 'theme_invalid',
        },
      );
    }
    await expect(updateTheme({ theme: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
    expect(await getThemeState()).toEqual(before);
    expect((await listThemes()).at(-1)?.document).toEqual(meadow);
  });

  it('keeps a stored theme that no longer passes, flagged, and never draws it', async () => {
    await db.insert(schema.themes).values({
      id: 'faded',
      name: 'Faded',
      document: {
        ...meadow,
        colors: { ...meadow.colors, 'muted-foreground': '#C0C0C0' },
      },
    });
    const faded = (await listThemes()).find((theme) => theme.id === 'faded');
    expect(faded).toMatchObject({ valid: false, name: 'Faded' });
    expect(faded?.problems[0]).toMatchObject({ code: 'low_contrast' });
    await expect(updateTheme({ theme: 'faded' })).rejects.toMatchObject({
      code: 'theme_invalid',
    });
    // Even when set directly, desk is drawn.
    await db
      .insert(schema.platformConfig)
      .values({ key: 'ui.theme', value: { accent: null, theme: 'faded' } });
    expect((await getThemeState()).theme.id).toBe('desk');
  });

  it('says when the chosen accent hides the active theme primary', async () => {
    const saved = await createTheme(meadow);
    expect(
      (await updateTheme({ theme: saved.id, accent: 'teal' }))
        .accentOverridesPrimary,
    ).toBe(true);
    expect((await updateTheme({ accent: null })).accentOverridesPrimary).toBe(
      false,
    );
    // Indigo is desk's own primary.
    expect(
      (await updateTheme({ theme: 'desk', accent: 'indigo' }))
        .accentOverridesPrimary,
    ).toBe(false);
  });

  it('validates a document without saving it', async () => {
    const ok = await validateTheme(meadow);
    expect(ok).toMatchObject({ ok: true, problems: [] });
    expect(ok.resolved?.name).toBe('Meadow');
    const bad = await validateTheme({ ...meadow, fonts: { sans: 'Papyrus' } });
    expect(bad).toMatchObject({
      ok: false,
      resolved: null,
      problems: [{ code: 'unknown_font', path: 'fonts.sans' }],
    });
    expect(await listThemes()).toHaveLength(2);
  });

  it('resets to desk with no accent, drawn exactly as the default accent was, keeping dock labels and the library', async () => {
    const saved = await createTheme(meadow);
    await updateTheme({ accent: 'clay', dockLabels: true, theme: saved.id });
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      expect(await resetTheme()).toMatchObject({
        accent: null,
        dockLabels: true,
        theme: { id: 'desk' },
        accentOverridesPrimary: false,
      });
      const indigo =
        tokens.accents[tokens.defaultAccent as keyof typeof tokens.accents];
      expect((await getTheme({ resolve: true })).resolved).toEqual(
        resolvePreset('desk', indigo),
      );
      expect(events).toEqual([
        { type: 'theme.updated', accent: tokens.defaultAccent },
      ]);
      expect(await listThemes()).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });
});
