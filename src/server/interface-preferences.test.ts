import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { readInterfacePreferences, updateInterfacePreferences } =
  await import('./interface-preferences');
const { readAgentPreferences, updateAgentPreferences } =
  await import('./agent-preferences');

const USER = 'user-1';
const OTHER = 'user-2';

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

describe('interface preferences', () => {
  it('has no language until the user picks one', async () => {
    expect(await readInterfacePreferences(USER)).toEqual({ language: null });
  });

  it('keeps the picked language per user', async () => {
    expect(
      await updateInterfacePreferences(USER, { language: 'zh-CN' }),
    ).toEqual({ language: 'zh-CN' });
    expect(await readInterfacePreferences(USER)).toEqual({ language: 'zh-CN' });
    expect(await readInterfacePreferences(OTHER)).toEqual({ language: null });
    await updateInterfacePreferences(USER, { language: 'en' });
    expect(await readInterfacePreferences(USER)).toEqual({ language: 'en' });
  });

  it('leaves the language unchanged when the update omits it', async () => {
    await updateInterfacePreferences(USER, { language: 'zh-CN' });
    expect(await updateInterfacePreferences(USER, {})).toEqual({
      language: 'zh-CN',
    });
  });

  it('rejects a language without a catalog', async () => {
    await expect(
      updateInterfacePreferences(USER, { language: 'fr' as never }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readInterfacePreferences(USER)).toEqual({ language: null });
  });

  it('shares the row with the Agent preferences without clobbering them', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    await updateInterfacePreferences(USER, { language: 'zh-CN' });
    expect(await readAgentPreferences(USER)).toEqual({ messageMode: 'queue' });
    await updateAgentPreferences(USER, { messageMode: 'steer' });
    expect(await readInterfacePreferences(USER)).toEqual({ language: 'zh-CN' });
  });
});
