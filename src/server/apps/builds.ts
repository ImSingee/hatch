/**
 * Server-only: deployment requests (`app_builds`), from creation to release.
 *
 * Source comes first: a deployment names a commit already on the App's
 * master branch. Its build package is then produced elsewhere, by the
 * dedicated Builder (`builder` mode, optional) or by the CLI (`local`
 * mode), and uploaded to that deployment. The platform accepts the package
 * without running it (./finalize.ts) and releases it (./deploy.ts).
 *
 *   builder: queued -> building -> verifying -> releasing -> ready
 *   local:   awaiting_artifact  -> verifying -> releasing -> ready
 *   any unfinished state -> failed | canceled | superseded
 *
 * A newer deployment supersedes older ones that have not started their
 * build, and an older build that finishes after a newer release is not
 * released. Logs are durable rows; LISTEN/NOTIFY only wakes followers.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { BUILD_WORK_DIR } from '~agent/paths';
import { db, schema } from '~/db';
import type { AppBuildMode, AppBuildStatus, JsonObject } from '~/db/schema';
import { getPlatformEnv } from '~env';
import { AppError } from '~server/errors';
import { DeploymentRequestError } from './deployment-errors';
import { BuildArchiveError, unpackBuildArchive } from '../../app-build/archive';
import { platformSdkDigest } from '../platform-api/sdk';
import { asBuildError } from './build';
import { platformBuildHost } from './build-host';
import { DataMigrationApprovalRequired } from './data-table/migrate';
import { ReleaseGenerationConflict, releaseDeployment } from './deploy';
import { BuildPackageError, finalizeBuild } from './finalize';
import { resolveDeployCommit } from './git';
import { AppManifestValidationError } from './manifest-validation';
import { DEFAULT_NOTIFICATION_PRIORITY } from '../notifications/contract';
import { ingestNotification } from '../notifications/ingest';

/** Kind of the notification a finished deployment posts. */
const DEPLOYMENT_NOTIFICATION_KIND = {
  kind: 'deployment',
  name: 'Deployment',
};

export type AppBuild = typeof schema.appBuilds.$inferSelect;

/** States a deployment is still moving through. */
export const ACTIVE_BUILD_STATUSES = [
  'queued',
  'awaiting_artifact',
  'building',
  'verifying',
  'releasing',
] as const satisfies readonly AppBuildStatus[];

export function isFinishedBuild(status: AppBuildStatus): boolean {
  return !(ACTIVE_BUILD_STATUSES as readonly string[]).includes(status);
}

/** How long a builder holds a build without renewing its lease. */
export const BUILD_LEASE_MS = 60_000;
/** Lease losses before a build fails instead of being queued again. */
const MAX_BUILD_ATTEMPTS = 2;
/** How long a local-mode deployment waits for its upload. */
export const ARTIFACT_WAIT_MS = 30 * 60_000;
/** A verify or release with no progress for this long was interrupted. */
const RELEASE_STALL_MS = 30 * 60_000;
const LOG_CHANNEL = 'hatch_app_builds';
/** Followers waiting for queued builder work (Builder lease requests). */
export const BUILD_QUEUE_CHANNEL = 'queue';
const MAX_LOG_LINE = 16_000;

/** Whether this platform has a dedicated Builder. */
export function builderEnabled(): boolean {
  return getPlatformEnv().builderToken !== null;
}

async function notifyBuild(buildId: string): Promise<void> {
  await db
    .execute(sql`select pg_notify(${LOG_CHANNEL}, ${buildId})`)
    .catch(() => {});
}

/** Append log lines to a build; returns the last sequence number. */
export async function appendBuildLog(
  buildId: string,
  stream: 'build' | 'platform',
  text: string | readonly string[],
): Promise<number | null> {
  const lines = (typeof text === 'string' ? text.split('\n') : [...text])
    .map((line) => line.replace(/\r$/, '').slice(0, MAX_LOG_LINE))
    .filter((line, index, all) => line || index < all.length - 1);
  if (lines.length === 0) return null;
  const last = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.appBuilds)
      .set({ logSeq: sql`${schema.appBuilds.logSeq} + ${lines.length}` })
      .where(eq(schema.appBuilds.id, buildId))
      .returning({ logSeq: schema.appBuilds.logSeq });
    if (!row) return null;
    const first = row.logSeq - lines.length + 1;
    await tx.insert(schema.appBuildLogs).values(
      lines.map((line, index) => ({
        buildId,
        seq: first + index,
        stream,
        text: line,
      })),
    );
    return row.logSeq;
  });
  await notifyBuild(buildId);
  return last;
}

/** Move a build between states; returns the row when the move applied. */
async function transition(
  buildId: string,
  from: readonly AppBuildStatus[],
  values: Partial<typeof schema.appBuilds.$inferInsert> & {
    status: AppBuildStatus;
  },
  extra?: ReturnType<typeof and>,
): Promise<AppBuild | null> {
  const finished = isFinishedBuild(values.status);
  const [row] = await db
    .update(schema.appBuilds)
    .set({
      ...values,
      ...(finished ? { finishedAt: new Date(), leaseExpiresAt: null } : {}),
    })
    .where(
      and(
        eq(schema.appBuilds.id, buildId),
        inArray(schema.appBuilds.status, [...from]),
        extra,
      ),
    )
    .returning();
  if (row) {
    await notifyBuild(buildId);
    if (
      row.notifyOnFinish &&
      (row.status === 'ready' || row.status === 'failed')
    ) {
      void notifyDeploymentFinished(row).catch((error) => {
        console.error(`[apps] notification for ${row.id} failed:`, error);
      });
    }
  }
  return row ?? null;
}

/** The platform notification of a finished deployment someone asked for. */
async function notifyDeploymentFinished(row: AppBuild): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: { id: row.appId },
    columns: { name: true, slug: true },
  });
  if (!app) return;
  const ready = row.status === 'ready';
  await ingestNotification({
    source: { type: 'platform', name: 'Hatch' },
    kind: DEPLOYMENT_NOTIFICATION_KIND,
    push: {
      kind: DEPLOYMENT_NOTIFICATION_KIND.kind,
      format: 'text',
      title: ready
        ? `${app.name} v${row.deploymentVersion} is live`
        : `${app.name} deployment failed`,
      body: ready
        ? row.message
        : (row.errorMessage ?? 'The deployment failed.').slice(0, 1000),
      summary: null,
      markdown: null,
      content: null,
      url: `/app/${app.slug}/manage`,
      autoOpenUrl: true,
      priority: DEFAULT_NOTIFICATION_PRIORITY,
      data: { appId: row.appId, deploymentId: row.id, status: row.status },
      reply: null,
      dedupeKey: `deployment:${row.id}`,
      occurredAt: null,
    },
  });
}

export type CreateDeploymentInput = {
  appId: string;
  /** Full commit id on master; the master tip when omitted. */
  commit?: string;
  message: string;
  /** `auto` uses the Builder when this platform has one. */
  build: AppBuildMode | 'auto';
  trigger: 'cli' | 'ui';
  actor: string | null;
  expectedGeneration?: string;
  allowDestructiveDataMigration?: boolean;
  dataMigrationApprovalToken?: string;
  /** Post a platform notification when it finishes. */
  notify?: boolean;
};

/** Create a deployment of a pushed commit. */
export async function createDeployment(
  input: CreateDeploymentInput,
): Promise<AppBuild> {
  const message = input.message.trim();
  if (!message) throw new AppError('A deployment message is required.', 400);
  const mode: AppBuildMode =
    input.build === 'auto'
      ? builderEnabled()
        ? 'builder'
        : 'local'
      : input.build;
  if (mode === 'builder' && !builderEnabled()) {
    throw new DeploymentRequestError(
      'BUILDER_UNAVAILABLE',
      'This platform has no dedicated Builder; build locally with ' +
        '`hatch app deploy --build local`.',
    );
  }
  const app = await db.query.apps.findFirst({
    where: { id: input.appId },
    columns: { id: true, createdAt: true },
  });
  if (!app) throw new AppError(`App "${input.appId}" not found.`, 404);
  if (
    input.expectedGeneration &&
    app.createdAt.toISOString() !== input.expectedGeneration
  ) {
    throw new AppError(
      'App was deleted or recreated while preparing the deploy.',
      409,
    );
  }
  // Source first: only a commit already on master can be deployed.
  const commit = await resolveDeployCommit(input.appId, input.commit);
  const allowDestructive = Boolean(input.allowDestructiveDataMigration);
  const approvalToken = input.dataMigrationApprovalToken || null;

  const created = await db.transaction(async (tx) => {
    // Serialize sequence numbers and supersession per App.
    await tx
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(eq(schema.apps.id, input.appId))
      .for('update');
    if (mode === 'builder') {
      // The same request while its build is still waiting or running joins
      // that build instead of building the commit twice.
      const existing = await tx.query.appBuilds.findFirst({
        where: {
          appId: input.appId,
          commit,
          mode: 'builder',
          status: { in: ['queued', 'building'] },
          allowDestructiveDataMigration: allowDestructive,
          dataMigrationApprovalToken: approvalToken ?? { isNull: true },
        },
        orderBy: { seq: 'desc' },
      });
      if (existing) return { row: existing, joined: true };
    }
    const [last] = await tx
      .select({ seq: sql<number>`coalesce(max(${schema.appBuilds.seq}), 0)` })
      .from(schema.appBuilds)
      .where(eq(schema.appBuilds.appId, input.appId));
    const superseded = await tx
      .update(schema.appBuilds)
      .set({
        status: 'superseded',
        finishedAt: new Date(),
        errorCode: 'superseded',
        errorMessage: 'A newer deployment was requested before this one built.',
      })
      .where(
        and(
          eq(schema.appBuilds.appId, input.appId),
          inArray(schema.appBuilds.status, ['queued', 'awaiting_artifact']),
        ),
      )
      .returning({ id: schema.appBuilds.id });
    const [row] = await tx
      .insert(schema.appBuilds)
      .values({
        id: ulid().toLowerCase(),
        appId: input.appId,
        seq: Number(last?.seq ?? 0) + 1,
        commit,
        message,
        mode,
        trigger: input.trigger,
        actor: input.actor,
        status: mode === 'builder' ? 'queued' : 'awaiting_artifact',
        expectedGeneration: input.expectedGeneration ?? null,
        allowDestructiveDataMigration: allowDestructive,
        dataMigrationApprovalToken: approvalToken,
        notifyOnFinish: Boolean(input.notify),
      })
      .returning();
    return { row, joined: false, superseded: superseded.map((s) => s.id) };
  });
  if (created.joined) return created.row;
  for (const id of created.superseded ?? []) await notifyBuild(id);
  if (mode === 'builder') await notifyBuild(BUILD_QUEUE_CHANNEL);
  await appendBuildLog(
    created.row.id,
    'platform',
    mode === 'builder'
      ? `Deployment queued for the Builder: ${commit}`
      : `Deployment waiting for the local build of ${commit}`,
  );
  return (await getDeploymentRow(input.appId, created.row.id))!;
}

async function getDeploymentRow(
  appId: string,
  id: string,
): Promise<AppBuild | undefined> {
  return db.query.appBuilds.findFirst({ where: { id, appId } });
}

export async function getDeployment(
  appId: string,
  id: string,
): Promise<AppBuild> {
  await sweepBuilds().catch(() => {});
  const row = await getDeploymentRow(appId, id);
  if (!row) {
    throw new AppError(`Deployment ${id} not found.`, 404);
  }
  return row;
}

/** Deployments of an App, newest first, `cursor` being the last seq seen. */
export async function listDeployments(
  appId: string,
  options: { limit: number; cursor?: number },
): Promise<{ items: AppBuild[]; nextCursor: number | null }> {
  await sweepBuilds().catch(() => {});
  const items = await db.query.appBuilds.findMany({
    where: {
      appId,
      ...(options.cursor ? { seq: { lt: options.cursor } } : {}),
    },
    orderBy: { seq: 'desc' },
    limit: options.limit + 1,
  });
  const page = items.slice(0, options.limit);
  return {
    items: page,
    nextCursor: items.length > options.limit ? page.at(-1)!.seq : null,
  };
}

/** How a local build that failed is recorded. */
export type BuildFailure = {
  code: 'app_build_failed' | 'APP_MANIFEST_INVALID';
  message: string;
};

/**
 * Cancel a deployment that has not started verifying. With `failure`, a
 * local deployment whose build failed is recorded as failed instead.
 */
export async function cancelDeployment(
  appId: string,
  id: string,
  actor: string | null,
  failure?: BuildFailure,
): Promise<AppBuild> {
  const row = await getDeployment(appId, id);
  if (failure) {
    const failed = await transition(row.id, ['awaiting_artifact'], {
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 64_000),
    });
    if (!failed) {
      throw new DeploymentRequestError(
        'DEPLOYMENT_NOT_AWAITING_ARTIFACT',
        `Deployment ${id} is ${row.status}; it is not waiting for a local build.`,
      );
    }
    await appendBuildLog(id, 'build', failure.message);
    return failed;
  }
  const canceled = await transition(
    row.id,
    ['queued', 'awaiting_artifact', 'building'],
    {
      status: 'canceled',
      errorCode: 'canceled',
      errorMessage: actor ? `Canceled by ${actor}.` : 'Canceled.',
    },
  );
  if (!canceled) {
    throw new DeploymentRequestError(
      'DEPLOYMENT_NOT_CANCELABLE',
      `Deployment ${id} is ${row.status} and can no longer be canceled.`,
    );
  }
  await appendBuildLog(id, 'platform', 'Deployment canceled.');
  return canceled;
}

export type BuildLogLine = {
  seq: number;
  stream: 'build' | 'platform';
  text: string;
  at: Date;
};

export async function readBuildLog(
  buildId: string,
  afterSeq: number,
  limit = 500,
): Promise<BuildLogLine[]> {
  return db.query.appBuildLogs.findMany({
    where: { buildId, seq: { gt: afterSeq } },
    orderBy: { seq: 'asc' },
    limit,
    columns: { seq: true, stream: true, text: true, at: true },
  });
}

type Waiter = { buildId: string; wake: () => void };
const waiters = new Set<Waiter>();
let listening: Promise<void> | undefined;

/** One LISTEN per process wakes every follower of a changed build. */
function ensureListening(): Promise<void> {
  listening ??= (async () => {
    const client = db.$client as unknown as {
      listen?: (
        channel: string,
        onNotify: (payload: string) => void,
      ) => Promise<unknown>;
    };
    if (typeof client.listen !== 'function') return;
    await client.listen(LOG_CHANNEL, (payload) => {
      for (const waiter of waiters) {
        if (waiter.buildId === payload) waiter.wake();
      }
    });
  })().catch(() => {
    listening = undefined;
  });
  return listening;
}

/**
 * Wait until a build changes (a log line or a state move) or `timeoutMs`
 * passes. Followers re-read durable state after every wake-up, so a missed
 * notification only delays them until the next poll.
 */
export async function waitForBuildChange(
  buildId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await ensureListening();
  await new Promise<void>((resolve) => {
    const waiter: Waiter = { buildId, wake: () => done() };
    const timer = setTimeout(() => done(), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(waiter);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    waiters.add(waiter);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A stable failure code for an error raised while accepting a package. */
function failureCode(error: unknown): string {
  if (error instanceof DataMigrationApprovalRequired)
    return 'data_migration_approval_required';
  if (error instanceof AppManifestValidationError)
    return 'APP_MANIFEST_INVALID';
  if (error instanceof BuildPackageError) return error.code;
  if (error instanceof ReleaseGenerationConflict)
    return 'resource_generation_conflict';
  if (error instanceof BuildArchiveError) return 'app_build_invalid';
  if (error instanceof AppError && error.status < 500)
    return 'app_build_failed';
  return 'release_failed';
}

function failureMessage(error: unknown): string {
  if (error instanceof DataMigrationApprovalRequired) {
    return (
      'Destructive Data Table migration requires explicit approval.\n' +
      `Approval token: ${error.plan.approvalToken}\n` +
      'Inspect schema changes before retrying with ' +
      '--allow-destructive-data-migration and --data-migration-approval-token.'
    );
  }
  const reported = asBuildError(error);
  if (reported instanceof AppError) return reported.message;
  return 'The release failed on the platform.';
}

export type AcceptArtifactInput = {
  appId: string;
  buildId: string;
  /** The gzipped build package (src/app-build/archive.ts). */
  archive: Uint8Array;
  /** Builder mode: the builder holding the lease. */
  builderId?: string;
};

/**
 * Accept the build package of one deployment and release it. Returns the
 * deployment in its final state; a rejected package is a `failed`
 * deployment, not an error.
 */
export async function acceptArtifact(
  input: AcceptArtifactInput,
): Promise<AppBuild> {
  const row = await getDeployment(input.appId, input.buildId);
  const fromState: AppBuildStatus =
    row.mode === 'builder' ? 'building' : 'awaiting_artifact';
  if (
    (row.mode === 'builder') !== (input.builderId !== undefined) ||
    row.status !== fromState
  ) {
    throw new DeploymentRequestError(
      'DEPLOYMENT_NOT_AWAITING_ARTIFACT',
      `Deployment ${row.id} is ${row.status}; it does not accept a build package now.`,
    );
  }
  const verifying = await transition(
    row.id,
    [fromState],
    {
      status: 'verifying',
      artifactSha256: createHash('sha256').update(input.archive).digest('hex'),
    },
    input.builderId
      ? eq(schema.appBuilds.builderId, input.builderId)
      : undefined,
  );
  if (!verifying) {
    throw new DeploymentRequestError(
      'DEPLOYMENT_NOT_AWAITING_ARTIFACT',
      `Deployment ${row.id} changed state; it does not accept a build package now.`,
    );
  }
  await appendBuildLog(row.id, 'platform', 'Verifying the build package.');

  const work = path.join(BUILD_WORK_DIR, row.appId, `accept-${randomUUID()}`);
  const packageDir = path.join(work, 'package');
  await fs.mkdir(work, { recursive: true });
  try {
    await unpackBuildArchive(input.archive, packageDir);
    const sdkDigest = await platformSdkDigest();
    let buildLog = '';
    const released = await releaseDeployment(row.appId, {
      deploymentId: row.id,
      sourceCommit: row.commit,
      message: row.message,
      expectedGeneration: row.expectedGeneration ?? undefined,
      allowDestructiveDataMigration: row.allowDestructiveDataMigration,
      dataMigrationApprovalToken: row.dataMigrationApprovalToken ?? undefined,
      buildOrigin: row.mode,
      produce: async (outputDir) => {
        const { tooling, ...result } = await finalizeBuild({
          packageDir,
          outDir: outputDir,
          appId: row.appId,
          deploymentId: row.id,
          commit: row.commit,
          tooling: platformBuildHost({ sdkDigest }).tooling,
        });
        buildLog = result.log;
        await db
          .update(schema.appBuilds)
          .set({ buildMetadata: { tooling } as unknown as JsonObject })
          .where(eq(schema.appBuilds.id, row.id));
        return result;
      },
      beforeRelease: async () => {
        // A newer release wins; a cancellation never reaches here because
        // only queued, waiting or building deployments can be canceled.
        const newer = await db.query.appBuilds.findFirst({
          where: { appId: row.appId, seq: { gt: row.seq }, status: 'ready' },
          columns: { id: true },
        });
        if (newer) throw new SupersededRelease(newer.id);
        const releasing = await transition(row.id, ['verifying'], {
          status: 'releasing',
        });
        if (!releasing) throw new Error('The deployment changed state.');
        await appendBuildLog(
          row.id,
          'platform',
          'Build package accepted. Releasing.',
        );
      },
    });
    if (row.mode === 'local' && buildLog) {
      await appendBuildLog(row.id, 'build', buildLog);
    }
    await appendBuildLog(
      row.id,
      'platform',
      `Released version ${released.version}.`,
    );
    return (
      (await transition(row.id, ['releasing'], {
        status: 'ready',
        deploymentVersion: released.version,
      })) ?? (await getDeployment(row.appId, row.id))
    );
  } catch (error) {
    if (error instanceof SupersededRelease) {
      await appendBuildLog(
        row.id,
        'platform',
        `Not released: deployment ${error.newerId} was released first.`,
      );
      return (
        (await transition(row.id, ['verifying', 'releasing'], {
          status: 'superseded',
          errorCode: 'superseded',
          errorMessage: `Deployment ${error.newerId} was released first.`,
        })) ?? (await getDeployment(row.appId, row.id))
      );
    }
    const code = failureCode(error);
    const message = failureMessage(error);
    if (code === 'release_failed') {
      console.error(`[apps] release of ${row.id} failed:`, error);
    }
    await appendBuildLog(row.id, 'platform', message);
    return (
      (await transition(row.id, ['verifying', 'releasing'], {
        status: 'failed',
        errorCode: code,
        errorMessage: message,
      })) ?? (await getDeployment(row.appId, row.id))
    );
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

class SupersededRelease extends Error {
  constructor(readonly newerId: string) {
    super(`Deployment ${newerId} was released first.`);
  }
}

/** Builder mode: take the oldest queued build of an App with none running. */
export async function leaseBuild(builderId: string): Promise<AppBuild | null> {
  await sweepBuilds().catch(() => {});
  const leased = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: schema.appBuilds.id })
      .from(schema.appBuilds)
      .where(
        and(
          eq(schema.appBuilds.status, 'queued'),
          sql`not exists (
            select 1 from ${schema.appBuilds} as running
            where running.app_id = ${schema.appBuilds.appId}
              and running.status = 'building'
          )`,
        ),
      )
      .orderBy(schema.appBuilds.createdAt)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return null;
    const [row] = await tx
      .update(schema.appBuilds)
      .set({
        status: 'building',
        builderId,
        leaseExpiresAt: new Date(Date.now() + BUILD_LEASE_MS),
        attempts: sql`${schema.appBuilds.attempts} + 1`,
        startedAt: new Date(),
      })
      .where(
        and(
          eq(schema.appBuilds.id, candidate.id),
          eq(schema.appBuilds.status, 'queued'),
        ),
      )
      .returning();
    return row ?? null;
  });
  if (leased) {
    await appendBuildLog(
      leased.id,
      'platform',
      `Building on ${builderId} (attempt ${leased.attempts}).`,
    );
  }
  return leased;
}

/** Builder mode: extend a lease. Returns false when the build moved on. */
export async function renewBuildLease(
  buildId: string,
  builderId: string,
): Promise<boolean> {
  const [row] = await db
    .update(schema.appBuilds)
    .set({ leaseExpiresAt: new Date(Date.now() + BUILD_LEASE_MS) })
    .where(
      and(
        eq(schema.appBuilds.id, buildId),
        eq(schema.appBuilds.status, 'building'),
        eq(schema.appBuilds.builderId, builderId),
      ),
    )
    .returning({ id: schema.appBuilds.id });
  return Boolean(row);
}

/** Builder mode: the build of App source failed. */
export async function failBuild(
  buildId: string,
  builderId: string,
  message: string,
  code: BuildFailure['code'] = 'app_build_failed',
): Promise<void> {
  const failed = await transition(
    buildId,
    ['building'],
    {
      status: 'failed',
      errorCode: code,
      errorMessage: message.slice(0, 64_000),
    },
    eq(schema.appBuilds.builderId, builderId),
  );
  if (failed) await appendBuildLog(buildId, 'platform', 'Build failed.');
}

/** Builder mode: the builder holding `buildId`, if `builderId` still does. */
export async function leasedBuild(
  buildId: string,
  builderId: string,
): Promise<AppBuild | null> {
  return (
    (await db.query.appBuilds.findFirst({
      where: { id: buildId, builderId, status: 'building' },
    })) ?? null
  );
}

let sweeping: Promise<void> | undefined;

/**
 * Resolve deployments nobody is moving any more: lost builder leases are
 * queued again (or fail), local deployments without an upload time out, and
 * a verify or release interrupted by a platform restart is settled from
 * the recorded deployments.
 */
export function sweepBuilds(): Promise<void> {
  sweeping ??= (async () => {
    const now = Date.now();
    const lost = await db.query.appBuilds.findMany({
      where: {
        status: 'building',
        leaseExpiresAt: { lt: new Date(now) },
      },
    });
    for (const build of lost) {
      if (build.attempts < MAX_BUILD_ATTEMPTS) {
        const requeued = await transition(
          build.id,
          ['building'],
          { status: 'queued', builderId: null, leaseExpiresAt: null },
          lt(schema.appBuilds.leaseExpiresAt, new Date(now)),
        );
        if (requeued) {
          await notifyBuild(BUILD_QUEUE_CHANNEL);
          await appendBuildLog(
            build.id,
            'platform',
            `Builder ${build.builderId ?? 'unknown'} stopped responding; queued again.`,
          );
        }
      } else {
        const failed = await transition(
          build.id,
          ['building'],
          {
            status: 'failed',
            errorCode: 'builder_lost',
            errorMessage: 'The Builder stopped responding during the build.',
          },
          lt(schema.appBuilds.leaseExpiresAt, new Date(now)),
        );
        if (failed) {
          await appendBuildLog(
            build.id,
            'platform',
            'The Builder stopped responding during the build.',
          );
        }
      }
    }

    const waiting = await db.query.appBuilds.findMany({
      where: {
        status: 'awaiting_artifact',
        createdAt: { lt: new Date(now - ARTIFACT_WAIT_MS) },
      },
      columns: { id: true },
    });
    for (const build of waiting) {
      const failed = await transition(build.id, ['awaiting_artifact'], {
        status: 'failed',
        errorCode: 'artifact_timeout',
        errorMessage: 'No build package was uploaded in time.',
      });
      if (failed) {
        await appendBuildLog(
          build.id,
          'platform',
          'No build package was uploaded in time.',
        );
      }
    }

    const stalled = await db.query.appBuilds.findMany({
      where: {
        status: { in: ['verifying', 'releasing'] },
        updatedAt: { lt: new Date(now - RELEASE_STALL_MS) },
      },
    });
    for (const build of stalled) {
      const recorded = await db.query.deployments.findFirst({
        where: { id: build.id },
        columns: { version: true },
      });
      await transition(
        build.id,
        ['verifying', 'releasing'],
        recorded
          ? { status: 'ready', deploymentVersion: recorded.version }
          : {
              status: 'failed',
              errorCode: 'release_interrupted',
              errorMessage: 'The platform stopped while releasing.',
            },
      );
    }
  })().finally(() => {
    sweeping = undefined;
  });
  return sweeping;
}

let sweeper: ReturnType<typeof setInterval> | undefined;

/** Settle stalled deployments now and every half minute in this process. */
export async function ensureBuildSweeper(): Promise<void> {
  await sweepBuilds().catch((error) => {
    console.error('[apps] deployment sweep failed:', error);
  });
  sweeper ??= setInterval(() => {
    void sweepBuilds().catch((error) => {
      console.error('[apps] deployment sweep failed:', error);
    });
  }, 30_000);
  sweeper.unref?.();
}
