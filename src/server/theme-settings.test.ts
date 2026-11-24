import { beforeEach, describe, expect, it, vi } from 'vitest';
import tokens from '../../packages/hatch-design-tokens/tokens.json';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { getThemeState, setThemeAccent, updateTheme } =
  await import('./theme-settings');
const { subscribePlatformEvents } = await import('./platform-events');

beforeEach(async () => {
  await db.delete(schema.platformConfig);
});

describe('instance theme', () => {
  it('starts on the default accent and offers every token accent', async () => {
    const state = await getThemeState();
    expect(state.accent).toBe(tokens.defaultAccent);
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
      expect((await getThemeState()).accent).toBe(tokens.defaultAccent);
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
