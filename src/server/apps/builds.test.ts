/**
 * Deployment requests: the state machine that decides which build package
 * is released. Releases and package checks are covered elsewhere and stubbed
 * here; every state move runs against the real schema.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  builderToken: null as string | null,
  releases: [] as string[],
  release: undefined as undefined | ((id: string) => Promise<void>),
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
  resolveDeployCommit: async (_id: string, commit?: string) =>
    commit ?? 'a'.repeat(40),
}));
vi.mock('../platform-api/sdk', () => ({
  platformSdkDigest: async () => '0'.repeat(64),
}));
vi.mock('./finalize', () => ({
  BuildPackageError: class BuildPackageError extends Error {},
  finalizeBuild: async () => ({
    source: {},
    normalized: {},
    log: '',
    tooling: {},
  }),
}));
vi.mock('./deploy', () => ({
  ReleaseGenerationConflict: class ReleaseGenerationConflict extends Error {},
  releaseDeployment: async (
    _appId: string,
    options: {
      deploymentId: string;
      produce: (dir: string) => Promise<unknown>;
      beforeRelease?: () => Promise<void>;
    },
  ) => {
    await options.produce('/unused');
    await mocks.release?.(options.deploymentId);
    await options.beforeRelease?.();
    mocks.releases.push(options.deploymentId);
    return { version: mocks.releases.length };
  },
}));

const { db, schema } = await import('~/db');
const builds = await import('./builds');
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
  await db.delete(schema.appBuilds);
  await db.delete(schema.apps);
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
    await expect(create({ build: 'builder' })).rejects.toMatchObject({
      code: 'BUILDER_UNAVAILABLE',
    });
    // `auto` picks the Builder only where there is one.
    expect((await create({ build: 'auto' })).mode).toBe('local');
    mocks.builderToken = 'token';
    expect((await create({ build: 'auto' })).mode).toBe('builder');
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
      builderId: 'builder-1',
    });
    expect(final.status).toBe('superseded');
    expect(mocks.releases).toEqual([newer.id]);
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
    await create({ build: 'builder' });
    await db.insert(schema.appBuilds).values({
      id: 'other-queued',
      appId: 'other-app',
      seq: 1,
      commit: 'c'.repeat(40),
      message: 'Other',
      mode: 'builder',
      trigger: 'cli',
      status: 'queued',
    });
    const first = await builds.leaseBuild('builder-1');
    const second = await builds.leaseBuild('builder-2');
    expect(new Set([first?.appId, second?.appId])).toEqual(
      new Set([APP, 'other-app']),
    );
    expect(await builds.leaseBuild('builder-3')).toBeNull();
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
    await builds.leaseBuild('builder-2');
    // The first Builder's lease no longer holds the build.
    expect(await builds.renewBuildLease(deployment.id, 'builder-1')).toBe(
      false,
    );
    await expire();
    await builds.sweepBuilds();
    expect(
      await db.query.appBuilds.findFirst({ where: { id: deployment.id } }),
    ).toMatchObject({ status: 'failed', errorCode: 'builder_lost' });
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
