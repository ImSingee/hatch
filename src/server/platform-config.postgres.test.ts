import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

/**
 * PGlite has one connection, so it cannot show two writers racing. These
 * checks run partial setting changes over the production driver's pool.
 */
describe.skipIf(!adminUrl)('Platform settings on PostgreSQL', () => {
  const database = `hatch_platform_config_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let platform: typeof import('~/db');
  let config: typeof import('./platform-config');

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    vi.stubEnv('DATABASE_URL', url.toString());
    const { runMigrations } = await import('~/db/migrate');
    await runMigrations();
    platform = await import('~/db');
    config = await import('./platform-config');
  }, 60_000);

  afterAll(async () => {
    await platform?.db.$client.end({ timeout: 1 });
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
    vi.unstubAllEnvs();
  }, 30_000);

  it('keeps every field of concurrent partial changes', async () => {
    // Each change sets one field and keeps the other; run them all at once
    // over separate pooled connections.
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        config.updatePlatformConfig('ui.theme', (current) =>
          index % 2 === 0
            ? { ...current, accent: 'teal' }
            : { ...current, dockLabels: true },
        ),
      ),
    );
    expect(await config.getPlatformConfig('ui.theme')).toEqual({
      accent: 'teal',
      dockLabels: true,
      // Untouched fields keep their defaults.
      mode: 'light',
      light: 'desk',
      dark: 'desk-dark',
    });
  });
});
