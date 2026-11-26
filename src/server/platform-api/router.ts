import { listPage } from '~server/list-page';
import {
  MAX_TASK_INPUT_BYTES,
  cancelTaskRun,
  getTaskRun,
  listAppTasks,
  listTaskRuns,
  rotateAppWebhookSecret,
  startTaskRun,
} from '~server/apps/tasks/service';
import { runMessage, runSummaryMessage, tasksMessage } from './app-tasks';
import { fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { EmptyFilter } from 'drizzle-orm/relations';
import { AgentService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/agent_pb';
import { getAgentModelCatalog } from '~server/agent-model-catalog';
import { createHandoff } from '~server/handoffs';
import { updateDashboardAutoRefresh } from '~server/dashboard-settings';
import {
  insertAgentSession,
  listSessionSummaries,
  loadSessionDetail,
} from '~server/agent-session-store';
import { sessionOriginError } from '~server/session-http-auth';
import { sdkPayload } from './sdk';
import {
  ConnectError,
  type HandlerContext,
  type ConnectRouter,
} from '@connectrpc/connect';
import { publicApiContext } from './context';
import { registerNotificationApi } from './notifications';
import { AppService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { AuthService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import { SdkService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { publicApiError, publicError } from './errors';
import { AppError } from '~server/errors';
import { db } from '~/db';
import { deployApp } from '~server/apps/deploy';
import { importAppBundleToMaster } from '~server/apps/git';
import { rollbackAppToVersion } from '~server/apps/manage';
import {
  type AppBackendView,
  getAppBackend,
  listAppBackendsPage,
  restartBackendForApp,
  startBackendForApp,
  stopBackendForApp,
} from '~server/apps/backends';
import { createApp } from '~server/apps/scaffold';
import { authenticatePublicApi } from './auth';
import { listAppsForAgent, getAppDetailForAgent } from '~server/apps/inspect';
import { listAppDocs, readAppDoc } from '~server/apps/docs';
import type { PublishedAppDoc } from '~server/apps/manifest';
import { projectAppManifestUrls } from '~server/apps/manifest';
import {
  appSummarySchema,
  appDetailSchema,
  appManifestViewSchema,
} from '~/platform-api/views';
import {
  queryAppKvRequestSchema,
  queryAppDataTableRequestSchema,
} from '~/platform-api/data-schemas';
import { queryAppKv } from '~server/apps/query-kv';
import { queryAppDataTable } from '~server/apps/query-data-table';
import { queryAppDatabase } from '~server/apps/query-db';
import { associateAgentSessionApp } from '~server/agent-session-apps';
import { WorkspaceService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/workspace_pb';
import { readWorkspace } from '~server/workspace-read';
import { ImageService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/image_pb';
import {
  readDeskPreferences,
  updateDeskPreferences,
} from '~server/desk-preferences';
import { PreferenceService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/preference_pb';
import {
  readAgentPreferences,
  updateAgentPreferences,
} from '~server/agent-preferences';
import {
  readInterfacePreferences,
  updateInterfacePreferences,
  type InterfacePreferences,
} from '~server/interface-preferences';
import type { Locale } from '~i18n/locale';
import {
  appIconPath,
  clearAppIcon,
  getAppIcon,
  setAppIcon,
  setAppIconFromCandidate,
  type AppIconView,
  MAX_APP_ICON_BYTES,
} from '~server/apps/icon';
import { generateImages } from '~server/images/generate';
import {
  createImageModel,
  deleteImageModel,
  listImageModels,
  updateImageModel,
} from '~server/images/model';

import { ThemeService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/theme_pb';
import { ServerService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/server_pb';
import { buildInfo } from '~/build-info';
import { registerModelServices } from './model-rpc';
import { readTheme, updateTheme } from '~server/theme-settings';
import { PinService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/pin_pb';
import {
  listPins,
  pinApp,
  reorderAppPins,
  reorderDashboards,
  setDashboardPinned,
  unpinApp,
  updateAppPin,
} from '~server/pins';
import type { SidebarItem } from '~server/workspace-read';
import { DashboardService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/dashboard_pb';
import {
  addDashboardWidget,
  createDashboard,
  deleteDashboard,
  getDashboardData,
  listAvailableWidgets,
  listDashboards,
  removeDashboardWidget,
  setDashboardWidgetLayout,
  updateDashboard,
  type Dashboard,
  type DashboardData,
} from '~server/dashboard-service';
import type { DashboardBreakpoint } from '~/lib/dashboard-layout';

export { publicApiContext };
const dashboardMessage = (dashboard: Dashboard) => ({
  id: dashboard.id,
  name: dashboard.name,
  description: dashboard.description ?? undefined,
  pinned: dashboard.pinned,
  autoRefreshSeconds: dashboard.autoRefreshSeconds,
});

async function dashboardDetail(
  viewerId: string | null,
  id: string,
  data?: DashboardData,
) {
  const [dashboards, current] = await Promise.all([
    listDashboards(viewerId),
    data ?? getDashboardData(id),
  ]);
  const dashboard = dashboards.find((item) => item.id === id);
  if (!dashboard) throw publicApiError('NOT_FOUND', 'Dashboard not found.');
  return {
    dashboard: dashboardMessage(dashboard),
    widgets: current.widgets.map((widget) => ({
      id: widget.id,
      appId: widget.appId,
      appSlug: widget.appSlug,
      appName: widget.appName,
      widgetId: widget.widgetId,
      name: widget.name,
      defaultSize: widget.defaultSize,
      supportedSizes: widget.supportedSizes,
    })),
    layouts: current.layouts,
    revision: current.revision,
  };
}

const widgetPosition = (position: {
  breakpoint: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}) => ({
  ...position,
  // Protovalidate has already limited this to the three breakpoints.
  breakpoint: position.breakpoint as DashboardBreakpoint,
});

const columns = {
  id: true,
  slug: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;
const ORDINARY_FRAMING_BYTES = 16 * 1024;

async function list() {
  const rows = await db.query.apps.findMany({ columns });
  const summaries = await listAppsForAgent();
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const icons = await appIconPaths();
  return rows.flatMap((row) => {
    const summary = byId.get(row.id);
    if (!summary) return [];
    const view = {
      ...row,
      ...summary,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    return [
      {
        ...project(row),
        iconPath: icons.get(row.id),
        view: jsonValue(appSummarySchema.parse(view)),
      },
    ];
  });
}
/** Icon path per App id, for Apps that have a stored icon. */
async function appIconPaths(id?: string): Promise<Map<string, string>> {
  const rows = await db.query.apps.findMany({
    where: { id: id ?? EmptyFilter },
    columns: { id: true, icon: true },
  });
  return new Map(
    rows.flatMap((row) =>
      row.icon ? [[row.id, appIconPath(row.id, row.icon)] as const] : [],
    ),
  );
}
const appDocMessage = (doc: PublishedAppDoc) => ({
  id: doc.id,
  title: doc.title,
  description: doc.description,
  path: doc.path,
  bytes: doc.bytes,
  sha256: doc.sha256,
});
const iconMessage = (icon: AppIconView) => ({
  icon: {
    key: icon.key ?? undefined,
    path: icon.path ?? undefined,
    sizes: icon.sizes,
  },
});
const pinMessage = (pin: SidebarItem) => ({
  id: pin.id,
  appId: pin.appId,
  appSlug: pin.appSlug,
  label: pin.label,
  entryHash: pin.entryHash ?? undefined,
  appStatus: pin.status,
});
const jsonValue = (value: unknown) => fromJson(ValueSchema, value as JsonValue);
function interfacePreferencesMessage({ language }: InterfacePreferences) {
  return { preferences: { language: language ?? undefined } };
}

/**
 * The user a call acts for: the user behind a session or API key, or for a
 * Run credential the user who sent the prompt the run answers. Null for a Run
 * no user prompted; shared resources still work for it, seen by nobody.
 */
async function actingUserId(context: HandlerContext): Promise<string | null> {
  const { status, run } = context.values.get(publicApiContext);
  if (
    status?.credentialType === 'session' ||
    status?.credentialType === 'api-key'
  ) {
    return status.user.id;
  }
  const row = run
    ? await db.query.agentRuns.findFirst({
        where: { id: run.runId },
        columns: { userId: true },
      })
    : null;
  return row?.userId ?? null;
}

/**
 * Whose personal settings a call reads and writes (preferences, theme,
 * pins): the acting user, or a 409 for a Run no user prompted.
 */
async function preferenceUserId(context: HandlerContext): Promise<string> {
  const userId = await actingUserId(context);
  if (!userId) {
    throw publicApiError(
      'CONFLICT',
      'This Run has no user whose preferences it can use.',
    );
  }
  return userId;
}
async function associate(id: string, context: HandlerContext) {
  const run = context.values.get(publicApiContext).run;
  if (!run) return { appId: id, association: 'not-applicable' };
  await associateAgentSessionApp(run.sessionId, id);
  return { appId: id, association: 'associated' };
}
function dataInput(
  value: Parameters<typeof toJson<typeof ValueSchema>>[1] | undefined,
) {
  if (!value) throw publicApiError('BAD_REQUEST');
  return toJson(ValueSchema, value);
}
function backendView(view: AppBackendView) {
  const { runtime } = view;
  return {
    id: view.id,
    slug: view.slug,
    name: view.name,
    mode: view.mode,
    runtimeSupported: view.compatibility?.isSupported ?? false,
    runtime: {
      state: runtime.state,
      pid: runtime.pid ?? undefined,
      port: runtime.port ?? undefined,
      startedAt: runtime.startedAt ?? undefined,
      stoppedAt: runtime.stoppedAt ?? undefined,
      lastExitCode: runtime.lastExitCode ?? undefined,
      lastExitSignal: runtime.lastExitSignal ?? undefined,
      lastError: runtime.lastError ?? undefined,
      restartCount: runtime.restartCount,
      keepAlive: runtime.keepAlive,
      drainingInstances: runtime.drainingInstances,
    },
  };
}
/** Run one backend control, then answer with the backend's resulting view. */
async function backendOperation(
  id: string,
  operation?: (appId: string) => Promise<unknown>,
) {
  try {
    const row = await find(id);
    try {
      await operation?.(row.id);
    } catch (error) {
      if (error instanceof AppError || error instanceof ConnectError) {
        throw error;
      }
      // A boot failure carries the process log tail. Keep it out of the
      // error; the backend view exposes it as lastError.
      throw publicApiError(
        'CONFLICT',
        'The backend did not start. Read lastError with hatch app backend status.',
      );
    }
    return { backend: backendView(await getAppBackend(row.id)) };
  } catch (error) {
    throw publicError(error);
  }
}
async function dataOperation<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    throw publicError(error, true);
  }
}
function project(row: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'draft' | 'building' | 'deployed' | 'failed' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    description: row.description ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function find(id: string) {
  const lookup = (where: { id: string } | { slug: string }) =>
    db.query.apps.findFirst({ where, columns });
  const row = (await lookup({ id })) ?? (await lookup({ slug: id }));
  if (!row) throw publicApiError('NOT_FOUND');
  return row;
}

function files(value: { files: { path: string; contentBase64: string }[] }) {
  return value.files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.contentBase64, 'base64'),
  }));
}
const apps = {
  list: async () => ({ resources: await list() }),
  create: async (
    input: {
      slug: string;
      name: string;
      description?: string;
      pin?: boolean;
    },
    context: HandlerContext,
  ) => {
    const { run } = context.values.get(publicApiContext);
    const creatorId = await actingUserId(context);
    const created = await createApp(input, {
      ...(run ? { sessionId: run.sessionId } : {}),
      ...(creatorId ? { creatorId } : {}),
    });
    return { ...created, files: files(created) };
  },
  get: async (input: { id: string }) => {
    const row = await find(input.id);
    const detail = await getAppDetailForAgent(row.id);
    if (!detail) throw publicApiError('NOT_FOUND');
    const view = appDetailSchema.parse({
      ...detail,
      updatedAt: row.updatedAt.toISOString(),
    });
    return {
      resource: {
        ...project(row),
        iconPath: (await appIconPaths(row.id)).get(row.id),
        view: jsonValue(view),
      },
    };
  },
  deploy: async (
    input: {
      id: string;
      message: string;
      generation: string;
      bundle?: Uint8Array;
      commit?: string;
      allowDestructiveDataMigration?: boolean;
      dataMigrationApprovalToken?: string;
    },
    context: HandlerContext,
  ) => {
    const row = await find(input.id);
    await associate(row.id, context);
    if (input.generation !== row.createdAt.toISOString())
      throw publicApiError('RESOURCE_GENERATION_CONFLICT');
    // Deprecated bundle transport: push the uploaded HEAD to master first.
    // Current clients push over Git and name the commit to release.
    if (input.bundle?.length && input.commit)
      throw publicApiError('BAD_REQUEST');
    const pushed = input.bundle?.length
      ? await importAppBundleToMaster(row.id, Buffer.from(input.bundle))
      : undefined;
    const result = await deployApp(row.id, {
      message: input.message,
      allowDestructiveDataMigration: input.allowDestructiveDataMigration,
      dataMigrationApprovalToken: input.dataMigrationApprovalToken,
      commit: pushed ?? input.commit,
      expectedGeneration: input.generation,
    });
    const released = await find(row.id);
    const normalized = appManifestViewSchema.parse(
      projectAppManifestUrls(result.normalized, row.id, released.slug),
    );
    return {
      deployment: {
        deploymentId: result.deploymentId,
        version: result.version,
        compatibilityVersion: result.compatibilityVersion,
        slug: released.slug,
        normalized: jsonValue(normalized),
      },
    };
  },
  rollback: async (
    input: { id: string; version: number },
    context: HandlerContext,
  ) => {
    const row = await find(input.id);
    await associate(row.id, context);
    return { restored: await rollbackAppToVersion(row.id, input.version) };
  },
};

export function registerPlatformApi(
  router: ConnectRouter,
  deployBodyLimit: number,
) {
  // Override only the interactive methods' gate. Their origin/credential boundary
  // must remain stricter than the platform-authority lifecycle RPCs.
  const sessionOnly = {
    grpc: false,
    grpcWeb: false,
    requestGate: async (context: HandlerContext) => {
      try {
        const request = new Request(context.url, {
          headers: context.requestHeader,
        });
        if (sessionOriginError(request)) throw publicApiError('FORBIDDEN');
        const auth = await authenticatePublicApi(request);
        if (auth.status?.credentialType !== 'session' || !auth.session)
          throw publicApiError('SESSION_REQUIRED');
        context.values.set(publicApiContext, auth);
      } catch (error) {
        throw publicError(error);
      }
    },
  };
  router.service(
    WorkspaceService,
    {
      getWorkspace: async (_input, context) => {
        const { status } = context.values.get(publicApiContext);
        if (status?.credentialType !== 'session')
          throw publicApiError('SESSION_REQUIRED');
        return readWorkspace(status.user.id);
      },
      setDashboardAutoRefresh: (input) =>
        updateDashboardAutoRefresh(input.id, input.seconds),
    },
    sessionOnly,
  );
  router.service(
    AgentService,
    {
      getModelCatalog: async () => {
        const catalog = await getAgentModelCatalog();
        return {
          providers: catalog.providers.map((provider) => ({
            ...provider,
            catalogProviderId: provider.catalogProviderId ?? undefined,
          })),
          defaultModel: catalog.defaultModel ?? undefined,
        };
      },
      listSessions: async (input) => ({
        sessions: (await listSessionSummaries(input)).map((session) => ({
          ...session,
          providerId: session.providerId ?? undefined,
          modelId: session.modelId ?? undefined,
        })),
      }),
      createSession: (input) => insertAgentSession(input),
      getSession: async (input) => {
        const session = await loadSessionDetail(input.id);
        if (!session) throw publicApiError('NOT_FOUND');
        const active = session.activeRun;
        return {
          session: {
            ...session,
            providerId: session.providerId ?? undefined,
            modelId: session.modelId ?? undefined,
            runnerId: session.runnerId ?? undefined,
            messages: session.messages.map((message) =>
              fromJson(ValueSchema, message),
            ),
            activeRun: active
              ? {
                  ...active,
                  userTurn: active.userTurn ?? undefined,
                  pendingAsk: active.pendingAsk ?? undefined,
                  answeredAskId: active.answeredAskId ?? undefined,
                  pendingEnvRequest: active.pendingEnvRequest ?? undefined,
                }
              : undefined,
            runs: session.runs.map((run) => ({
              ...run,
              completedAt: run.completedAt ?? undefined,
              error: run.error ?? undefined,
            })),
            retry: session.retry
              ? {
                  ...session.retry,
                  nextRetryAt: session.retry.nextRetryAt ?? undefined,
                }
              : undefined,
            pending: {
              paused: session.pending.paused,
              messages: session.pending.messages.map((message) => ({
                ...message,
                content: message.content.map((part) =>
                  fromJson(ValueSchema, part),
                ),
              })),
            },
          },
        };
      },
    },
    sessionOnly,
  );
  router.rpc(
    AuthService.method.createHandoff,
    (_input, context) => {
      return createHandoff(
        new Request(context.url, { headers: context.requestHeader }),
        context.values.get(publicApiContext).session!,
      );
    },
    { ...sessionOnly, jsonOptions: { ignoreUnknownFields: false } },
  );
  router.rpc(
    AppService.method.associateAppSession,
    async (input, context) => associate((await find(input.id)).id, context),
    { jsonOptions: { ignoreUnknownFields: false } },
  );
  router.rpc(
    AppService.method.queryAppKv,
    async (input) =>
      dataOperation(async () => {
        const parsed = queryAppKvRequestSchema.safeParse(
          dataInput(input.input),
        );
        if (!parsed.success) throw publicApiError('BAD_REQUEST');
        return {
          result: jsonValue(
            await queryAppKv((await find(input.id)).id, parsed.data),
          ),
        };
      }),
    { readMaxBytes: deployBodyLimit },
  );
  router.rpc(
    AppService.method.queryAppDataTable,
    async (input, context) =>
      dataOperation(async () => {
        context.signal.throwIfAborted();
        const parsed = queryAppDataTableRequestSchema.safeParse(
          dataInput(input.input),
        );
        if (!parsed.success) throw publicApiError('BAD_REQUEST');
        const row = await find(input.id);
        context.signal.throwIfAborted();
        return {
          result: jsonValue(
            await queryAppDataTable(row.id, parsed.data, context.signal),
          ),
        };
      }),
    { readMaxBytes: deployBodyLimit },
  );
  router.rpc(
    AppService.method.queryAppDb,
    async (input, context) =>
      dataOperation(async () => {
        context.signal.throwIfAborted();
        const row = await find(input.id);
        context.signal.throwIfAborted();
        return queryAppDatabase(row.id, input.sql, context.signal);
      }),
    { readMaxBytes: deployBodyLimit },
  );
  router.rpc(AppService.method.listAppBackends, async (input) => {
    try {
      const page = await listAppBackendsPage({
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        backends: page.backends.map(backendView),
        nextCursor: page.nextCursor ?? undefined,
      };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(AppService.method.getAppBackend, (input) =>
    backendOperation(input.id),
  );
  router.rpc(AppService.method.startAppBackend, (input) =>
    backendOperation(input.id, startBackendForApp),
  );
  router.rpc(AppService.method.stopAppBackend, (input) =>
    backendOperation(input.id, (appId) =>
      stopBackendForApp(appId, { force: input.force }),
    ),
  );
  router.rpc(AppService.method.restartAppBackend, (input) =>
    backendOperation(input.id, (appId) =>
      restartBackendForApp(appId, { force: input.force }),
    ),
  );
  router.rpc(AppService.method.getAppIcon, async (input) =>
    iconMessage(await getAppIcon((await find(input.id)).id)),
  );
  router.rpc(
    AppService.method.setAppIcon,
    async (input) => {
      const { id } = await find(input.id);
      if (input.source.case === 'image')
        return iconMessage(
          await setAppIcon(id, Buffer.from(input.source.value)),
        );
      if (input.source.case === 'candidateId')
        return iconMessage(
          await setAppIconFromCandidate(id, input.source.value),
        );
      throw publicApiError('BAD_REQUEST');
    },
    // Room for the largest accepted image plus message framing. Connect's
    // JSON encoding carries `bytes` as base64, four characters per three
    // bytes; the decoded image is still capped by the domain service.
    {
      readMaxBytes:
        Math.ceil(MAX_APP_ICON_BYTES / 3) * 4 + ORDINARY_FRAMING_BYTES,
    },
  );
  router.rpc(AppService.method.clearAppIcon, async (input) =>
    iconMessage(await clearAppIcon((await find(input.id)).id)),
  );
  router.rpc(AppService.method.listAppTasks, async (input) => {
    try {
      const { id } = await find(input.id);
      return tasksMessage(id, await listAppTasks(id));
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(
    AppService.method.runAppTask,
    async (input, context) => {
      try {
        const { id } = await find(input.id);
        // The same input cap as the Web UI and the task webhook, measured as
        // JSON text.
        if (
          Buffer.byteLength(JSON.stringify(input.input ?? {})) >
          MAX_TASK_INPUT_BYTES
        ) {
          throw new AppError('Task input exceeds 1 MB.', 413);
        }
        const { status, run } = context.values.get(publicApiContext);
        const user = (status as { user?: { id?: string } } | undefined)?.user;
        const result = await startTaskRun(id, input.task, {
          trigger: 'manual',
          input: input.input ?? {},
          // Every credential has the same authority; a Run acts as the Agent.
          actor: run ? 'agent' : (user?.id ?? null),
        });
        return { runId: result.runId, status: result.status };
      } catch (error) {
        throw publicError(error);
      }
    },
    // A 1 MB JSON input encodes as a Struct of up to a few times its size
    // (each number is a tagged 8-byte double), plus message framing.
    { readMaxBytes: MAX_TASK_INPUT_BYTES * 4 + ORDINARY_FRAMING_BYTES },
  );
  router.rpc(AppService.method.listAppTaskRuns, async (input) => {
    try {
      const { id } = await find(input.id);
      const page = await listTaskRuns(id, {
        taskName: input.task,
        status: input.status as
          | 'queued'
          | 'running'
          | 'succeeded'
          | 'failed'
          | 'canceled'
          | undefined,
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        runs: page.runs.map(runSummaryMessage),
        nextCursor: page.nextCursor ?? undefined,
      };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(AppService.method.getAppTaskRun, async (input) => {
    try {
      const { id } = await find(input.id);
      const run = await getTaskRun(id, input.runId);
      if (!run) throw publicApiError('NOT_FOUND', 'Task run not found.');
      return { run: runMessage(run) };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(AppService.method.cancelAppTaskRun, async (input) => {
    try {
      const { id } = await find(input.id);
      return await cancelTaskRun(id, input.runId);
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(AppService.method.rotateAppWebhookSecret, async (input) => {
    try {
      const { id } = await find(input.id);
      return { secret: await rotateAppWebhookSecret(id), appId: id };
    } catch (error) {
      throw publicError(error);
    }
  });
  router.rpc(AppService.method.listAppDocs, async (input) => {
    const index = await listAppDocs((await find(input.id)).id);
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const end =
      input.limit === undefined ? index.docs.length : start + input.limit;
    return {
      appId: index.appId,
      version: index.version,
      deploymentId: index.deploymentId,
      docs: index.docs.slice(start, end).map(appDocMessage),
      endpoints: index.endpoints,
      nextCursor: end < index.docs.length ? String(end) : undefined,
    };
  });
  router.rpc(AppService.method.getAppDoc, async (input) => {
    const doc = await readAppDoc((await find(input.id)).id, input.docId);
    return { ...doc, doc: appDocMessage(doc.doc) };
  });
  router.service(PreferenceService, {
    getAgentPreferences: async (_input, context) => ({
      preferences: await readAgentPreferences(await preferenceUserId(context)),
    }),
    updateAgentPreferences: async (input, context) => ({
      preferences: await updateAgentPreferences(
        await preferenceUserId(context),
        input.messageMode === undefined
          ? {}
          : { messageMode: input.messageMode as 'queue' | 'steer' },
      ),
    }),
    getInterfacePreferences: async (_input, context) =>
      interfacePreferencesMessage(
        await readInterfacePreferences(await preferenceUserId(context)),
      ),
    updateInterfacePreferences: async (input, context) =>
      interfacePreferencesMessage(
        await updateInterfacePreferences(
          await preferenceUserId(context),
          // Protovalidate limits the value to a shipped language.
          { language: input.language as Locale | undefined },
        ),
      ),
    getDeskPreferences: async (_input, context) => ({
      preferences: await readDeskPreferences(await preferenceUserId(context)),
    }),
    updateDeskPreferences: async (input, context) => ({
      preferences: await updateDeskPreferences(
        await preferenceUserId(context),
        input.backgroundAppMinutes === undefined
          ? {}
          : { backgroundAppMinutes: input.backgroundAppMinutes },
      ),
    }),
  });
  router.service(ImageService, {
    listImageModels: async (input) => {
      const list = await listImageModels();
      const page = listPage(list.models, input);
      return {
        models: page.items,
        defaultModelId: list.defaultModelId ?? undefined,
        providers: list.providers,
        nextCursor: page.nextCursor,
      };
    },
    createImageModel: async (input) => ({
      model: await createImageModel({
        providerId: input.providerId,
        modelId: input.modelId,
        name: input.name,
        description: input.description,
      }),
    }),
    updateImageModel: async (input) => ({
      model: await updateImageModel({
        id: input.id,
        modelId: input.modelId,
        name: input.name,
        description: input.description,
      }),
    }),
    deleteImageModel: async (input) => {
      await deleteImageModel(input.id);
      return {};
    },
    generateImages: async (input, context) => {
      const result = await generateImages(
        {
          prompt: input.prompt,
          count: input.count,
          quality: input.quality as 'low' | 'medium' | 'high' | undefined,
          glyphTile: input.glyphTile,
          subjectTile: input.subjectTile,
          imageModelId: input.imageModelId,
        },
        context.signal,
      );
      return {
        imageModelId: result.imageModelId,
        modelId: result.model,
        candidates: result.images,
      };
    },
  });
  registerModelServices(router);
  router.service(ThemeService, {
    getTheme: async (_input, context) => ({
      theme: await readTheme(await preferenceUserId(context)),
    }),
    setTheme: async (input, context) => ({
      theme: await updateTheme(await preferenceUserId(context), {
        accent: input.accent,
        dockLabels: input.dockLabels,
      }),
    }),
  });
  router.service(ServerService, {
    getServerInfo: () => ({
      server: {
        commit: buildInfo.commit ?? undefined,
        commitTime: buildInfo.commitTime ?? undefined,
      },
    }),
  });
  router.service(PinService, {
    listPins: async (input, context) => {
      const pins = await listPins(await preferenceUserId(context));
      // One sequence across both lists, in the documented order.
      const entries = [
        ...pins.appPins.map((pin) => ({ kind: 'app' as const, pin })),
        ...pins.dashboards.map((pin) => ({ kind: 'dashboard' as const, pin })),
      ];
      const page = listPage(entries, input);
      return {
        appPins: page.items.flatMap((entry) =>
          entry.kind === 'app' ? [pinMessage(entry.pin)] : [],
        ),
        dashboards: page.items.flatMap((entry) =>
          entry.kind === 'dashboard' ? [entry.pin] : [],
        ),
        nextCursor: page.nextCursor,
      };
    },
    pinApp: async (input, context) => {
      const result = await pinApp(await preferenceUserId(context), input);
      return { pin: pinMessage(result.pin), created: result.created };
    },
    updateAppPin: async (input, context) => ({
      pin: pinMessage(
        await updateAppPin(await preferenceUserId(context), input.id, {
          label: input.label,
          // Present but empty clears the entry point.
          entryHash:
            input.entryHash === undefined ? undefined : input.entryHash || null,
        }),
      ),
    }),
    unpinApp: async (input, context) => {
      const { target } = input;
      if (target.case !== 'pinId' && target.case !== 'app')
        throw publicApiError('BAD_REQUEST');
      const userId = await preferenceUserId(context);
      return {
        removedPinIds: await unpinApp(
          userId,
          target.case === 'pinId'
            ? { pinId: target.value }
            : { app: target.value },
        ),
      };
    },
    reorderAppPins: async (input, context) => ({
      appPins: (
        await reorderAppPins(await preferenceUserId(context), input.pinIds)
      ).map(pinMessage),
    }),
    reorderDashboards: async (input, context) => ({
      dashboardIds: await reorderDashboards(
        await preferenceUserId(context),
        input.dashboardIds,
      ),
    }),
    setDashboardPinned: async (input, context) =>
      setDashboardPinned(
        await preferenceUserId(context),
        input.dashboardId,
        input.pinned,
      ),
  });
  router.service(DashboardService, {
    listDashboards: async (input, context) => {
      const page = listPage(
        await listDashboards(await actingUserId(context)),
        input,
      );
      return {
        dashboards: page.items.map(dashboardMessage),
        nextCursor: page.nextCursor,
      };
    },
    getDashboard: async (input, context) => ({
      detail: await dashboardDetail(await actingUserId(context), input.id),
    }),
    createDashboard: async (input, context) => ({
      dashboard: dashboardMessage(
        await createDashboard(await actingUserId(context), input),
      ),
    }),
    updateDashboard: async (input, context) => ({
      dashboard: dashboardMessage(
        await updateDashboard(await actingUserId(context), input.id, {
          name: input.name,
          description: input.description,
          autoRefreshSeconds: input.autoRefreshSeconds,
        }),
      ),
    }),
    deleteDashboard: async (input) => {
      await deleteDashboard(input.id);
      return { id: input.id };
    },
    listAvailableWidgets: async (input) => {
      const page = listPage(await listAvailableWidgets(), input);
      return {
        widgets: page.items.map((widget) => ({
          appId: widget.appId,
          appSlug: widget.appSlug,
          appName: widget.appName,
          widgetId: widget.widgetId,
          name: widget.name,
          defaultSize: widget.defaultSize,
          supportedSizes: widget.supportedSizes,
        })),
        nextCursor: page.nextCursor,
      };
    },
    addDashboardWidget: async (input, context) => {
      const result = await addDashboardWidget(input.dashboardId, {
        app: input.app,
        widgetId: input.widgetId,
        position: input.position && widgetPosition(input.position),
      });
      return {
        detail: await dashboardDetail(
          await actingUserId(context),
          input.dashboardId,
          result.data,
        ),
        placementId: result.placementId,
      };
    },
    setDashboardWidgetLayout: async (input, context) => {
      if (!input.position) throw publicApiError('BAD_REQUEST');
      return {
        detail: await dashboardDetail(
          await actingUserId(context),
          input.dashboardId,
          await setDashboardWidgetLayout(
            input.dashboardId,
            input.placementId,
            widgetPosition(input.position),
          ),
        ),
      };
    },
    removeDashboardWidget: async (input, context) => ({
      detail: await dashboardDetail(
        await actingUserId(context),
        input.dashboardId,
        await removeDashboardWidget(input.dashboardId, input.placementId),
      ),
    }),
  });
  router.rpc(AppService.method.listApps, apps.list);
  router.rpc(AppService.method.createApp, apps.create);
  router.rpc(AppService.method.getApp, apps.get);
  router.rpc(AppService.method.rollbackApp, apps.rollback);
  router.rpc(AppService.method.deployApp, apps.deploy, {
    readMaxBytes: deployBodyLimit,
  });
  router.rpc(AuthService.method.getStatus, (_input, context) => {
    const status = context.values.get(publicApiContext).status;
    if (!status) throw publicApiError('UNAUTHORIZED');
    const expiresAt = status.expiresAt ?? undefined;
    if (status.credentialType === 'session')
      return {
        expiresAt,
        credential: { case: 'session', value: { user: status.user } },
      };
    if (status.credentialType === 'api-key')
      return {
        expiresAt,
        credential: {
          case: 'apiKey',
          value: {
            user: status.user,
            id: status.key.id,
            name: status.key.name ?? undefined,
          },
        },
      };
    return { expiresAt, credential: { case: 'run', value: status.context } };
  });
  registerNotificationApi(router);
  router.service(SdkService, {
    getSdk: async () => {
      // The interceptor validates the closed set before any domain access.
      const result = await sdkPayload();
      return { files: files(result), tooling: result.tooling };
    },
  });
}
