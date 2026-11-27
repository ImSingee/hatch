import { beforeEach, describe, expect, it, vi } from 'vitest';
import tokens from '../../packages/hatch-design-tokens/tokens.json';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { readTheme, updateTheme } = await import('./theme-settings');
const { readInterfacePreferences, updateInterfacePreferences } =
  await import('./interface-preferences');
const { subscribePlatformEvents } = await import('./platform-events');

const USER = 'user-1';
const OTHER = 'user-2';
const other = Object.keys(tokens.accents).find(
  (name) => name !== tokens.defaultAccent,
)!;

beforeEach(async () => {
  await db.delete(schema.userPreferences);
  await db.delete(schema.user);
  for (const id of [USER, OTHER])
    await db.insert(schema.user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
    });
});

async function recordEvents(action: () => Promise<unknown>) {
  const events: unknown[] = [];
  const unsubscribe = subscribePlatformEvents((event) => events.push(event));
  try {
    await action();
  } finally {
    unsubscribe();
  }
  return events;
}

describe('personal theme', () => {
  it('starts on the built-in defaults and offers every token accent', async () => {
    const state = await readTheme(USER);
    expect(state).toMatchObject({
      accent: tokens.defaultAccent,
      defaultAccent: tokens.defaultAccent,
      dockLabels: false,
    });
    expect(state.accents).toEqual(
      Object.entries(tokens.accents).map(([name, color]) => ({ name, color })),
    );
  });

  it('keeps each user’s accent and dock labels to that user', async () => {
    const events = await recordEvents(async () => {
      expect(await updateTheme(USER, { accent: other })).toMatchObject({
        accent: other,
        dockLabels: false,
      });
      expect(await updateTheme(USER, { dockLabels: true })).toMatchObject({
        accent: other,
        dockLabels: true,
      });
    });
    expect(await readTheme(USER)).toMatchObject({
      accent: other,
      dockLabels: true,
    });
    expect(await readTheme(OTHER)).toMatchObject({
      accent: tokens.defaultAccent,
      dockLabels: false,
    });
    // Only the user's own clients are told to re-read it.
    expect(events).toEqual([
      { type: 'theme.updated', userId: USER, accent: other },
      { type: 'theme.updated', userId: USER, accent: other },
    ]);
  });

  it('rejects an accent the tokens do not define and keeps the stored one', async () => {
    await updateTheme(USER, { accent: other });
    const events = await recordEvents(async () => {
      for (const accent of ['orange', '', 'toString', 'Indigo'])
        await expect(updateTheme(USER, { accent })).rejects.toMatchObject({
          status: 400,
        });
      await expect(updateTheme(USER, {})).rejects.toMatchObject({
        status: 400,
      });
    });
    expect((await readTheme(USER)).accent).toBe(other);
    expect(events).toEqual([]);
  });

  it('reads a stored accent the tokens no longer define as the default', async () => {
    await db.insert(schema.userPreferences).values({
      userId: USER,
      homepage: { kind: 'page', page: 'dashboard' },
      accent: 'retired-accent',
      dockLabels: true,
    });
    expect(await readTheme(USER)).toMatchObject({
      accent: tokens.defaultAccent,
      // The other setting survives the retired accent.
      dockLabels: true,
    });
  });

  it('keeps both of two theme changes made at the same moment', async () => {
    await Promise.all([
      updateTheme(USER, { accent: other }),
      updateTheme(USER, { dockLabels: true }),
    ]);
    expect(await readTheme(USER)).toMatchObject({
      accent: other,
      dockLabels: true,
    });
  });

  it('shares the preference row without clobbering the language', async () => {
    await updateInterfacePreferences(USER, { language: 'zh-CN' });
    await updateTheme(USER, { accent: other });
    expect(await readInterfacePreferences(USER)).toEqual({ language: 'zh-CN' });
    await updateInterfacePreferences(USER, { language: 'en' });
    expect((await readTheme(USER)).accent).toBe(other);
  });
});
