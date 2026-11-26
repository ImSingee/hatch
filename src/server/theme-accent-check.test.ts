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
  getThemeState,
  setThemeAccent,
  updateTheme,
  validateTheme,
} = await import('./theme-settings');

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
  await db.delete(schema.platformConfig);
  await db.delete(schema.themes);
});

it('checks contrast with the accent that will be drawn, in both directions', async () => {
  const saved = await createTheme(meadow);
  await updateTheme({ accent: null, theme: saved.id });
  // An accent over the active theme.
  await expect(setThemeAccent('teal')).rejects.toMatchObject({
    code: 'theme_invalid',
    message: expect.stringContaining('With the teal accent'),
  });
  expect((await getThemeState()).accent).toBeNull();
  // Activating the theme under an accent.
  await updateTheme({ theme: 'desk', accent: 'teal' });
  await expect(updateTheme({ theme: saved.id })).rejects.toMatchObject({
    code: 'theme_invalid',
  });
  expect((await getThemeState()).theme.id).toBe('desk');
  expect((await validateTheme(meadow, { withCurrentAccent: true })).ok).toBe(
    false,
  );
  expect((await validateTheme(meadow)).ok).toBe(true);
});
