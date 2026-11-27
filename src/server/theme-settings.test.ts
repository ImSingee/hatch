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
const { readInterfacePreferences, updateInterfacePreferences } =
  await import('./interface-preferences');
const { subscribePlatformEvents } = await import('./platform-events');

const U = 'user-1';
const OTHER = 'user-2';

beforeEach(async () => {
  await db.delete(schema.userPreferences);
  await db.delete(schema.user);
  await db.delete(schema.themes);
  for (const id of [U, OTHER])
    await db.insert(schema.user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
    });
});

/** Store a user's theme settings directly, as older rows may hold them. */
async function storeSettings(
  userId: string,
  settings: {
    accent?: string | null;
    dockLabels?: boolean | null;
    themePreset?: string | null;
    customThemeId?: string | null;
  },
) {
  await db
    .insert(schema.userPreferences)
    .values({
      userId,
      homepage: { kind: 'page', page: 'dashboard' },
      ...settings,
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: settings,
    });
}

describe('personal theme', () => {
  it('starts with no accent, desk showing the default accent colour, and offers every token accent', async () => {
    const state = await getThemeState(U);
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
      expect((await setThemeAccent(U, other)).accent).toBe(other);
      expect((await getThemeState(U)).accent).toBe(other);
      expect(events).toEqual([
        { type: 'theme.updated', userId: U, accent: other },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('rejects an accent the tokens do not define and keeps the stored one', async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      for (const accent of ['orange', '', 'toString', 'Indigo'])
        await expect(setThemeAccent(U, accent)).rejects.toMatchObject({
          status: 400,
        });
      expect((await getThemeState(U)).accent).toBeNull();
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('falls back to the default accent when the stored one is no longer defined', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await storeSettings(U, { accent: 'retired-accent', dockLabels: true });
      const state = await getThemeState(U);
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
    await storeSettings(U, { accent: other });
    expect(await getThemeState(U)).toMatchObject({
      accent: other,
      dockLabels: false,
    });

    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      expect(await updateTheme(U, { dockLabels: true })).toMatchObject({
        accent: other,
        dockLabels: true,
      });
      expect(await setThemeAccent(U, tokens.defaultAccent)).toMatchObject({
        accent: tokens.defaultAccent,
        dockLabels: true,
      });
      expect(events).toHaveLength(2);
      await expect(updateTheme(U, {})).rejects.toMatchObject({ status: 400 });
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
      updateTheme(U, { accent: other }),
      updateTheme(U, { dockLabels: true }),
    ]);
    expect(await getThemeState(U)).toMatchObject({
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

describe('the shared theme library', () => {
  it('reads desk from rows that only know the accent, and falls back to desk for an unusable theme name', async () => {
    await storeSettings(U, { accent: 'teal' });
    expect(await getThemeState(U)).toMatchObject({
      accent: 'teal',
      theme: { id: 'desk' },
    });
    await storeSettings(U, { themePreset: 'deleted-theme' });
    expect((await getThemeState(U)).theme.id).toBe('desk');
    // A setting that touches neither the theme nor the accent keeps the
    // stored name as it is.
    expect(await updateTheme(U, { dockLabels: true })).toMatchObject({
      dockLabels: true,
      theme: { id: 'desk' },
    });
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
    expect((await getThemeState(U)).theme.id).toBe('desk');
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      const dark = await updateTheme(U, { theme: 'desk-dark', accent: null });
      expect(dark.theme).toMatchObject({ id: 'desk-dark', appearance: 'dark' });
      const { resolved } = await getTheme(U, { resolve: true });
      expect(resolved).toEqual(resolvePreset('desk-dark'));
      await updateTheme(U, { theme: saved.id });
      expect(
        (await getTheme(U, { resolve: true })).resolved?.colors.primary,
      ).toBe(meadow.colors.primary);
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('replaces a custom theme whole and keeps presets read-only', async () => {
    const saved = await createTheme(meadow);
    const edited = await updateCustomTheme(U, saved.id, {
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
      () => updateCustomTheme(U, 'desk', meadow),
      () => deleteTheme(U, 'desk-dark'),
    ])
      await expect(call()).rejects.toMatchObject({
        status: 400,
        code: 'theme_preset_readonly',
      });
    await expect(updateCustomTheme(U, 'missing', meadow)).rejects.toMatchObject(
      {
        status: 404,
        code: 'theme_not_found',
      },
    );
  });

  it('deletes a custom theme, but not the active one', async () => {
    const saved = await createTheme(meadow);
    await updateTheme(U, { theme: saved.id });
    await expect(deleteTheme(U, saved.id)).rejects.toMatchObject({
      status: 409,
      code: 'theme_active',
    });
    await updateTheme(U, { theme: 'desk' });
    await deleteTheme(U, saved.id);
    expect((await listThemes()).map((theme) => theme.id)).toEqual([
      'desk',
      'desk-dark',
    ]);
    await expect(deleteTheme(U, saved.id)).rejects.toMatchObject({
      status: 404,
    });
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
      updateCustomTheme(U, other.id, { ...meadow, name: 'Meadow' }),
    ).rejects.toMatchObject(taken);
    // A theme keeps its own name, in any case, when it is saved again.
    await expect(
      updateCustomTheme(U, saved.id, { ...meadow, name: 'MEADOW' }),
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
    const before = await getThemeState(U);
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
      await expect(
        updateCustomTheme(U, saved.id, document),
      ).rejects.toMatchObject({
        code: 'theme_invalid',
      });
    }
    await expect(updateTheme(U, { theme: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
    expect(await getThemeState(U)).toEqual(before);
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
    await expect(updateTheme(U, { theme: 'faded' })).rejects.toMatchObject({
      code: 'theme_invalid',
    });
    // Even when set directly, desk is drawn.
    await storeSettings(U, { accent: null, customThemeId: 'faded' });
    expect((await getThemeState(U)).theme.id).toBe('desk');
  });

  it('says when the chosen accent hides the active theme primary', async () => {
    const saved = await createTheme(meadow);
    expect(
      (await updateTheme(U, { theme: saved.id, accent: 'teal' }))
        .accentOverridesPrimary,
    ).toBe(true);
    expect(
      (await updateTheme(U, { accent: null })).accentOverridesPrimary,
    ).toBe(false);
    // Indigo is desk's own primary.
    expect(
      (await updateTheme(U, { theme: 'desk', accent: 'indigo' }))
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
    await updateTheme(U, { accent: 'clay', dockLabels: true, theme: saved.id });
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      expect(await resetTheme(U)).toMatchObject({
        accent: null,
        dockLabels: true,
        theme: { id: 'desk' },
        accentOverridesPrimary: false,
      });
      const indigo =
        tokens.accents[tokens.defaultAccent as keyof typeof tokens.accents];
      expect((await getTheme(U, { resolve: true })).resolved).toEqual(
        resolvePreset('desk', indigo),
      );
      expect(events).toEqual([
        { type: 'theme.updated', userId: U, accent: tokens.defaultAccent },
      ]);
      expect(await listThemes()).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });
});

describe('themes per user', () => {
  it('keeps each user’s active theme, accent and dock labels to that user', async () => {
    const saved = await createTheme(meadow);
    await updateTheme(U, { theme: saved.id, accent: null, dockLabels: true });
    await updateTheme(OTHER, { theme: 'desk-dark', accent: 'teal' });
    expect(await getThemeState(U)).toMatchObject({
      accent: null,
      dockLabels: true,
      theme: { id: saved.id },
    });
    expect(await getThemeState(OTHER)).toMatchObject({
      accent: 'teal',
      dockLabels: false,
      theme: { id: 'desk-dark' },
    });
    expect(
      (await getTheme(U, { resolve: true })).resolved?.colors.primary,
    ).toBe(meadow.colors.primary);
    expect(
      (await getTheme(OTHER, { resolve: true })).resolved?.appearance,
    ).toBe('dark');
    // Without a user: the defaults.
    expect(await getThemeState(null)).toMatchObject({
      accent: null,
      theme: { id: 'desk' },
    });
  });

  it('falls users back to desk when someone deletes the theme they have active', async () => {
    const saved = await createTheme(meadow);
    await updateTheme(OTHER, { theme: saved.id, accent: null });
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      // Only the caller's own active theme is protected.
      await deleteTheme(U, saved.id);
    } finally {
      unsubscribe();
    }
    expect((await getThemeState(OTHER)).theme.id).toBe('desk');
    expect(
      await db.query.userPreferences.findFirst({
        where: { userId: OTHER },
        columns: { customThemeId: true },
      }),
    ).toEqual({ customThemeId: null });
    // Everyone re-reads: their theme may have been the deleted one.
    expect(events).toEqual([{ type: 'themes.updated' }]);
    // A Run nobody prompted has no active theme to protect.
    const second = await createTheme({ ...meadow, name: 'Second' });
    await updateTheme(U, { theme: second.id });
    await deleteTheme(null, second.id);
    expect((await getThemeState(U)).theme.id).toBe('desk');
  });

  it('shares the preference row without clobbering the language', async () => {
    await updateInterfacePreferences(U, { language: 'zh-CN' });
    await updateTheme(U, { accent: 'teal' });
    expect(await readInterfacePreferences(U)).toEqual({ language: 'zh-CN' });
    await updateInterfacePreferences(U, { language: 'en' });
    expect((await getThemeState(U)).accent).toBe('teal');
  });
});
