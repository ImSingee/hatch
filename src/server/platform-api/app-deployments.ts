/** Public deployment RPCs: create, upload, follow, list and cancel. */
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { db } from '~/db';
import {
  acceptArtifact,
  cancelDeployment,
  createDeployment,
  findDeploymentByRequest,
  getDeployment,
  isFinishedBuild,
  listDeployments,
  listDeploymentQueue,
  followBuildChanges,
  readBuildLog,
  type AppBuild,
  type BuildChangeFeed,
} from '~server/apps/builds';
import { projectAppManifestUrls } from '~server/apps/manifest';
import { associateAgentSessionApp } from '~server/agent-session-apps';
import { appManifestViewSchema } from '~/platform-api/views';
import { AppService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { publicApiContext } from './context';
import { publicApiError, publicError } from './errors';

/** How long one watch response may wait for news before it repeats state. */
const WATCH_HEARTBEAT_MS = 15_000;
/** Lines one watch message carries at most. */
const WATCH_BATCH_LINES = 2000;
/**
 * Body limit of a cancel: its `failure_message` may hold 64,000 characters,
 * and JSON may escape each as up to twelve bytes (a surrogate pair written
 * as two `\uXXXX`), so 1 MiB holds any message the schema allows with room
 * for the other fields.
 */
const CANCEL_BODY_LIMIT = 1024 * 1024;

async function appRow(id: string) {
  const lookup = (where: { id: string } | { slug: string }) =>
    db.query.apps.findFirst({
      where,
      columns: { id: true, slug: true, createdAt: true },
    });
  const row = (await lookup({ id })) ?? (await lookup({ slug: id }));
  if (!row) throw publicApiError('NOT_FOUND');
  return row;
}

/** Every credential has the same authority; a Run acts as the Agent. */
function actorOf(context: HandlerContext): string | null {
  const { status, run } = context.values.get(publicApiContext);
  if (run) return 'agent';
  return (status as { user?: { id?: string } } | undefined)?.user?.id ?? null;
}

async function associate(appId: string, context: HandlerContext) {
  const run = context.values.get(publicApiContext).run;
  if (run) await associateAgentSessionApp(run.sessionId, appId);
}

/** The public projection of a deployment request. */
export async function deploymentMessage(row: AppBuild, slug: string) {
  let deployment;
  if (row.status === 'ready') {
    const recorded = await db.query.deployments.findFirst({
      where: { id: row.id, appId: row.appId },
      columns: {
        version: true,
        compatibilityVersion: true,
        manifestNormalized: true,
      },
    });
    if (recorded) {
      const normalized = appManifestViewSchema.parse(
        projectAppManifestUrls(
          recorded.manifestNormalized as never,
          row.appId,
          slug,
        ),
      );
      deployment = {
        deploymentId: row.id,
        version: recorded.version,
        compatibilityVersion: recorded.compatibilityVersion ?? 1,
        slug,
        normalized: fromJson(ValueSchema, normalized as JsonValue),
      };
    }
  }
  return {
    id: row.id,
    appId: row.appId,
    seq: row.seq,
    commit: row.commit,
    message: row.message,
    build: row.mode,
    trigger: row.trigger,
    actor: row.actor ?? undefined,
    status: row.status,
    finished: isFinishedBuild(row.status),
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    deployment,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    logSeq: row.logSeq,
  };
}

export function registerAppDeploymentApi(
  router: ConnectRouter,
  artifactBodyLimit: number,
) {
  router.rpc(AppService.method.createAppDeployment, async (input, context) => {
    try {
      const app = await appRow(input.id);
      await associate(app.id, context);
      if (input.generation !== app.createdAt.toISOString())
        throw publicApiError('RESOURCE_GENERATION_CONFLICT');
      const row = await createDeployment({
        appId: app.id,
        commit: input.commit,
        message: input.message,
        build: input.build as 'builder' | 'local',
        trigger: 'cli',
        actor: actorOf(context),
        expectedGeneration: input.generation,
        allowDestructiveDataMigration: input.allowDestructiveDataMigration,
        dataMigrationApprovalToken: input.dataMigrationApprovalToken,
        notify: input.notify,
        requestId: input.requestId,
        signal: context.signal,
      });
      return { deployment: await deploymentMessage(row, app.slug) };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(
    AppService.method.uploadAppDeploymentArtifact,
    async (input, context) => {
      try {
        const app = await appRow(input.id);
        await associate(app.id, context);
        const row = await acceptArtifact({
          appId: app.id,
          buildId: input.deploymentId,
          archive: input.artifact,
        });
        // The slug may change with the release.
        const released = await appRow(app.id);
        return { deployment: await deploymentMessage(row, released.slug) };
      } catch (error) {
        throw publicError(error);
      }
    },
    { readMaxBytes: artifactBodyLimit },
  );
  router.rpc(AppService.method.getAppDeployment, async (input) => {
    try {
      const app = await appRow(input.id);
      const row = await getDeployment(app.id, input.deploymentId);
      return { deployment: await deploymentMessage(row, app.slug) };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(AppService.method.listAppDeployments, async (input) => {
    try {
      const app = await appRow(input.id);
      if (input.requestId) {
        const row = await findDeploymentByRequest(app.id, input.requestId);
        return {
          deployments: row ? [await deploymentMessage(row, app.slug)] : [],
          nextCursor: undefined,
        };
      }
      const page = await listDeployments(app.id, {
        limit: input.limit ?? 20,
        cursor: input.cursor,
      });
      return {
        deployments: await Promise.all(
          page.items.map((row) => deploymentMessage(row, app.slug)),
        ),
        nextCursor: page.nextCursor ?? undefined,
      };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(AppService.method.listDeploymentQueue, async (input) => {
    try {
      const page = await listDeploymentQueue({
        limit: input.limit ?? 50,
        cursor: input.cursor,
      });
      return {
        entries: await Promise.all(
          page.items.map(async (item) => ({
            appSlug: item.app.slug,
            appName: item.app.name,
            deployment: await deploymentMessage(item.build, item.app.slug),
            queuePosition: item.queuePosition ?? undefined,
            builderId:
              item.build.status === 'building' && item.build.builderId
                ? item.build.builderId
                : undefined,
          })),
        ),
        nextCursor: page.nextCursor ?? undefined,
      };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(
    AppService.method.cancelAppDeployment,
    async (input, context) => {
      try {
        const app = await appRow(input.id);
        const row = await cancelDeployment(
          app.id,
          input.deploymentId,
          actorOf(context),
          input.failureMessage
            ? {
                code:
                  input.failureCode === 'APP_MANIFEST_INVALID'
                    ? 'APP_MANIFEST_INVALID'
                    : 'app_build_failed',
                message: input.failureMessage,
              }
            : undefined,
        );
        return { deployment: await deploymentMessage(row, app.slug) };
      } catch (error) {
        throw publicError(error);
      }
    },
    { readMaxBytes: CANCEL_BODY_LIMIT },
  );
  router.rpc(
    AppService.method.watchAppDeploymentLogs,
    async function* (input, context) {
      let after = input.afterSeq ?? 0;
      let lastState: string | undefined;
      let lastYieldAt = 0;
      let changes: BuildChangeFeed | undefined;
      try {
        const app = await appRow(input.id);
        // Followed before the first read: a change committed while a frame
        // is read or sent ends the next wait at once.
        changes = await followBuildChanges(input.deploymentId);
        for (;;) {
          context.signal.throwIfAborted();
          const row = await getDeployment(app.id, input.deploymentId);
          // Lines up to the `logSeq` of the row this message carries: a
          // line committed after the row was read waits for the next one,
          // so no message reports lines past its own watermark.
          const lines = [];
          while (lines.length < WATCH_BATCH_LINES && after < row.logSeq) {
            const batch = await readBuildLog(
              row.id,
              after,
              Math.min(500, WATCH_BATCH_LINES - lines.length),
              row.logSeq,
            );
            if (batch.length === 0) break;
            lines.push(...batch);
            after = batch.at(-1)!.seq;
          }
          const state = `${row.status}:${row.updatedAt.toISOString()}`;
          const finished = isFinishedBuild(row.status) && after >= row.logSeq;
          if (
            lines.length ||
            state !== lastState ||
            finished ||
            Date.now() - lastYieldAt >= WATCH_HEARTBEAT_MS
          ) {
            lastState = state;
            lastYieldAt = Date.now();
            // By its immutable id: the App may be renamed while followed.
            const current = await appRow(app.id);
            yield {
              lines: lines.map((line) => ({
                seq: line.seq,
                stream: line.stream,
                text: line.text,
                at: line.at.toISOString(),
              })),
              deployment: await deploymentMessage(row, current.slug),
            };
          }
          if (finished) return;
          if (lines.length >= WATCH_BATCH_LINES) continue;
          await changes.wait(WATCH_HEARTBEAT_MS, context.signal);
        }
      } catch (error) {
        if (context.signal.aborted) return;
        throw publicError(error);
      } finally {
        // Also when the client stops reading at a `yield`.
        changes?.close();
      }
    },
  );
}
