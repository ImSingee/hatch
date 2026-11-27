/**
 * An accent replaces the active theme's primary, so a theme is checked with
 * the accent it will be drawn with. Every shipped accent reads on every
 * theme that passes the rules on its own, so this file swaps `teal` for a
 * paler colour to show both directions of the check.
 */
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.mock('~/ui/theme/accents', async (importOriginal) => {
  const original = await importOriginal<typeof import('~/ui/theme/accents')>();
  return {
    ...original,
    ACCENT_COLORS: { ...original.ACCENT_COLORS, teal: '#9BD9D2' },
  };
});

const { db, schema } = await import('~/db');
const {
  createTheme,
  getTheme,
  getThemeState,
  setThemeAccent,
  updateCustomTheme,
  updateTheme,
  validateTheme,
} = await import('./theme-settings');
const { THEME_PRESETS, contrastProblems } =
  await import('../../packages/hatch-design-tokens/src');

const U = 'user-1';
const OTHER = 'user-2';

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

beforeEach(async () => {
  await db.delete(schema.userPreferences);
  await db.delete(schema.user);
  await db.delete(schema.themes);
  for (const id of [U, OTHER])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.com` });
});

it('checks contrast with the accent that will be drawn, in both directions', async () => {
  const saved = await createTheme(meadow);
  await updateTheme(U, { accent: null, theme: saved.id });
  // An accent over the active theme.
  await expect(setThemeAccent(U, 'teal')).rejects.toMatchObject({
    code: 'theme_invalid',
    message: expect.stringContaining('With the teal accent'),
  });
  expect((await getThemeState(U)).accent).toBeNull();
  // Activating the theme under an accent.
  await updateTheme(U, { theme: 'desk', accent: 'teal' });
  await expect(updateTheme(U, { theme: saved.id })).rejects.toMatchObject({
    code: 'theme_invalid',
  });
  expect((await getThemeState(U)).theme.id).toBe('desk');
  expect(
    (await validateTheme(meadow, { withCurrentAccent: true, accentOf: U })).ok,
  ).toBe(false);
  // Without a user there is no accent to check with.
  expect(
    (await validateTheme(meadow, { withCurrentAccent: true, accentOf: null }))
      .ok,
  ).toBe(true);
  expect((await validateTheme(meadow)).ok).toBe(true);
});

it('draws a shared theme with its own primary for a user whose accent stopped reading on it', async () => {
  // Dark enough that the pale teal reads on it.
  const night = await createTheme({
    ...THEME_PRESETS['desk-dark'].document,
    name: 'Night',
  });
  await updateTheme(OTHER, { theme: night.id, accent: 'teal' });
  // Someone who does not use it makes it light: teal no longer reads.
  await updateCustomTheme(U, night.id, { ...meadow, name: 'Night' });
  const { theme, resolved } = await getTheme(OTHER, { resolve: true });
  // The choice is kept for when it reads again; meanwhile the theme's own
  // primary is drawn.
  expect(theme).toMatchObject({
    accent: 'teal',
    accentOverridesPrimary: false,
  });
  expect(resolved?.colors.primary).toBe(meadow.colors.primary);
  expect(contrastProblems(resolved!)).toEqual([]);
  // An editor who has it active is checked with their own accent.
  const dusk = await createTheme({
    ...THEME_PRESETS['desk-dark'].document,
    name: 'Dusk',
  });
  await updateTheme(U, { theme: dusk.id, accent: 'teal' });
  await expect(
    updateCustomTheme(U, dusk.id, { ...meadow, name: 'Dusk' }),
  ).rejects.toMatchObject({
    code: 'theme_invalid',
    message: expect.stringContaining('With the teal accent'),
  });
});
