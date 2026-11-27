/**
 * Deployment requests: the state machine that decides which build package
 * is released. Releases and package checks are covered elsewhere and stubbed
 * here; every state move runs against the real schema.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  builderToken: null as string | null,
  releases: [] as string[],
  release: undefined as undefined | ((id: string) => Promise<void>),
  /** Runs after `beforeRelease`, before the release is recorded. */
  beforeRecord: undefined as undefined | ((id: string) => Promise<void>),
  /** Runs before the release takes its locks. */
  beforeLock: undefined as undefined | ((id: string) => Promise<void>),
  /** Apps whose Data cutover lock a release (of any instance) holds. */
  cutoverHeld: new Set<string>(),
  /** Records the release, then fails to finish activating it. */
  unfinished: false,
  /** The activation recovery the sweep runs. */
  reconcile: undefined as undefined | ((appId: string) => Promise<void>),
  /** Fails the source check of a create, as a commit not on master does. */
  resolve: undefined as undefined | (() => Promise<never>),
  packageLog: '',
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('~env', () => ({
  getPlatformEnv: () => ({
    builderToken: mocks.builderToken,
    secret: 'builds-test-secret',
  }),
}));
vi.mock('./git', () => ({
  resolveDeployCommit: async (_id: string, commit?: string) => {
    await mocks.resolve?.();
    return commit ?? 'a'.repeat(40);
  },
}));
vi.mock('../platform-api/sdk', () => ({
  platformSdkDigest: async () => '0'.repeat(64),
}));
vi.mock('./finalize', () => ({
  BuildPackageError: class BuildPackageError extends Error {},
  finalizeBuild: async () => ({
    source: {},
    normalized: {},
    log: mocks.packageLog,
    tooling: {},
  }),
}));
// The Data cutover session lock, as one process sees every instance's.
vi.mock('./data-table/provision', () => ({
  tryWithAppDataCutoverLock: async <T>(id: string, fn: () => Promise<T>) => {
    if (mocks.cutoverHeld.has(id)) return { locked: false };
    mocks.cutoverHeld.add(id);
    try {
      return { locked: true, value: await fn() };
    } finally {
      mocks.cutoverHeld.delete(id);
    }
  },
}));
vi.mock('./deploy', () => ({
  ReleaseGenerationConflict: class ReleaseGenerationConflict extends Error {},
  ReleaseUnfinished: class ReleaseUnfinished extends Error {
    constructor(
      readonly deploymentId: string,
      readonly version: number | null,
    ) {
      super(`Deployment ${deploymentId} did not finish.`);
    }
  },
  reconcilePendingActivation: async (appId: string) => {
    await mocks.reconcile?.(appId);
    return null;
  },
  releaseDeployment: async (
    appId: string,
    options: {
      deploymentId: string;
      produce: (dir: string) => Promise<unknown>;
      beforeRelease?: () => Promise<void>;
      fenceRelease?: (tx: unknown) => Promise<void>;
    },
  ) => {
    await mocks.beforeLock?.(options.deploymentId);
    const { db, schema } = await import('~/db');
    const { appDeployLock } = await import('./deploy-lock');
    // Released as the platform releases: under the cutover lock, behind the
    // requester's fence before anything changes and again when recorded.
    mocks.cutoverHeld.add(appId);
    try {
      await db.transaction(async (tx) => {
        await appDeployLock.acquire(tx, appId);
        await options.fenceRelease?.(tx);
      });
      await options.produce('/unused');
      await mocks.release?.(options.deploymentId);
      await options.beforeRelease?.();
      await mocks.beforeRecord?.(options.deploymentId);
      const version = mocks.releases.length + 1;
      await db.transaction(async (tx) => {
        await appDeployLock.acquire(tx, appId);
        await options.fenceRelease?.(tx);
        await tx.insert(schema.deployments).values({
          id: options.deploymentId,
          appId,
          version,
          status: 'deployed',
          buildId: options.deploymentId,
        });
        if (mocks.unfinished) {
          await tx
            .update(schema.apps)
            .set({ dataActivationId: options.deploymentId })
            .where(eq(schema.apps.id, appId));
        }
      });
      if (mocks.unfinished) {
        const { ReleaseUnfinished } = await import('./deploy');
        throw new ReleaseUnfinished(options.deploymentId, version, {
          cause: new Error('The live backup could not be removed.'),
        });
      }
      mocks.releases.push(options.deploymentId);
      return { version };
    } finally {
      mocks.cutoverHeld.delete(appId);
    }
  },
}));

const { db, schema } = await import('~/db');
const { AppError } = await import('~server/errors');
const builds = await import('./builds');
const { BUILDER_ONLINE_MS, recordBuilderSeen } = await import('./builders');
const { packBuildDirectory } = await import('../../app-build/archive');

const APP = 'builds-app';
let packageArchive: Buffer;
const work = await mkdtemp(path.join(os.tmpdir(), 'hatch-builds-test-'));

afterAll(() => rm(work, { recursive: true, force: true }));

const create = (
  input: Partial<Parameters<typeof builds.createDeployment>[0]> = {},
) =>
  builds.createDeployment({
    appId: APP,
    message: 'Release',
    build: 'local',
    trigger: 'cli',
    actor: 'user-1',
    ...input,
  });

const status = async (id: string) =>
  (await db.query.appBuilds.findFirst({ where: { id } }))?.status;

beforeEach(async () => {
  mocks.builderToken = null;
  mocks.releases = [];
  mocks.release = undefined;
  mocks.beforeRecord = undefined;
  mocks.beforeLock = undefined;
  mocks.cutoverHeld.clear();
  mocks.unfinished = false;
  mocks.reconcile = undefined;
  mocks.resolve = undefined;
  mocks.packageLog = '';
  await db.delete(schema.deployments);
  await db.delete(schema.appBuilds);
  await db.delete(schema.apps);
  // A Builder asked for work just now (see the Builder status cases).
  await db.delete(schema.appBuilders);
  await db
    .insert(schema.appBuilders)
    .values({ id: 'builder-1', concurrency: 1, lastSeenAt: new Date() });
  await db.insert(schema.apps).values([
    { id: APP, slug: APP, name: 'Builds' },
    { id: 'other-app', slug: 'other-app', name: 'Other' },
  ]);
  const dir = path.join(work, `package-${Date.now()}`);
  await mkdir(dir);
  await writeFile(path.join(dir, 'build.json'), '{}');
  packageArchive = await packBuildDirectory(dir);
});

describe('creating deployments', () => {
  it('waits for a local build, or refuses the Builder when there is none', async () => {
    const local = await create();
    expect(local).toMatchObject({ mode: 'local', status: 'awaiting_artifact' });
    // The Agent falls back to a local build from what the error says.
    await expect(create({ build: 'builder' })).rejects.toMatchObject({
      code: 'BUILDER_UNAVAILABLE',
      message: expect.stringContaining('hatch app deploy --local'),
    });
    mocks.builderToken = 'token';
    expect((await create({ build: 'builder' })).mode).toBe('builder');
  });

  it('refuses a Builder build while no Builder is online, instead of queuing it', async () => {
    mocks.builderToken = 'token';
    // Last heard from just past the online window.
    await db
      .update(schema.appBuilders)
      .set({ lastSeenAt: new Date(Date.now() - BUILDER_ONLINE_MS - 5_000) });
    await expect(create({ build: 'builder' })).rejects.toMatchObject({
      code: 'BUILDER_OFFLINE',
      message: expect.stringContaining('hatch app deploy --local'),
    });
    expect(await db.query.appBuilds.findMany()).toEqual([]);
    // A local build does not need one.
    expect((await create()).mode).toBe('local');
    // A lease request or heartbeat brings it back.
    await recordBuilderSeen('builder-1');
    expect((await create({ build: 'builder' })).mode).toBe('builder');
  });

  it('supersedes deployments that have not started building', async () => {
    const first = await create();
    mocks.builderToken = 'token';
    const queued = await create({ build: 'builder', commit: 'b'.repeat(40) });
    expect(await status(first.id)).toBe('superseded');
    const leased = await builds.leaseBuild('builder-1');
    expect(leased?.id).toBe(queued.id);
    // A build in progress is not superseded; it is checked at release.
    await create();
    expect(await status(queued.id)).toBe('building');
  });

  it('joins a builder deployment of the same commit instead of building twice', async () => {
    mocks.builderToken = 'token';
    const first = await create({ build: 'builder' });
    const again = await create({ build: 'builder' });
    expect(again.id).toBe(first.id);
    expect(
      await db.query.appBuilds.findMany({ where: { appId: APP } }),
    ).toHaveLength(1);
    // A joiner that asks to be notified is; another release note does not
    // join (the note is the deployment's).
    expect((await create({ build: 'builder', notify: true })).id).toBe(
      first.id,
    );
    expect((await builds.getDeployment(APP, first.id)).notifyOnFinish).toBe(
      true,
    );
    const other = await create({ build: 'builder', message: 'Other note' });
    expect(other.id).not.toBe(first.id);
  });

  it('answers a repeated create request with the deployment it made', async () => {
    const first = await create({ requestId: 'req-1' });
    // Even after a newer deployment superseded it.
    await create();
    const again = await create({ requestId: 'req-1' });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('superseded');
    expect((await builds.findDeploymentByRequest(APP, 'req-1'))?.id).toBe(
      first.id,
    );
    expect(await builds.findDeploymentByRequest(APP, 'req-2')).toBeNull();
    // Also once its commit has left master (a restore): the repeat is
    // answered before the source is checked again.
    mocks.resolve = () =>
      Promise.reject(
        new AppError('not on master', 409, {
          code: 'deployments.commitNotOnMaster',
        }),
      );
    expect((await create({ requestId: 'req-1' })).id).toBe(first.id);
    await expect(create({ requestId: 'req-3' })).rejects.toMatchObject({
      code: 'deployments.commitNotOnMaster',
    });
  });

  it('finds a joined build by the request id of the request that joined', async () => {
    mocks.builderToken = 'token';
    const first = await create({ build: 'builder', requestId: 'req-a' });
    const joined = await create({ build: 'builder', requestId: 'req-b' });
    expect(joined.id).toBe(first.id);
    expect((await builds.findDeploymentByRequest(APP, 'req-b'))?.id).toBe(
      first.id,
    );
    // Repeating the joiner returns that build, not a new one, also once
    // that build has finished.
    expect((await create({ build: 'builder', requestId: 'req-b' })).id).toBe(
      first.id,
    );
    await db
      .update(schema.appBuilds)
      .set({ status: 'ready' })
      .where(eq(schema.appBuilds.id, first.id));
    expect((await create({ build: 'builder', requestId: 'req-b' })).id).toBe(
      first.id,
    );
    expect(
      await db.query.appBuilds.findMany({ where: { appId: APP } }),
    ).toHaveLength(1);
  });

  it('answers a repeated Builder request after the Builder was turned off', async () => {
    mocks.builderToken = 'token';
    const first = await create({ build: 'builder', requestId: 'req-b1' });
    // The platform restarted without a Builder.
    mocks.builderToken = null;
    expect((await create({ build: 'builder', requestId: 'req-b1' })).id).toBe(
      first.id,
    );
    // A new Builder request still has none to build it.
    await expect(
      create({ build: 'builder', requestId: 'req-b2' }),
    ).rejects.toMatchObject({ code: 'BUILDER_UNAVAILABLE' });
    // The App and its generation are still checked first.
    await expect(
      create({
        build: 'builder',
        requestId: 'req-b1',
        expectedGeneration: '2000-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('joins nothing for a caller that has already given up', async () => {
    mocks.builderToken = 'token';
    const first = await create({ build: 'builder' });
    const abort = new AbortController();
    abort.abort();
    await expect(
      create({
        build: 'builder',
        requestId: 'req-late-join',
        notify: true,
        signal: abort.signal,
      }),
    ).rejects.toThrow(/canceled/);
    // Neither the request nor its notification was recorded.
    expect(
      await builds.findDeploymentByRequest(APP, 'req-late-join'),
    ).toBeNull();
    expect((await builds.getDeployment(APP, first.id)).notifyOnFinish).toBe(
      false,
    );
  });

  it('creates nothing for a caller that has already given up', async () => {
    const waiting = await create();
    const abort = new AbortController();
    abort.abort();
    await expect(
      create({ requestId: 'req-gone', signal: abort.signal }),
    ).rejects.toThrow(/canceled/);
    expect(await builds.findDeploymentByRequest(APP, 'req-gone')).toBeNull();
    // Nor did it supersede anything.
    expect(await status(waiting.id)).toBe('awaiting_artifact');
  });
});

describe('accepting build packages', () => {
  it('releases the package of a waiting deployment', async () => {
    const deployment = await create();
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: packageArchive,
    });
    expect(final).toMatchObject({ status: 'ready', deploymentVersion: 1 });
    expect(mocks.releases).toEqual([deployment.id]);
  });

  it('accepts no package for a canceled deployment or another App', async () => {
    const deployment = await create();
    await expect(
      builds.acceptArtifact({
        appId: 'other-app',
        buildId: deployment.id,
        archive: packageArchive,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await builds.cancelDeployment(APP, deployment.id, 'user-1');
    await expect(
      builds.acceptArtifact({
        appId: APP,
        buildId: deployment.id,
        archive: packageArchive,
      }),
    ).rejects.toMatchObject({ code: 'DEPLOYMENT_NOT_AWAITING_ARTIFACT' });
    expect(mocks.releases).toEqual([]);
  });

  it('never releases an older build after a newer one went live', async () => {
    mocks.builderToken = 'token';
    const older = await create({ build: 'builder', commit: 'b'.repeat(40) });
    await builds.leaseBuild('builder-1');
    const newer = await create();
    await builds.acceptArtifact({
      appId: APP,
      buildId: newer.id,
      archive: packageArchive,
    });
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: older.id,
      archive: packageArchive,
      lease: { builderId: 'builder-1', attempt: 1 },
    });
    expect(final.status).toBe('superseded');
    expect(mocks.releases).toEqual([newer.id]);
  });

  it('counts a newer release from its committed deployment row', async () => {
    // The newer release committed, but its request was never marked ready
    // (the platform stopped, or is still finishing it).
    mocks.builderToken = 'token';
    const older = await create({ build: 'builder', commit: 'b'.repeat(40) });
    await builds.leaseBuild('builder-1');
    const newer = await create();
    await db
      .update(schema.appBuilds)
      .set({ status: 'releasing' })
      .where(eq(schema.appBuilds.id, newer.id));
    await db.insert(schema.deployments).values({
      id: newer.id,
      appId: APP,
      status: 'deployed',
      buildId: newer.id,
    });
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: older.id,
      archive: packageArchive,
      lease: { builderId: 'builder-1', attempt: 1 },
    });
    expect(final.status).toBe('superseded');
    expect(mocks.releases).toEqual([]);
  });

  it('cannot cancel a deployment that is already verifying', async () => {
    const deployment = await create();
    mocks.release = async (id) => {
      await expect(
        builds.cancelDeployment(APP, id, 'user-1'),
      ).rejects.toMatchObject({ code: 'DEPLOYMENT_NOT_CANCELABLE' });
    };
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: packageArchive,
    });
    expect(final.status).toBe('ready');
  });

  it('keeps the not-on-master code when the commit left master before release', async () => {
    const deployment = await create();
    // Publishing re-checks master under the deploy lock (a restore may have
    // moved it back meanwhile).
    mocks.release = async () => {
      throw new AppError('Commit is not on master.', 409, {
        code: 'deployments.commitNotOnMaster',
      });
    };
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: packageArchive,
    });
    expect(final).toMatchObject({
      status: 'failed',
      errorCode: 'COMMIT_NOT_ON_MASTER',
    });
  });

  it('stores a local build log of any length with its package', async () => {
    // More rows than one INSERT can bind parameters for.
    mocks.packageLog = Array.from(
      { length: 20_000 },
      (_, i) => `line ${i + 1}`,
    ).join('\n');
    const deployment = await create();
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: packageArchive,
    });
    expect(final.status).toBe('ready');
    const lines = await db.query.appBuildLogs.findMany({
      where: { buildId: deployment.id, stream: 'build' },
      orderBy: { seq: 'asc' },
    });
    expect(lines).toHaveLength(20_000);
    expect(lines.at(-1)?.text).toBe('line 20000');
    expect(lines.at(-1)!.seq - lines[0]!.seq).toBe(19_999);
  });

  it('records a package it cannot read as a failed deployment', async () => {
    const deployment = await create();
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: Buffer.from('not a package'),
    });
    expect(final).toMatchObject({
      status: 'failed',
      errorCode: 'app_build_invalid',
    });
  });
});

describe('builder leases', () => {
  it('builds one deployment per App at a time', async () => {
    mocks.builderToken = 'token';
    const queued = (id: string, appId: string, seq: number, at: number) => ({
      id,
      appId,
      seq,
      commit: 'c'.repeat(40),
      message: id,
      mode: 'builder' as const,
      trigger: 'cli' as const,
      status: 'queued' as const,
      createdAt: new Date(at),
    });
    // The App's second deployment is older than the other App's, so it is
    // first in line; while the App builds, the other App goes first.
    const now = Date.now();
    await db
      .insert(schema.appBuilds)
      .values([
        queued('app-first', APP, 1, now - 3000),
        queued('app-second', APP, 2, now - 2000),
        queued('other-queued', 'other-app', 1, now - 1000),
      ]);
    expect((await builds.leaseBuild('builder-1'))?.id).toBe('app-first');
    expect((await builds.leaseBuild('builder-2'))?.id).toBe('other-queued');
    expect(await builds.leaseBuild('builder-3')).toBeNull();
    expect(await status('app-second')).toBe('queued');
  });

  it('accepts nothing under a lease that expired before the sweep', async () => {
    mocks.builderToken = 'token';
    const deployment = await create({ build: 'builder' });
    const leased = await builds.leaseBuild('builder-1');
    // The lease and its log line commit together.
    const log = await builds.readBuildLog(deployment.id, 0);
    expect(log.at(-1)?.text).toBe('Building on builder-1 (attempt 1).');
    expect(leased?.logSeq).toBe(log.at(-1)?.seq);
    await db
      .update(schema.appBuilds)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.appBuilds.id, deployment.id));
    const lease = { builderId: 'builder-1', attempt: 1 };
    expect(await builds.leasedBuild(deployment.id, 'builder-1')).toBeNull();
    expect(await builds.renewBuildLease(deployment.id, lease)).toBe(false);
    expect(
      await builds.appendLeasedBuildLog(deployment.id, lease, ['late line']),
    ).toBe(false);
    expect(await builds.failBuild(deployment.id, lease, 'late')).toBe(false);
    await expect(
      builds.acceptArtifact({
        appId: APP,
        buildId: deployment.id,
        archive: packageArchive,
        lease,
      }),
    ).rejects.toMatchObject({ code: 'DEPLOYMENT_NOT_AWAITING_ARTIFACT' });
    // The upload's own lookup swept it: queued again for another attempt.
    expect(await status(deployment.id)).toBe('queued');
    expect(mocks.releases).toEqual([]);
  });

  it('judges a lease when the row is checked, not when the call was made', async () => {
    // PGlite takes its clock from `Date`, so faking it moves both clocks.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      mocks.builderToken = 'token';
      const deployment = await create({ build: 'builder' });
      await builds.leaseBuild('builder-1');
      const lease = { builderId: 'builder-1', attempt: 1 };
      let late: Promise<unknown>[] = [];
      // Each call waits behind a transaction holding the database while the
      // lease runs out.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        late = [
          builds.leasedBuild(deployment.id, 'builder-1'),
          builds.renewBuildLease(deployment.id, lease),
          builds.appendLeasedBuildLog(deployment.id, lease, ['late line']),
          builds.failBuild(deployment.id, lease, 'late'),
        ];
        await new Promise((resolve) => setTimeout(resolve, 50));
        vi.setSystemTime(Date.now() + builds.BUILD_LEASE_MS + 1000);
      });
      const [leased, renewed, appended, failed] = await Promise.all(late);
      expect({ leased, renewed, appended, failed }).toEqual({
        leased: null,
        renewed: false,
        appended: false,
        failed: false,
      });
      expect(await status(deployment.id)).toBe('building');
      expect(
        (await builds.readBuildLog(deployment.id, 0)).map((l) => l.text),
      ).not.toContain('late line');
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues a lost build again once, then fails it', async () => {
    mocks.builderToken = 'token';
    const deployment = await create({ build: 'builder' });
    const expire = () =>
      db
        .update(schema.appBuilds)
        .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.appBuilds.id, deployment.id));
    await builds.leaseBuild('builder-1');
    await expire();
    await builds.sweepBuilds();
    expect(await status(deployment.id)).toBe('queued');
    // The same Builder takes the next attempt; its first attempt's lease no
    // longer holds the build, so a late call from it changes nothing.
    await builds.leaseBuild('builder-1');
    const first = { builderId: 'builder-1', attempt: 1 };
    expect(await builds.renewBuildLease(deployment.id, first)).toBe(false);
    expect(await builds.failBuild(deployment.id, first, 'late')).toBe(false);
    expect(
      await builds.appendLeasedBuildLog(deployment.id, first, ['late line']),
    ).toBe(false);
    expect(
      await builds.renewBuildLease(deployment.id, {
        builderId: 'builder-1',
        attempt: 2,
      }),
    ).toBe(true);
    await expire();
    await builds.sweepBuilds();
    expect(
      await db.query.appBuilds.findFirst({ where: { id: deployment.id } }),
    ).toMatchObject({ status: 'failed', errorCode: 'builder_lost' });
  });

  it('settles an interrupted release from the recorded deployments, with a log line', async () => {
    const stall = async (id: string, state: 'verifying' | 'releasing') => {
      await db
        .update(schema.appBuilds)
        .set({ status: state, updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(schema.appBuilds.id, id));
    };
    const lastLine = async (id: string) =>
      (await builds.readBuildLog(id, 0)).at(-1)?.text;
    // Released and recorded, but the platform stopped before marking it.
    const recorded = await create();
    await stall(recorded.id, 'releasing');
    await db.insert(schema.deployments).values({
      id: recorded.id,
      appId: APP,
      version: 4,
      status: 'deployed',
      buildId: recorded.id,
    });
    await builds.sweepBuilds();
    expect(
      await db.query.appBuilds.findFirst({ where: { id: recorded.id } }),
    ).toMatchObject({ status: 'ready', deploymentVersion: 4 });
    expect(await lastLine(recorded.id)).toMatch(/Released version 4/);
    // Nothing recorded: the release did not happen.
    const lost = await create();
    await stall(lost.id, 'verifying');
    await builds.sweepBuilds();
    expect(
      await db.query.appBuilds.findFirst({ where: { id: lost.id } }),
    ).toMatchObject({ status: 'failed', errorCode: 'release_interrupted' });
    expect(await lastLine(lost.id)).toMatch(/nothing was released/);
  });

  it('changes nothing for a release another instance settled before it took its locks', async () => {
    const deployment = await create();
    let produced = false;
    mocks.release = async () => {
      produced = true;
    };
    // The release paused past the stall limit after it was accepted; the
    // sweep (of any instance) settled the request before the release took
    // its locks.
    mocks.beforeLock = async (id) => {
      expect(await status(id)).toBe('verifying');
      await db
        .update(schema.appBuilds)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(schema.appBuilds.id, id));
      await builds.sweepBuilds();
    };
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: packageArchive,
    });
    expect(final).toMatchObject({
      status: 'failed',
      errorCode: 'release_interrupted',
    });
    expect(produced).toBe(false);
    expect(
      await db.query.deployments.findFirst({ where: { id: deployment.id } }),
    ).toBeUndefined();
    expect(mocks.releases).toEqual([]);
    expect((await builds.readBuildLog(deployment.id, 0)).at(-1)?.text).toMatch(
      /nothing was released/,
    );
  });

  it('settles no release while it holds its locks, however quiet it is', async () => {
    const deployment = await create();
    mocks.beforeRecord = async (id) => {
      await db
        .update(schema.appBuilds)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(schema.appBuilds.id, id));
      await builds.sweepBuilds();
      expect(await status(id)).toBe('releasing');
    };
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: packageArchive,
    });
    expect(final).toMatchObject({ status: 'ready', deploymentVersion: 1 });
  });

  it('reports a recorded release ready only once its activation is recovered', async () => {
    const deployment = await create();
    // Recorded and live, but finishing its activation failed.
    mocks.unfinished = true;
    const final = await builds.acceptArtifact({
      appId: APP,
      buildId: deployment.id,
      archive: packageArchive,
    });
    expect(final).toMatchObject({ status: 'releasing', errorCode: null });
    let recoveries = 0;
    mocks.reconcile = async (appId) => {
      recoveries += 1;
      if (recoveries === 1) throw new Error('Still failing.');
      await db
        .update(schema.apps)
        .set({ dataActivationId: null })
        .where(eq(schema.apps.id, appId));
    };
    // The next sweep takes it up at once, and again after a failed recovery.
    await builds.sweepBuilds();
    expect(await status(deployment.id)).toBe('releasing');
    await builds.sweepBuilds();
    expect(recoveries).toBe(2);
    expect(
      await db.query.appBuilds.findFirst({ where: { id: deployment.id } }),
    ).toMatchObject({ status: 'ready', deploymentVersion: 1 });
    // Settled, it is no longer recovered.
    await builds.sweepBuilds();
    expect(recoveries).toBe(2);
  });

  it('leaves a release that is still running to finish, however long it takes', async () => {
    // A step before the release is recorded (a data migration, say) runs
    // past the stall limit; the release's heartbeat keeps it alive for any
    // instance's sweeper.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const deployment = await create();
      mocks.release = async (id) => {
        await db
          .update(schema.appBuilds)
          .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
          .where(eq(schema.appBuilds.id, id));
        vi.advanceTimersByTime(builds.RELEASE_HEARTBEAT_MS);
        await vi.waitFor(async () => {
          const row = await db.query.appBuilds.findFirst({ where: { id } });
          expect(row!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
        });
        await builds.sweepBuilds();
        expect(await status(id)).toBe('verifying');
      };
      const final = await builds.acceptArtifact({
        appId: APP,
        buildId: deployment.id,
        archive: packageArchive,
      });
      expect(final.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes a follower at once for a change made while it was busy', async () => {
    const deployment = await create();
    const changes = await builds.followBuildChanges(deployment.id);
    try {
      // The follower has read the build and is sending it; a line commits
      // before it starts to wait.
      await builds.appendBuildLog(deployment.id, 'build', 'meanwhile');
      const started = Date.now();
      await changes.wait(30_000);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      changes.close();
    }
  });

  it('fails a local deployment whose package never arrives', async () => {
    const deployment = await create();
    await db
      .update(schema.appBuilds)
      .set({ createdAt: new Date(Date.now() - builds.ARTIFACT_WAIT_MS - 1000) })
      .where(eq(schema.appBuilds.id, deployment.id));
    await builds.sweepBuilds();
    expect(
      await db.query.appBuilds.findFirst({ where: { id: deployment.id } }),
    ).toMatchObject({ status: 'failed', errorCode: 'artifact_timeout' });
  });
});

describe('the deployment queue across Apps', () => {
  it('lists unfinished deployments oldest first, with queue positions, a page at a time', async () => {
    mocks.builderToken = 'token';
    await db
      .insert(schema.apps)
      .values({ id: 'third-app', slug: 'third-app', name: 'Third' });
    // Finished deployments are not in the queue.
    const done = await create({ appId: 'third-app', build: 'builder' });
    await builds.cancelDeployment('third-app', done.id, 'user-1');
    const running = await create({ build: 'builder' });
    expect((await builds.leaseBuild('builder-1'))?.id).toBe(running.id);
    // A newer commit waits behind its App's running build.
    const next = await create({ build: 'builder', commit: 'b'.repeat(40) });
    const other = await create({ appId: 'other-app', build: 'builder' });
    const local = await create({ appId: 'third-app' });

    const first = await builds.listDeploymentQueue({ limit: 2 });
    const second = await builds.listDeploymentQueue({
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    const view = (page: typeof first) =>
      page.items.map((item) => ({
        id: item.build.id,
        app: item.app.slug,
        status: item.build.status,
        position: item.queuePosition,
      }));
    expect(view(first)).toEqual([
      { id: running.id, app: APP, status: 'building', position: null },
      { id: next.id, app: APP, status: 'queued', position: 1 },
    ]);
    // Positions continue across pages.
    expect(view(second)).toEqual([
      { id: other.id, app: 'other-app', status: 'queued', position: 2 },
      {
        id: local.id,
        app: 'third-app',
        status: 'awaiting_artifact',
        position: null,
      },
    ]);
    expect(second.nextCursor).toBeNull();
    // A queued deployment in the middle can be canceled.
    await builds.cancelDeployment(APP, next.id, 'user-1');
    expect(
      (await builds.listDeploymentQueue({ limit: 10 })).items.map((item) => [
        item.build.id,
        item.queuePosition,
      ]),
    ).toEqual([
      [running.id, null],
      [other.id, 1],
      [local.id, null],
    ]);
  });
});

describe('Builder status', () => {
  it('reports each Builder heard from in the last day, its running builds and whether it is online', async () => {
    const { builderStatus } = await import('./builders');
    expect(await builderStatus()).toEqual({ configured: false, builders: [] });
    mocks.builderToken = 'token';
    await recordBuilderSeen('builder-1', 2);
    await db.insert(schema.appBuilders).values([
      {
        id: 'builder-stale',
        concurrency: 4,
        lastSeenAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
      {
        id: 'builder-gone',
        concurrency: 1,
        lastSeenAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
      },
    ]);
    await create({ build: 'builder' });
    await builds.leaseBuild('builder-1');

    expect(await builderStatus()).toEqual({
      configured: true,
      builders: [
        expect.objectContaining({
          id: 'builder-1',
          concurrency: 2,
          running: 1,
          online: true,
        }),
        expect.objectContaining({
          id: 'builder-stale',
          concurrency: 4,
          running: 0,
          online: false,
        }),
      ],
    });
  });
});
