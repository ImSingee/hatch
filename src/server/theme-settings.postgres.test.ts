import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { THEME_PRESETS } from '../../packages/hatch-design-tokens/src';

const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

/**
 * PGlite has one connection and reports a unique violation differently from
 * postgres.js, so saves racing for one theme name run on the production
 * driver's pool.
 */
describe.skipIf(!adminUrl)('Theme library on PostgreSQL', () => {
  const database = `hatch_theme_library_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let platform: typeof import('~/db');
  let themes: typeof import('./theme-settings');

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    vi.stubEnv('DATABASE_URL', url.toString());
    const { runMigrations } = await import('~/db/migrate');
    await runMigrations();
    platform = await import('~/db');
    themes = await import('./theme-settings');
  }, 60_000);

  afterAll(async () => {
    await platform?.db.$client.end({ timeout: 1 });
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
    vi.unstubAllEnvs();
  }, 30_000);

  it('saves one of several themes created with one name at once', async () => {
    const document = { ...THEME_PRESETS.desk.document, name: 'Harbour' };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        themes.createTheme({
          ...document,
          name: index % 2 ? 'Harbour' : 'harbour',
        }),
      ),
    );
    const rejected = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    expect(rejected).toHaveLength(results.length - 1);
    expect(rejected).toEqual(
      rejected.map(() =>
        expect.objectContaining({ status: 409, code: 'theme_name_taken' }),
      ),
    );
  });

  it('never deletes a theme that is being activated at the same moment', async () => {
    const config = await import('./platform-config');
    for (let round = 0; round < 12; round++) {
      const saved = await themes.createTheme({
        ...THEME_PRESETS.desk.document,
        name: `Race ${round}`,
      });
      // Delete and activate race over separate pooled connections.
      await Promise.allSettled([
        themes.deleteTheme(saved.id),
        themes.updateTheme({ theme: saved.id }),
      ]);
      const active = (await config.getPlatformConfig('ui.theme')).theme;
      const ids = (await themes.listThemes()).map((theme) => theme.id);
      expect(ids).toContain(active);
      await themes.updateTheme({ theme: 'desk' });
    }
  });
});
