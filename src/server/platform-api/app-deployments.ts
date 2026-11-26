/** Public deployment RPCs: create, upload, follow, list and cancel. */
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { db } from '~/db';
import {
  acceptArtifact,
  cancelDeployment,
  createDeployment,
  getDeployment,
  isFinishedBuild,
  listDeployments,
  readBuildLog,
  waitForBuildChange,
  type AppBuild,
} from '~server/apps/builds';
import { projectAppManifestUrls } from '~server/apps/manifest';
import { associateAgentSessionApp } from '~server/agent-session-apps';
import { appManifestViewSchema } from '~/platform-api/views';
import { AppService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { publicApiContext } from './context';
import { publicApiError, publicError } from './errors';

/** How long one watch response may wait for news before it repeats state. */
const WATCH_HEARTBEAT_MS = 15_000;

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
        build: input.build as 'auto' | 'builder' | 'local',
        trigger: 'cli',
        actor: actorOf(context),
        expectedGeneration: input.generation,
        allowDestructiveDataMigration: input.allowDestructiveDataMigration,
        dataMigrationApprovalToken: input.dataMigrationApprovalToken,
        notify: input.notify,
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
  router.rpc(AppService.method.cancelAppDeployment, async (input, context) => {
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
  });
  router.rpc(
    AppService.method.watchAppDeploymentLogs,
    async function* (input, context) {
      let after = input.afterSeq ?? 0;
      let lastState: string | undefined;
      let lastYieldAt = 0;
      try {
        const app = await appRow(input.id);
        for (;;) {
          context.signal.throwIfAborted();
          const row = await getDeployment(app.id, input.deploymentId);
          // Read lines up to the state just read, so a finished deployment's
          // last message follows its last line.
          const lines = [];
          for (;;) {
            const batch = await readBuildLog(row.id, after);
            lines.push(...batch);
            if (batch.length === 0) break;
            after = batch.at(-1)!.seq;
            if (lines.length >= 2000) break;
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
            yield {
              lines: lines.map((line) => ({
                seq: line.seq,
                stream: line.stream,
                text: line.text,
                at: line.at.toISOString(),
              })),
              deployment: await deploymentMessage(row, app.slug),
            };
          }
          if (finished) return;
          if (lines.length >= 2000) continue;
          await waitForBuildChange(row.id, WATCH_HEARTBEAT_MS, context.signal);
        }
      } catch (error) {
        if (context.signal.aborted) return;
        throw publicError(error);
      }
    },
  );
}
