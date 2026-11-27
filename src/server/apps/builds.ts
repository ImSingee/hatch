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
import { and, eq, exists, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { BUILD_WORK_DIR } from '~agent/paths';
import { db, schema } from '~/db';
import type { AppBuildMode, AppBuildStatus, JsonObject } from '~/db/schema';
import { AppError } from '~server/errors';
import { DeploymentRequestError } from './deployment-errors';
import {
  FAILURE_MESSAGE_MAX_CHARS,
  LOG_LINE_MAX_CHARS,
} from '../../builder/protocol';
import { BuildArchiveError, unpackBuildArchive } from '../../app-build/archive';
import { platformSdkDigest } from '../platform-api/sdk';
import { asBuildError } from './build';
import { platformBuildHost } from './build-host';
import { NshpkgUnavailableError } from './native/nshpkg';
import { DataMigrationApprovalRequired } from './data-table/migrate';
import { builderConfigured, builderOnline } from './builders';
import { tryWithAppDataCutoverLock } from './data-table/provision';
import {
  reconcilePendingActivation,
  ReleaseGenerationConflict,
  ReleaseUnfinished,
  releaseDeployment,
} from './deploy';
import { appDeployLock } from './deploy-lock';
import { BuildPackageError, finalizeBuild } from './finalize';
import { checkoutAppCommit, resolveDeployCommit } from './git';
import { COMMIT_NOT_ON_MASTER_ERROR } from '../source-git';
import { evaluateAppSourceManifest } from '../../app-build/produce';
import { withSandboxOwnership } from '~agent/shell-sandbox';
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
/**
 * Leases are set and judged by the database clock, read when the row is
 * checked (see `lockBuildRow`): `now()` is the transaction's start, and a
 * write that waited on a row lock must not pass on a lease that expired
 * while it waited. One clock for every instance, whatever their hosts'
 * clocks say.
 */
const DB_NOW = sql`clock_timestamp()`;
const LEASE_UNTIL = sql`clock_timestamp() + ${BUILD_LEASE_MS}::integer * interval '1 millisecond'`;
/** Lease losses before a build fails instead of being queued again. */
const MAX_BUILD_ATTEMPTS = 2;
/** How long a local-mode deployment waits for its upload. */
export const ARTIFACT_WAIT_MS = 30 * 60_000;
/** A verify or release with no progress for this long was interrupted. */
const RELEASE_STALL_MS = 30 * 60_000;
/**
 * How often a release in progress touches its request, so the sweeper of
 * any instance sees it is alive however long a step (a data migration, say)
 * takes; only a release whose process stopped goes quiet.
 */
export const RELEASE_HEARTBEAT_MS = 60_000;
const LOG_CHANNEL = 'hatch_app_builds';
/** Followers waiting for queued builder work (Builder lease requests). */
export const BUILD_QUEUE_CHANNEL = 'queue';
const MAX_LOG_LINE = LOG_LINE_MAX_CHARS;
/**
 * Log rows per INSERT: each binds four parameters, and PostgreSQL takes at
 * most 65,535 in one statement (a local build's package log can be long).
 */
const LOG_INSERT_ROWS = 4_000;

async function notifyBuild(buildId: string): Promise<void> {
  await db
    .execute(sql`select pg_notify(${LOG_CHANNEL}, ${buildId})`)
    .catch(() => {});
}

/** Append log lines to a build; returns the last sequence number. */
type LogEntry = {
  stream: 'build' | 'platform';
  text: string | readonly string[];
};
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function logLines(text: string | readonly string[]): string[] {
  return (typeof text === 'string' ? text.split('\n') : [...text])
    .map((line) => line.replace(/\r$/, '').slice(0, MAX_LOG_LINE))
    .filter((line, index, all) => line || index < all.length - 1);
}

/**
 * Lock the build row inside `tx`, before a guarded write judges it. An
 * UPDATE that finds its row locked waits, and PostgreSQL checks its WHERE
 * again only if the holder committed a change to the row; after a rollback
 * the write goes ahead on the look it took before waiting, though a lease
 * may have run out meanwhile. Holding the lock first, the guarded statement
 * never waits: it reads the row, and the clock, with the lock held.
 */
async function lockBuildRow(tx: Tx, buildId: string): Promise<void> {
  await tx
    .select({ id: schema.appBuilds.id })
    .from(schema.appBuilds)
    .where(eq(schema.appBuilds.id, buildId))
    .for('update');
}

/**
 * Append lines inside `tx`. `guard` narrows the build row the append may
 * touch (a Builder's current lease, say); returns null when it matched none.
 */
async function insertLog(
  tx: Tx,
  buildId: string,
  entry: LogEntry,
  guard?: ReturnType<typeof and>,
): Promise<number | null> {
  const lines = logLines(entry.text);
  if (lines.length === 0) return null;
  if (guard) await lockBuildRow(tx, buildId);
  const [row] = await tx
    .update(schema.appBuilds)
    .set({ logSeq: sql`${schema.appBuilds.logSeq} + ${lines.length}` })
    .where(and(eq(schema.appBuilds.id, buildId), guard))
    .returning({ logSeq: schema.appBuilds.logSeq });
  if (!row) return null;
  const first = row.logSeq - lines.length + 1;
  for (let start = 0; start < lines.length; start += LOG_INSERT_ROWS) {
    await tx.insert(schema.appBuildLogs).values(
      lines.slice(start, start + LOG_INSERT_ROWS).map((line, index) => ({
        buildId,
        seq: first + start + index,
        stream: entry.stream,
        text: line,
      })),
    );
  }
  return row.logSeq;
}

export async function appendBuildLog(
  buildId: string,
  stream: 'build' | 'platform',
  text: string | readonly string[],
  guard?: ReturnType<typeof and>,
): Promise<number | null> {
  if (logLines(text).length === 0) return null;
  const last = await db.transaction((tx) =>
    insertLog(tx, buildId, { stream, text }, guard),
  );
  if (last !== null) await notifyBuild(buildId);
  return last;
}

/** A log line that must not fail the operation it describes. */
async function appendBuildLogQuietly(
  buildId: string,
  stream: 'build' | 'platform',
  text: string | readonly string[],
): Promise<void> {
  await appendBuildLog(buildId, stream, text).catch((error) => {
    console.error(`[apps] log of ${buildId} not written:`, error);
  });
}

type TransitionValues = Partial<typeof schema.appBuilds.$inferInsert> & {
  status: AppBuildStatus;
};

/**
 * Move a build between states inside `tx`; null when the move matched none.
 * `extra` narrows the row further (a lease, say), judged with the row locked.
 */
async function moveBuild(
  tx: Tx,
  buildId: string,
  from: readonly AppBuildStatus[],
  values: TransitionValues,
  extra?: ReturnType<typeof and>,
  /**
   * Written in the same transaction, so a follower never sees the new state
   * (a finished deployment, say) without the line that explains it.
   */
  log?: LogEntry,
): Promise<AppBuild | null> {
  const finished = isFinishedBuild(values.status);
  if (extra) await lockBuildRow(tx, buildId);
  const [moved] = await tx
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
  if (!moved) return null;
  if (!log) return moved;
  const logSeq = await insertLog(tx, buildId, log);
  return logSeq === null ? moved : { ...moved, logSeq };
}

/** After a committed move: wake followers, post an asked-for notification. */
async function announceMove(row: AppBuild): Promise<void> {
  await notifyBuild(row.id);
  if (
    row.notifyOnFinish &&
    (row.status === 'ready' || row.status === 'failed')
  ) {
    void notifyDeploymentFinished(row).catch((error) => {
      console.error(`[apps] notification for ${row.id} failed:`, error);
    });
  }
}

/** Move a build between states; returns the row when the move applied. */
async function transition(
  buildId: string,
  from: readonly AppBuildStatus[],
  values: TransitionValues,
  extra?: ReturnType<typeof and>,
  log?: LogEntry,
): Promise<AppBuild | null> {
  const row = await db.transaction((tx) =>
    moveBuild(tx, buildId, from, values, extra, log),
  );
  if (row) await announceMove(row);
  return row;
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
  /** Where the commit is built: the platform's Builder, or the caller. */
  build: AppBuildMode;
  trigger: 'cli' | 'ui';
  actor: string | null;
  expectedGeneration?: string;
  allowDestructiveDataMigration?: boolean;
  dataMigrationApprovalToken?: string;
  /** Post a platform notification when it finishes. */
  notify?: boolean;
  /**
   * Client-chosen id of this create request. Repeating it returns the
   * deployment it already made (see `findDeploymentByRequest`).
   */
  requestId?: string;
  /**
   * The request's signal: once the caller has given up, nothing is
   * created, so a client that saw its create fail can trust that.
   */
  signal?: AbortSignal;
};

/** Create a deployment of a pushed commit. */
export async function createDeployment(
  input: CreateDeploymentInput,
): Promise<AppBuild> {
  const message = input.message.trim();
  if (!message) throw new AppError('A deployment message is required.', 400);
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
  const requestId = input.requestId || null;
  // A repeated request gets the deployment it made, even if its commit has
  // left master since (a restore) or the platform has no Builder any more:
  // look it up before checking the source or the build mode.
  if (requestId) {
    const repeated = await deploymentOfRequest(db, input.appId, requestId);
    if (repeated) return repeated;
  }
  const mode = input.build;
  // A Builder build is refused up front where nothing would take it, rather
  // than queued to wait without end: build locally instead.
  if (mode === 'builder') {
    if (!builderConfigured()) {
      throw new DeploymentRequestError(
        'BUILDER_UNAVAILABLE',
        'This platform has no dedicated Builder. Build the commit on this ' +
          'machine and upload it with `hatch app deploy --local`.',
      );
    }
    if (!(await builderOnline())) {
      throw new DeploymentRequestError(
        'BUILDER_OFFLINE',
        'No Builder has connected to this platform recently, so nothing ' +
          'would build the deployment. Build it on this machine and upload ' +
          'it with `hatch app deploy --local`, or start a Builder and retry.',
      );
    }
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
    if (requestId) {
      // A concurrent first submission of the same request committed first.
      const repeated = await deploymentOfRequest(tx, input.appId, requestId);
      if (repeated) return { row: repeated, joined: true };
    }
    /** This request gets `buildId`: recorded so a repeat finds it. */
    const record = async (buildId: string) => {
      if (!requestId) return;
      await tx
        .insert(schema.appBuildRequests)
        .values({ appId: input.appId, requestId, buildId });
    };
    if (mode === 'builder') {
      // The same request while its build is still waiting or running joins
      // that build instead of building the commit twice. Only an identical
      // request joins: the release note is the deployment's.
      const existing = await tx.query.appBuilds.findFirst({
        where: {
          appId: input.appId,
          commit,
          message,
          mode: 'builder',
          status: { in: ['queued', 'building'] },
          allowDestructiveDataMigration: allowDestructive,
          dataMigrationApprovalToken: approvalToken ?? { isNull: true },
        },
        orderBy: { seq: 'desc' },
        columns: { id: true },
      });
      // Joined only while it is still unfinished, checked in the same write
      // that asks for its notification: a build that finished in between
      // already sent (or skipped) its notification, so this request gets a
      // deployment of its own instead.
      const [joined] = existing
        ? await tx
            .update(schema.appBuilds)
            .set({
              notifyOnFinish: sql`${schema.appBuilds.notifyOnFinish} or ${Boolean(input.notify)}::boolean`,
            })
            .where(
              and(
                eq(schema.appBuilds.id, existing.id),
                inArray(schema.appBuilds.status, ['queued', 'building']),
              ),
            )
            .returning()
        : [];
      if (joined) {
        await record(joined.id);
        // Both writes roll back for a caller that has already given up.
        throwIfCanceled(input.signal);
        return { row: joined, joined: true };
      }
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
    await record(row.id);
    await insertLog(tx, row.id, {
      stream: 'platform',
      text:
        mode === 'builder'
          ? `Deployment queued for the Builder: ${commit}`
          : `Deployment waiting for the local build of ${commit}`,
    });
    // Commit nothing for a caller that has already given up on this call.
    throwIfCanceled(input.signal);
    return { row, joined: false, superseded: superseded.map((s) => s.id) };
  });
  if (created.joined) return created.row;
  for (const id of created.superseded ?? []) await notifyBuild(id);
  if (mode === 'builder') await notifyBuild(BUILD_QUEUE_CHANNEL);
  await notifyBuild(created.row.id);
  return (await getDeploymentRow(input.appId, created.row.id)) ?? created.row;
}

/** Inside a create's transaction: roll it back once the caller gave up. */
function throwIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError('The create request was canceled.', 499);
  }
}

/** The deployment a create request with `requestId` made, if it made one. */
export async function findDeploymentByRequest(
  appId: string,
  requestId: string,
): Promise<AppBuild | null> {
  await sweepBuilds().catch(() => {});
  return deploymentOfRequest(db, appId, requestId);
}

async function deploymentOfRequest(
  client: typeof db | Tx,
  appId: string,
  requestId: string,
): Promise<AppBuild | null> {
  const [found] = await client
    .select({ build: schema.appBuilds })
    .from(schema.appBuildRequests)
    .innerJoin(
      schema.appBuilds,
      eq(schema.appBuilds.id, schema.appBuildRequests.buildId),
    )
    .where(
      and(
        eq(schema.appBuildRequests.appId, appId),
        eq(schema.appBuildRequests.requestId, requestId),
      ),
    );
  return found?.build ?? null;
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

/** Deployment states that are not finished, in the order they pass. */
const ACTIVE_STATUSES = [
  'queued',
  'awaiting_artifact',
  'building',
  'verifying',
  'releasing',
] as const satisfies readonly AppBuildStatus[];

export type QueuedDeployment = {
  build: AppBuild;
  app: { id: string; slug: string; name: string };
  /** 1-based place among queued Builder builds; only for `queued`. */
  queuePosition: number | null;
};

/**
 * Every unfinished deployment of every App, oldest first (ids are ULIDs, so
 * id order is creation order). Builders take queued builds oldest first,
 * one per App at a time, so a queued build's position is its place among
 * the queued ones.
 */
export async function listDeploymentQueue(options: {
  limit: number;
  cursor?: string;
}): Promise<{ items: QueuedDeployment[]; nextCursor: string | null }> {
  await sweepBuilds().catch(() => {});
  const rows = await db.query.appBuilds.findMany({
    where: {
      status: { in: [...ACTIVE_STATUSES] },
      ...(options.cursor ? { id: { gt: options.cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    limit: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const apps = page.length
    ? await db.query.apps.findMany({
        where: { id: { in: [...new Set(page.map((row) => row.appId))] } },
        columns: { id: true, slug: true, name: true },
      })
    : [];
  const appsById = new Map(apps.map((app) => [app.id, app]));
  // Queued builds ahead of this page, for the positions of those on it.
  const firstQueued = page.find((row) => row.status === 'queued');
  const [ahead] = firstQueued
    ? await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(schema.appBuilds)
        .where(
          and(
            eq(schema.appBuilds.status, 'queued'),
            lt(schema.appBuilds.id, firstQueued.id),
          ),
        )
    : [{ count: 0 }];
  let position = ahead?.count ?? 0;
  const items: QueuedDeployment[] = [];
  for (const build of page) {
    const app = appsById.get(build.appId);
    // Deleted meanwhile: its builds go with it.
    if (!app) continue;
    items.push({
      build,
      app,
      queuePosition: build.status === 'queued' ? ++position : null,
    });
  }
  return {
    items,
    nextCursor: rows.length > options.limit ? page.at(-1)!.id : null,
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
    const failed = await transition(
      row.id,
      ['awaiting_artifact'],
      {
        status: 'failed',
        errorCode: failure.code,
        errorMessage: failure.message.slice(0, FAILURE_MESSAGE_MAX_CHARS),
      },
      undefined,
      { stream: 'build', text: failure.message },
    );
    if (!failed) {
      throw new DeploymentRequestError(
        'DEPLOYMENT_NOT_AWAITING_ARTIFACT',
        `Deployment ${id} is ${row.status}; it is not waiting for a local build.`,
      );
    }
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
    undefined,
    { stream: 'platform', text: 'Deployment canceled.' },
  );
  if (!canceled) {
    throw new DeploymentRequestError(
      'DEPLOYMENT_NOT_CANCELABLE',
      `Deployment ${id} is ${row.status} and can no longer be canceled.`,
    );
  }
  return canceled;
}

export type BuildLogLine = {
  seq: number;
  stream: 'build' | 'platform';
  text: string;
  at: Date;
};

/**
 * Lines after `afterSeq`, oldest first; with `throughSeq`, none past it (a
 * follower bounds a batch by the `logSeq` of the row it sends with it).
 */
export async function readBuildLog(
  buildId: string,
  afterSeq: number,
  limit = 500,
  throughSeq?: number,
): Promise<BuildLogLine[]> {
  return db.query.appBuildLogs.findMany({
    where: {
      buildId,
      seq:
        throughSeq === undefined
          ? { gt: afterSeq }
          : { gt: afterSeq, lte: throughSeq },
    },
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

/** Changes of one build, followed from the moment the feed was opened. */
export type BuildChangeFeed = {
  /**
   * Resolve at the first change since the feed opened or the previous wait
   * returned (at once if one came meanwhile), at `timeoutMs`, or on abort.
   */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  /** Stop following; a wait in progress returns. */
  close(): void;
};

/**
 * Follow a build: open the feed, then read the build. A change committed
 * after the feed opened, even while the reader was still busy with its
 * last read, ends the next wait at once instead of at its timeout. A
 * notification lost elsewhere still waits for the timeout, after which the
 * reader re-reads durable state.
 */
export async function followBuildChanges(
  buildId: string,
): Promise<BuildChangeFeed> {
  let changed = false;
  let release: (() => void) | undefined;
  const waiter: Waiter = {
    buildId,
    wake: () => {
      changed = true;
      release?.();
    },
  };
  waiters.add(waiter);
  // LISTEN is in place before the caller's first read.
  await ensureListening();
  return {
    async wait(timeoutMs, signal) {
      if (!changed && !signal?.aborted && waiters.has(waiter)) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => done(), timeoutMs);
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            release = undefined;
            resolve();
          };
          release = done;
          signal?.addEventListener('abort', done, { once: true });
        });
      }
      changed = false;
    },
    close() {
      waiters.delete(waiter);
      release?.();
    },
  };
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
  // The platform cannot sign native packages: its fault, not the source's.
  if (error instanceof NshpkgUnavailableError)
    return 'platform_toolchain_unavailable';
  // The commit left master (a restore) after the deployment was created:
  // the same stable code a create of that commit gets.
  if (error instanceof AppError && error.code === COMMIT_NOT_ON_MASTER_ERROR)
    return 'COMMIT_NOT_ON_MASTER';
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
  if (error instanceof NshpkgUnavailableError) {
    // The tool's own message names server paths; this one does not.
    return (
      'This platform cannot sign native App packages: its hatch-nshpkg tool ' +
      'is missing. The operator builds it with `pnpm nshpkg:build` (or uses ' +
      'the published Docker image, which ships it), then deploys again.'
    );
  }
  const reported = asBuildError(error);
  if (reported instanceof AppError) return reported.message;
  return 'The release failed on the platform.';
}

/** A Builder's hold on one build: valid only for the attempt it leased. */
export type BuildLease = { builderId: string; attempt: number };

/**
 * Row predicate: the build is still held by exactly this lease, and the lease
 * has not expired (the sweeper may not have reclaimed it yet), by the
 * database clock when the row is checked (see `DB_NOW`). A write guarded by
 * it locks the row first (`lockBuildRow`).
 */
function heldBy(lease: BuildLease) {
  return and(
    eq(schema.appBuilds.status, 'building'),
    eq(schema.appBuilds.builderId, lease.builderId),
    eq(schema.appBuilds.attempts, lease.attempt),
    gt(schema.appBuilds.leaseExpiresAt, DB_NOW),
  );
}

export type AcceptArtifactInput = {
  appId: string;
  buildId: string;
  /** The gzipped build package (src/app-build/archive.ts). */
  archive: Uint8Array;
  /** Builder mode: the lease the package was built under. */
  lease?: BuildLease;
};

/**
 * Accept the build package of one deployment and release it. Returns the
 * deployment in its final state; a rejected package is a `failed`
 * deployment, not an error. The one exception is a release that was
 * recorded (or perhaps was) but did not finish activating: it is returned
 * still `releasing`, and the sweep settles it once recovery succeeds.
 */
export async function acceptArtifact(
  input: AcceptArtifactInput,
): Promise<AppBuild> {
  const row = await getDeployment(input.appId, input.buildId);
  const fromState: AppBuildStatus =
    row.mode === 'builder' ? 'building' : 'awaiting_artifact';
  if (
    (row.mode === 'builder') !== (input.lease !== undefined) ||
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
    input.lease ? heldBy(input.lease) : undefined,
    { stream: 'platform', text: 'Verifying the build package.' },
  );
  if (!verifying) {
    throw new DeploymentRequestError(
      'DEPLOYMENT_NOT_AWAITING_ARTIFACT',
      `Deployment ${row.id} changed state; it does not accept a build package now.`,
    );
  }

  // From here the deployment is this call's: every way out settles it.
  const work = path.join(BUILD_WORK_DIR, row.appId, `accept-${randomUUID()}`);
  let released: { version: number };
  const heartbeat = setInterval(() => {
    void db
      .update(schema.appBuilds)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(schema.appBuilds.id, row.id),
          inArray(schema.appBuilds.status, ['verifying', 'releasing']),
        ),
      )
      .catch((error) => {
        console.error(`[apps] heartbeat of ${row.id} failed:`, error);
      });
  }, RELEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const packageDir = path.join(work, 'package');
    await fs.mkdir(work, { recursive: true });
    await unpackBuildArchive(input.archive, packageDir);
    const sdkDigest = await platformSdkDigest();
    released = await releaseDeployment(row.appId, {
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
          // Bytecode is trusted input to native shells: only the Builder's.
          trustBytecode: row.mode === 'builder',
          // The privilege the release gets comes from the commit, never from
          // the package: the platform evaluates the manifest itself.
          committedManifest: async () => {
            const tree = path.join(work, 'committed');
            await checkoutAppCommit(row.appId, row.commit, tree);
            // Authored code (and, if the manifest needs packages, their
            // install) runs as the sandbox identity, with a home and pnpm
            // store of its own that nothing else reuses.
            const sandbox = {
              home: path.join(work, 'evaluation-home'),
              pnpmStoreDir: path.join(work, 'evaluation-store'),
            };
            const scratch = path.join(work, 'evaluation');
            for (const dir of [sandbox.home, sandbox.pnpmStoreDir, scratch]) {
              await fs.mkdir(dir, { recursive: true });
            }
            const { manifest, installed } = await evaluateAppSourceManifest(
              platformBuildHost({ sdkDigest, workDir: scratch, sandbox }),
              {
                appId: row.appId,
                sourceDir: tree,
                maxInstallBytes: MANIFEST_INSTALL_MAX_BYTES,
                withSource: (src, task) =>
                  withSandboxOwnership(
                    [src, sandbox.home, sandbox.pnpmStoreDir],
                    task,
                  ),
              },
            );
            await appendBuildLogQuietly(
              row.id,
              'platform',
              installed
                ? 'Evaluated the manifest of the commit (with its dependencies).'
                : 'Evaluated the manifest of the commit.',
            );
            return manifest;
          },
        });
        await db
          .update(schema.appBuilds)
          .set({ buildMetadata: { tooling } as unknown as JsonObject })
          .where(eq(schema.appBuilds.id, row.id));
        // A local build streamed nothing here; its package carries the log.
        if (row.mode === 'local' && result.log) {
          await appendBuildLogQuietly(row.id, 'build', result.log);
        }
        return result;
      },
      beforeRelease: async () => {
        // A newer release wins; a cancellation never reaches here because
        // only queued, waiting or building deployments can be canceled. This
        // runs under the App's release lock, and a newer release counts from
        // its committed deployment row: its request turns `ready` only after
        // the lock is released (or never, if the platform stopped between).
        const [newer] = await db
          .select({ id: schema.appBuilds.id })
          .from(schema.appBuilds)
          .where(
            and(
              eq(schema.appBuilds.appId, row.appId),
              gt(schema.appBuilds.seq, row.seq),
              or(
                eq(schema.appBuilds.status, 'ready'),
                exists(
                  db
                    .select({ id: schema.deployments.id })
                    .from(schema.deployments)
                    .where(
                      and(
                        eq(schema.deployments.buildId, schema.appBuilds.id),
                        eq(schema.deployments.status, 'deployed'),
                      ),
                    ),
                ),
              ),
            ),
          )
          .limit(1);
        if (newer) throw new SupersededRelease(newer.id);
        const releasing = await transition(
          row.id,
          ['verifying'],
          { status: 'releasing' },
          undefined,
          { stream: 'platform', text: 'Build package accepted. Releasing.' },
        );
        if (!releasing) throw new Error('The deployment changed state.');
      },
      // Under the locks the sweeper settles a stalled release with: a
      // request another instance already settled (`release_interrupted`,
      // say) changes and records nothing, so the two never disagree.
      fenceRelease: async (tx) => {
        const [current] = await tx
          .select({ status: schema.appBuilds.status })
          .from(schema.appBuilds)
          .where(eq(schema.appBuilds.id, row.id))
          .for('update');
        if (
          current?.status !== 'verifying' &&
          current?.status !== 'releasing'
        ) {
          throw new SettledRelease(current?.status ?? 'missing');
        }
      },
    });
  } catch (error) {
    clearInterval(heartbeat);
    await cleanUp(work);
    // Settled elsewhere before anything was recorded: that outcome stands.
    if (error instanceof SettledRelease) {
      return getDeployment(row.appId, row.id);
    }
    // Recorded, or perhaps recorded, so not a failure: the request stays
    // `releasing` until the sweep has recovered the activation.
    if (error instanceof ReleaseUnfinished) {
      console.error(`[apps] release of ${row.id} did not finish:`, error);
      return (
        (await handOverUnfinishedRelease(row.id, error)) ??
        (await getDeployment(row.appId, row.id))
      );
    }
    if (error instanceof SupersededRelease) {
      return (
        (await transition(
          row.id,
          ['verifying', 'releasing'],
          {
            status: 'superseded',
            errorCode: 'superseded',
            errorMessage: `Deployment ${error.newerId} was released first.`,
          },
          undefined,
          {
            stream: 'platform',
            text: `Not released: deployment ${error.newerId} was released first.`,
          },
        )) ?? (await getDeployment(row.appId, row.id))
      );
    }
    const code = failureCode(error);
    const message = failureMessage(error);
    if (code === 'release_failed') {
      console.error(`[apps] release of ${row.id} failed:`, error);
    }
    return (
      (await transition(
        row.id,
        ['verifying', 'releasing'],
        { status: 'failed', errorCode: code, errorMessage: message },
        undefined,
        { stream: 'platform', text: message },
      )) ?? (await getDeployment(row.appId, row.id))
    );
  }
  // The release is committed and live: nothing after this may record the
  // deployment as failed.
  clearInterval(heartbeat);
  await cleanUp(work);
  return (
    (await transition(
      row.id,
      ['releasing'],
      { status: 'ready', deploymentVersion: released.version },
      undefined,
      { stream: 'platform', text: `Released version ${released.version}.` },
    )) ?? (await getDeployment(row.appId, row.id))
  );
}

/**
 * Leave an unfinished release to the sweep, which recovers its activation
 * and settles the request from the recorded deployments. The request is
 * marked as gone quiet, so the next sweep of any instance takes it up
 * rather than one a stall limit from now.
 */
async function handOverUnfinishedRelease(
  buildId: string,
  error: ReleaseUnfinished,
): Promise<AppBuild | null> {
  const row = await db.transaction(async (tx) => {
    // The line first: a log append advances updatedAt as well.
    await insertLog(
      tx,
      buildId,
      {
        stream: 'platform',
        text:
          error.version === null
            ? 'The release may have been recorded; recovering it.'
            : `Released version ${error.version}; finishing its activation failed, retrying.`,
      },
      eq(schema.appBuilds.status, 'releasing'),
    );
    return moveBuild(
      tx,
      buildId,
      ['releasing'],
      {
        status: 'releasing',
        updatedAt: new Date(Date.now() - RELEASE_STALL_MS - 1),
      },
      undefined,
    );
  });
  if (row) await notifyBuild(row.id);
  return row;
}

async function cleanUp(work: string): Promise<void> {
  await fs.rm(work, { recursive: true, force: true }).catch((error) => {
    console.error(`[apps] could not remove ${work}:`, error);
  });
}

/** Largest dependency tree the platform installs to evaluate a manifest. */
const MANIFEST_INSTALL_MAX_BYTES = 1024 * 1024 * 1024;

/** The request was settled by another instance while it was releasing. */
class SettledRelease extends Error {
  constructor(readonly status: string) {
    super(`The deployment is ${status}; its release was not recorded.`);
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
  const leased = await claimQueuedBuild(builderId).catch((error) => {
    // Another claim for the same App won the one-building index: nothing to
    // take from this App right now.
    if (uniqueViolation(error)) return null;
    throw error;
  });
  if (leased) await notifyBuild(leased.id);
  return leased;
}

function uniqueViolation(error: unknown): boolean {
  for (let cause = error; cause; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

function claimQueuedBuild(builderId: string): Promise<AppBuild | null> {
  return db.transaction(async (tx) => {
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
        leaseExpiresAt: LEASE_UNTIL,
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
    if (!row) return null;
    // Committed with the claim, so a lease is never lost to its log line.
    const logSeq = await insertLog(tx, row.id, {
      stream: 'platform',
      text: `Building on ${builderId} (attempt ${row.attempts}).`,
    });
    return { ...row, logSeq: logSeq ?? row.logSeq };
  });
}

/** Builder mode: extend a lease. Returns false when the build moved on. */
export async function renewBuildLease(
  buildId: string,
  lease: BuildLease,
): Promise<boolean> {
  const [row] = await db.transaction(async (tx) => {
    await lockBuildRow(tx, buildId);
    return tx
      .update(schema.appBuilds)
      .set({ leaseExpiresAt: LEASE_UNTIL })
      .where(and(eq(schema.appBuilds.id, buildId), heldBy(lease)))
      .returning({ id: schema.appBuilds.id });
  });
  return Boolean(row);
}

/** Builder mode: log lines of a build, accepted only from its lease. */
export async function appendLeasedBuildLog(
  buildId: string,
  lease: BuildLease,
  lines: readonly string[],
): Promise<boolean> {
  if (logLines(lines).length === 0) return true;
  return (
    (await appendBuildLog(buildId, 'build', lines, heldBy(lease))) !== null
  );
}

/** Builder mode: the build of App source failed. */
export async function failBuild(
  buildId: string,
  lease: BuildLease,
  message: string,
  code: BuildFailure['code'] = 'app_build_failed',
): Promise<boolean> {
  const failed = await transition(
    buildId,
    ['building'],
    {
      status: 'failed',
      errorCode: code,
      errorMessage: message.slice(0, FAILURE_MESSAGE_MAX_CHARS),
    },
    heldBy(lease),
    { stream: 'platform', text: 'Build failed.' },
  );
  return Boolean(failed);
}

/** Builder mode: the builder holding `buildId`, if `builderId` still does. */
export async function leasedBuild(
  buildId: string,
  builderId: string,
): Promise<AppBuild | null> {
  const [row] = await db
    .select()
    .from(schema.appBuilds)
    .where(
      and(
        eq(schema.appBuilds.id, buildId),
        eq(schema.appBuilds.builderId, builderId),
        eq(schema.appBuilds.status, 'building'),
        gt(schema.appBuilds.leaseExpiresAt, DB_NOW),
      ),
    );
  return row ?? null;
}

/**
 * Row predicate: the build is still on the attempt the sweep found lost, and
 * its lease is still expired. Whether that attempt is queued again or fails
 * is decided from its count, so it must not land on a later attempt another
 * instance's sweep and a Builder started meanwhile.
 */
function lostAttempt(build: AppBuild) {
  return and(
    eq(schema.appBuilds.attempts, build.attempts),
    lt(schema.appBuilds.leaseExpiresAt, DB_NOW),
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
    const lost = await db
      .select()
      .from(schema.appBuilds)
      .where(
        and(
          eq(schema.appBuilds.status, 'building'),
          lt(schema.appBuilds.leaseExpiresAt, DB_NOW),
        ),
      );
    for (const build of lost) {
      if (build.attempts < MAX_BUILD_ATTEMPTS) {
        const requeued = await transition(
          build.id,
          ['building'],
          { status: 'queued', builderId: null, leaseExpiresAt: null },
          lostAttempt(build),
          {
            stream: 'platform',
            text: `Builder ${build.builderId ?? 'unknown'} stopped responding; queued again.`,
          },
        );
        if (requeued) await notifyBuild(BUILD_QUEUE_CHANNEL);
      } else {
        await transition(
          build.id,
          ['building'],
          {
            status: 'failed',
            errorCode: 'builder_lost',
            errorMessage: 'The Builder stopped responding during the build.',
          },
          lostAttempt(build),
          {
            stream: 'platform',
            text: 'The Builder stopped responding during the build.',
          },
        );
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
      await transition(
        build.id,
        ['awaiting_artifact'],
        {
          status: 'failed',
          errorCode: 'artifact_timeout',
          errorMessage: 'No build package was uploaded in time.',
        },
        undefined,
        { stream: 'platform', text: 'No build package was uploaded in time.' },
      );
    }

    const stalled = await db.query.appBuilds.findMany({
      where: {
        status: { in: ['verifying', 'releasing'] },
        updatedAt: { lt: new Date(now - RELEASE_STALL_MS) },
      },
    });
    for (const build of stalled) await settleStalledRelease(build);
  })().finally(() => {
    sweeping = undefined;
  });
  return sweeping;
}

/**
 * Settle a verify or release that stopped making progress, from the recorded
 * deployments. A release runs under the App's Data cutover lock, a session
 * lock its process keeps until the release ends or the process stops; the
 * sweep takes it in the same order (cutover, then the deploy lock inside its
 * transaction) and passes a request by for this sweep when someone holds it,
 * so a live release, however quiet, is never settled under it. Holding the
 * deploy lock as well means no release is mid-commit: the deployment row
 * read under it is final for this check. The move applies only while the
 * request is exactly as selected (every write to it, a state move or a log
 * line, advances updatedAt), so a release that resumed in between is left
 * alone; one that had not taken its locks yet stops at its fence.
 */
async function settleStalledRelease(build: AppBuild): Promise<void> {
  const outcome = await tryWithAppDataCutoverLock(build.appId, async () => {
    // A release that recorded its deployment but did not finish activating
    // it (or whose COMMIT went unconfirmed) still holds the App's activation
    // fence: recover it first, as platform startup does, and settle the
    // request only once that succeeded. Failing, it waits for the next sweep.
    const app = await db.query.apps.findFirst({
      where: { id: build.appId },
      columns: { dataActivationId: true },
    });
    if (app?.dataActivationId === build.id) {
      try {
        await reconcilePendingActivation(build.appId);
      } catch (error) {
        console.error(`[apps] recovery of release ${build.id} failed:`, error);
        return null;
      }
    }
    return db.transaction(async (tx) => {
      await appDeployLock.acquire(tx, build.appId);
      const recorded = await tx.query.deployments.findFirst({
        where: { id: build.id, appId: build.appId },
        columns: { version: true },
      });
      return moveBuild(
        tx,
        build.id,
        [build.status],
        recorded
          ? { status: 'ready', deploymentVersion: recorded.version }
          : {
              status: 'failed',
              errorCode: 'release_interrupted',
              errorMessage: 'The platform stopped while releasing.',
            },
        eq(schema.appBuilds.updatedAt, build.updatedAt),
        {
          stream: 'platform',
          text: recorded
            ? `Released version ${recorded.version}, confirmed from the recorded deployment.`
            : 'The platform stopped while releasing; nothing was released.',
        },
      );
    });
  });
  if (outcome.locked && outcome.value) await announceMove(outcome.value);
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
