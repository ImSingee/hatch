/**
 * Deployment requests on a real PostgreSQL server: row locks and session
 * advisory locks held by other connections, which the in-memory PGlite of
 * the unit suite cannot have.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

const mocks = vi.hoisted(() => ({
  /** Runs after a package is accepted, before its release takes a lock. */
  beforeRelease: undefined as undefined | (() => Promise<void>),
  /** Runs while the release holds its locks, in place of the package check. */
  duringRelease: undefined as undefined | (() => Promise<void>),
  checked: 0,
}));

vi.mock('~env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~env')>()),
  getPlatformEnv: () => ({
    builderToken: 'token',
    secret: 'builds-postgres-test-secret',
  }),
}));
vi.mock('./git', () => ({
  resolveDeployCommit: async (_id: string, commit?: string) =>
    commit ?? 'a'.repeat(40),
  checkoutAppCommit: async () => {},
}));
vi.mock('../platform-api/sdk', () => ({
  platformSdkDigest: async () => {
    await mocks.beforeRelease?.();
    return '0'.repeat(64);
  },
}));
vi.mock('./finalize', () => ({
  BuildPackageError: class BuildPackageError extends Error {},
  finalizeBuild: async () => {
    mocks.checked += 1;
    await mocks.duringRelease?.();
    throw new Error('The test stops the release here.');
  },
}));

class Rollback extends Error {}

describe.skipIf(!adminUrl)('Deployment requests on PostgreSQL', () => {
  const database = `hatch_builds_${process.pid}_${Date.now()}`;
  let url: string;
  let admin: postgres.Sql;
  let observer: postgres.Sql;
  let platform: typeof import('~/db');
  let builds: typeof import('./builds');
  let provision: typeof import('./data-table/provision');
  let packageArchive: Buffer;
  let dataDir: string;
  let seq = 0;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const target = new URL(adminUrl!);
    target.pathname = `/${database}`;
    url = target.toString();
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'hatch-builds-pg-'));
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('HATCH_DATA_DIR', dataDir);
    const { runMigrations } = await import('~/db/migrate');
    await runMigrations();
    platform = await import('~/db');
    builds = await import('./builds');
    provision = await import('./data-table/provision');
    const { packBuildDirectory } = await import('../../app-build/archive');
    const dir = path.join(dataDir, 'package');
    await mkdir(dir);
    await writeFile(path.join(dir, 'build.json'), '{}');
    packageArchive = await packBuildDirectory(dir);
    observer = postgres(url, { max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await observer?.end({ timeout: 1 });
    await platform?.db.$client.end({ timeout: 1 });
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
    await rm(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }, 30_000);

  /** A new App with one deployment request in `values.status`. */
  async function request(
    values: Partial<typeof platform.schema.appBuilds.$inferInsert> & {
      status: (typeof platform.schema.appBuilds.$inferInsert)['status'];
    },
  ): Promise<{ appId: string; buildId: string }> {
    const { db, schema } = platform;
    const appId = `builds-pg-${++seq}`;
    await db.insert(schema.apps).values({ id: appId, slug: appId, name: 'B' });
    const buildId = ulid();
    await db.insert(schema.appBuilds).values({
      id: buildId,
      appId,
      seq: 1,
      commit: 'a'.repeat(40),
      message: 'Release',
      mode: 'local',
      trigger: 'cli',
      ...values,
    });
    return { appId, buildId };
  }

  const row = async (id: string) =>
    platform.db.query.appBuilds.findFirst({ where: { id } });

  /** Make a verify or release look stalled to the sweeper. */
  const stall = (id: string) =>
    platform.db
      .update(platform.schema.appBuilds)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(platform.schema.appBuilds.id, id));

  /** Statements of this database waiting on a lock another one holds. */
  async function lockWaits(): Promise<number> {
    const [waits] = await observer<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `;
    return waits!.count;
  }

  describe.each([
    ['commits', true],
    ['rolls back', false],
  ])(
    'a lease that runs out while its row is locked by a write that %s',
    (_, commit) => {
      it('accepts nothing from the expired lease', async () => {
        const lease = { builderId: 'builder-1', attempt: 1 };
        const { buildId } = await request({
          mode: 'builder',
          status: 'building',
          builderId: lease.builderId,
          attempts: lease.attempt,
        });
        // Valid for a moment yet, by the database clock leases are judged by.
        await platform.db
          .update(platform.schema.appBuilds)
          .set({
            leaseExpiresAt: sql`clock_timestamp() + interval '3 seconds'`,
          })
          .where(eq(platform.schema.appBuilds.id, buildId));
        const holder = postgres(url, { max: 1, onnotice: () => {} });
        try {
          let decide!: (commit: boolean) => void;
          const decided = new Promise<boolean>((resolve) => (decide = resolve));
          let locked!: () => void;
          const isLocked = new Promise<void>((resolve) => (locked = resolve));
          // Another write to the row (a log append, say) holds it.
          const held = holder
            .begin(async (tx) => {
              await tx`
              update app_builds set log_seq = log_seq + 1 where id = ${buildId}
            `;
              locked();
              if (!(await decided)) throw new Rollback();
            })
            .catch((error) => {
              if (!(error instanceof Rollback)) throw error;
            });
          await isLocked;
          const writes = Promise.all([
            builds.renewBuildLease(buildId, lease),
            builds.appendLeasedBuildLog(buildId, lease, ['late line']),
            builds.failBuild(buildId, lease, 'late'),
          ]);
          await vi.waitFor(async () => expect(await lockWaits()).toBe(3), {
            timeout: 2_000,
            interval: 20,
          });
          // Each write found the lease valid before it waited.
          const [valid] = await observer<{ valid: boolean }[]>`
          select lease_expires_at > clock_timestamp() as valid
          from app_builds where id = ${buildId}
        `;
          expect(valid!.valid).toBe(true);
          await vi.waitFor(
            async () => {
              const [expired] = await observer<{ expired: boolean }[]>`
              select lease_expires_at < clock_timestamp() as expired
              from app_builds where id = ${buildId}
            `;
              expect(expired!.expired).toBe(true);
            },
            { timeout: 10_000, interval: 100 },
          );
          decide(commit);
          await held;
          expect(await writes).toEqual([false, false, false]);
          expect(await row(buildId)).toMatchObject({ status: 'building' });
          expect(
            (await builds.readBuildLog(buildId, 0)).map((line) => line.text),
          ).not.toContain('late line');
        } finally {
          await holder.end({ timeout: 1 });
        }
      }, 20_000);
    },
  );

  it('leaves an attempt that another instance requeued and restarted to the next sweep', async () => {
    const { buildId } = await request({
      mode: 'builder',
      status: 'building',
      builderId: 'builder-1',
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const holder = postgres(url, { max: 1, onnotice: () => {} });
    try {
      let restart!: () => void;
      const restarted = new Promise<void>((resolve) => (restart = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // Another instance: its sweep requeued the first attempt, and a
      // Builder claimed the second, whose lease has run out too.
      const other = holder.begin(async (tx) => {
        await tx`select id from app_builds where id = ${buildId} for update`;
        locked();
        await restarted;
        await tx`
          update app_builds
          set attempts = 2, builder_id = 'builder-2',
            lease_expires_at = clock_timestamp() - interval '1 second'
          where id = ${buildId}
        `;
      });
      await isLocked;
      // This sweep found the first attempt lost, with a retry left.
      const sweep = builds.sweepBuilds();
      await vi.waitFor(async () => expect(await lockWaits()).toBe(1), {
        timeout: 2_000,
        interval: 20,
      });
      restart();
      await other;
      await sweep;
      expect(await row(buildId)).toMatchObject({
        status: 'building',
        attempts: 2,
      });
      // The next sweep judges the second attempt: no retry left.
      await builds.sweepBuilds();
      expect(await row(buildId)).toMatchObject({
        status: 'failed',
        errorCode: 'builder_lost',
      });
    } finally {
      await holder.end({ timeout: 1 });
    }
  }, 20_000);

  describe('the sweeper and a release in progress', () => {
    it('settles no release while its Data cutover lock is held, and settles it once the holder is gone', async () => {
      const { appId, buildId } = await request({ status: 'verifying' });
      await stall(buildId);
      await provision.withAppDataCutoverLock(appId, async () => {
        await builds.sweepBuilds();
        expect((await row(buildId))?.status).toBe('verifying');
      });
      // The holder's connection is closed, as when its process stops.
      await builds.sweepBuilds();
      expect(await row(buildId)).toMatchObject({
        status: 'failed',
        errorCode: 'release_interrupted',
      });
    }, 20_000);

    it('leaves a live release alone while it holds the lock', async () => {
      const { appId, buildId } = await request({ status: 'awaiting_artifact' });
      mocks.checked = 0;
      let seen: string | undefined;
      mocks.duringRelease = async () => {
        await stall(buildId);
        await builds.sweepBuilds();
        seen = (await row(buildId))?.status;
      };
      try {
        const final = await builds.acceptArtifact({
          appId,
          buildId,
          archive: packageArchive,
        });
        expect(mocks.checked).toBe(1);
        expect(seen).toBe('verifying');
        // The release's own outcome, not the sweeper's.
        expect(final.status).toBe('failed');
        expect(final.errorCode).not.toBe('release_interrupted');
      } finally {
        mocks.duringRelease = undefined;
      }
    }, 20_000);

    it('stops a release settled before it took the lock before it changes anything', async () => {
      const { appId, buildId } = await request({ status: 'awaiting_artifact' });
      mocks.checked = 0;
      // Accepted, then paused past the stall limit before the release took
      // its locks; a sweep settled it meanwhile.
      mocks.beforeRelease = async () => {
        expect((await row(buildId))?.status).toBe('verifying');
        await stall(buildId);
        await builds.sweepBuilds();
        expect((await row(buildId))?.status).toBe('failed');
      };
      try {
        const final = await builds.acceptArtifact({
          appId,
          buildId,
          archive: packageArchive,
        });
        expect(final).toMatchObject({
          status: 'failed',
          errorCode: 'release_interrupted',
        });
      } finally {
        mocks.beforeRelease = undefined;
      }
      expect(mocks.checked).toBe(0);
      expect(
        await platform.db.query.apps.findFirst({
          where: { id: appId },
          columns: { status: true, dataActivationId: true },
        }),
      ).toMatchObject({ dataActivationId: null });
      expect(
        await platform.db.query.deployments.findFirst({
          where: { appId },
        }),
      ).toBeUndefined();
    }, 20_000);
  });
});
