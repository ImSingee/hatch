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
  let databaseUrl = '';

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
    vi.stubEnv('DATABASE_URL', databaseUrl);
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

  // Only the order where the delete is still in flight is checked. A first
  // visit that pins the oldest dashboard before the delete reaches it holds
  // the delete back until it commits, and the delete then removes that pin
  // with the dashboard, like any later delete of a pinned dashboard.
  it('pins the next dashboard on a first visit while the oldest one is being deleted', async () => {
    const { db, schema } = platform;
    const userId = 'first-visit';
    await db
      .insert(schema.user)
      .values({ id: userId, name: userId, email: `${userId}@pins.test` });
    await db.insert(schema.dashboards).values([
      { id: 'old', name: 'Old', createdAt: new Date('2000-01-01') },
      { id: 'next', name: 'Next', createdAt: new Date('2000-01-02') },
    ]);
    let deleted!: () => void;
    const deleting = new Promise<void>((resolve) => (deleted = resolve));
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => (commit = resolve));
    // Holds the deleted row's lock, uncommitted, until the visit is done.
    const deletion = db.transaction(async (tx) => {
      await tx.delete(schema.dashboards).where(eq(schema.dashboards.id, 'old'));
      deleted();
      await committing;
    });
    try {
      await deleting;
      // The visit neither waits for the delete nor fails over it.
      const visit = await Promise.race([
        read.readDashboards(userId),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), 2000),
        ),
      ]);
      expect(visit).not.toBe('blocked');
    } finally {
      commit();
      await deletion;
    }
    expect(
      (await read.readDashboards(userId))
        .filter((dashboard) => dashboard.pinned)
        .map((dashboard) => dashboard.id),
    ).toEqual(['next']);
    await db.delete(schema.dashboards).where(eq(schema.dashboards.id, 'next'));
  });

  it('reports a pin as not found when the dashboard is deleted at the same moment', async () => {
    const { db, schema } = platform;
    for (let round = 0; round < 12; round++) {
      const id = `gone-${round}`;
      await db.insert(schema.dashboards).values({ id, name: 'Gone' });
      // The user already has a row for it, unpinned.
      await db.insert(schema.userDashboards).values({
        userId: 'u1',
        dashboardId: id,
        pinned: false,
        sortOrder: 99,
      });
      let pinnedWhenDeleted: boolean | undefined;
      const [pin] = await Promise.allSettled([
        pins.setDashboardPinned('u1', id, true),
        db.transaction(async (tx) => {
          // Waits for a pin holding the dashboard, then sees what it wrote.
          await tx
            .select({ id: schema.dashboards.id })
            .from(schema.dashboards)
            .where(eq(schema.dashboards.id, id))
            .for('update');
          pinnedWhenDeleted = (
            await tx.query.userDashboards.findFirst({
              where: { userId: 'u1', dashboardId: id },
              columns: { pinned: true },
            })
          )?.pinned;
          await tx
            .delete(schema.dashboards)
            .where(eq(schema.dashboards.id, id));
        }),
      ]);
      // A success means the pin was written before the delete; otherwise
      // the pin says not found.
      expect(
        pin.status === 'fulfilled'
          ? { pinned: pinnedWhenDeleted }
          : { status: (pin.reason as { status?: number }).status },
      ).toEqual(
        pin.status === 'fulfilled' ? { pinned: true } : { status: 404 },
      );
    }
  });

  it('says not found, and publishes nothing, for a pin whose dashboard a pending delete holds', async () => {
    const { db, schema } = platform;
    const { subscribePlatformEvents } = await import('./platform-events');
    await db.insert(schema.dashboards).values({ id: 'held', name: 'Held' });
    await db.insert(schema.userDashboards).values({
      userId: 'u1',
      dashboardId: 'held',
      pinned: false,
      sortOrder: 99,
    });
    const other = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const events: unknown[] = [];
    const stop = subscribePlatformEvents((event) => events.push(event));
    try {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let deleting = () => {};
      const deleted = new Promise<void>((resolve) => {
        deleting = resolve;
      });
      const deletion = other.begin(async (sql) => {
        await sql`delete from dashboards where id = 'held'`;
        deleting();
        await released;
      });
      await deleted;
      const pin = pins.setDashboardPinned('u1', 'held', true);
      const outcome = await pin.then(
        () => 'pinned',
        (error: { status?: number }) => error.status,
      );
      release();
      await deletion;
      expect(outcome).toBe(404);
      expect(events).toEqual([]);
    } finally {
      stop();
      await other.end({ timeout: 1 });
    }
  });
});
