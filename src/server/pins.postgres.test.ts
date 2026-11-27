import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

/**
 * The dashboard order is written with raw SQL whose parameter types the
 * production driver lets the server decide, and first visits race over the
 * pool; PGlite shows neither.
 */
describe.skipIf(!adminUrl)('Dashboard order on PostgreSQL', () => {
  const database = `hatch_pins_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let platform: typeof import('~/db');
  let pins: typeof import('./pins');
  let read: typeof import('./workspace-read');

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    vi.stubEnv('DATABASE_URL', url.toString());
    const { runMigrations } = await import('~/db/migrate');
    await runMigrations();
    platform = await import('~/db');
    pins = await import('./pins');
    read = await import('./workspace-read');
    const { db, schema } = platform;
    await db
      .insert(schema.user)
      .values(
        ['u1', 'u2'].map((id) => ({ id, name: id, email: `${id}@pins.test` })),
      );
    await db.insert(schema.dashboards).values([
      { id: 'd1', name: 'One', createdAt: new Date('2026-01-01') },
      { id: 'd2', name: 'Two', createdAt: new Date('2026-01-02') },
      { id: 'd3', name: 'Three', createdAt: new Date('2026-01-03') },
    ]);
  }, 60_000);

  afterAll(async () => {
    await platform?.db.$client.end({ timeout: 1 });
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
    vi.unstubAllEnvs();
  }, 30_000);

  it('pins the oldest dashboard once for concurrent first visits', async () => {
    const visits = await Promise.all(
      Array.from({ length: 8 }, () => read.readDashboards('u1')),
    );
    for (const dashboards of visits)
      expect(dashboards.filter((d) => d.pinned).map((d) => d.id)).toEqual([
        'd1',
      ]);
    expect(
      await platform.db.query.userDashboards.findMany({
        where: { userId: 'u1' },
        columns: { dashboardId: true, pinned: true },
      }),
    ).toEqual([{ dashboardId: 'd1', pinned: true }]);
  });

  it('skips a dashboard deleted after the order was read', async () => {
    const { db, schema } = platform;
    const order = await db.transaction((tx) =>
      pins.currentDashboardOrder(tx, 'u2'),
    );
    await db.delete(schema.dashboards).where(eq(schema.dashboards.id, 'd2'));
    await db.transaction((tx) =>
      pins.writeDashboardOrder(tx, 'u2', [...order].reverse()),
    );
    expect(
      (await read.readDashboards('u2')).map(({ id, pinned }) => ({
        id,
        pinned,
      })),
    ).toEqual([
      { id: 'd3', pinned: false },
      { id: 'd1', pinned: true },
    ]);
  });
});
