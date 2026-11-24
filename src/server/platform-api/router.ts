import { listPage } from '~server/list-page';
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
import { WorkflowService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/workflow_pb';
import { AuthService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import { SdkService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { publicApiError, publicError } from './errors';
import { AppError } from '~server/errors';
import { db } from '~/db';
import { deployApp } from '~server/apps/deploy';
import {
  appMasterCommit,
  exportAppMasterBundle,
  importAppBundleToMaster,
} from '~server/apps/git';
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
import { deployWorkflow } from '~server/workflows/deploy';
import {
  exportWorkflowMasterBundle,
  importWorkflowBundleToMaster,
  workflowMasterCommit,
} from '~server/workflows/git';
import { rollbackWorkflowToVersion } from '~server/workflows/manage';
import { createWorkflow } from '~server/workflows/scaffold';
import { authenticatePublicApi } from './auth';
import { listAppsForAgent, getAppDetailForAgent } from '~server/apps/inspect';
import {
  listWorkflowsForAgent,
  getWorkflowDetailForAgent,
} from '~server/workflows/inspect';
import { projectAppManifestUrls } from '~server/apps/manifest';
import { projectWorkflowManifestUrls } from '~server/workflows/manifest';
import {
  appSummarySchema,
  workflowSummarySchema,
  appDetailSchema,
  workflowDetailSchema,
  appManifestViewSchema,
  workflowManifestViewSchema,
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
import { PreferenceService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/preference_pb';
import {
  readAgentPreferences,
  updateAgentPreferences,
} from '~server/agent-preferences';
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
import { getThemeState, updateTheme } from '~server/theme-settings';
import { PinService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/pin_pb';
import {
  listPins,
  pinApp,
  reorderAppPins,
  reorderDashboards,
  setDashboardPinned,
  setWorkflowPinned,
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

async function dashboardDetail(id: string, data?: DashboardData) {
  const [dashboards, current] = await Promise.all([
    listDashboards(),
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
type Kind = 'apps' | 'workflows';
const ORDINARY_FRAMING_BYTES = 16 * 1024;

async function list(kind: Kind) {
  const rows =
    kind === 'apps'
      ? await db.query.apps.findMany({ columns })
      : await db.query.workflows.findMany({ columns });
  const summaries =
    kind === 'apps' ? await listAppsForAgent() : await listWorkflowsForAgent();
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const icons = kind === 'apps' ? await appIconPaths() : new Map();
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
        view: jsonValue(
          (kind === 'apps' ? appSummarySchema : workflowSummarySchema).parse(
            view,
          ),
        ),
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
/**
 * Whose personal preferences a call reads and writes: the user behind a
 * session or API key, or for a Run credential the user who sent the prompt
 * the run answers.
 */
async function preferenceUserId(context: HandlerContext): Promise<string> {
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
  if (!row?.userId) {
    throw publicApiError(
      'CONFLICT',
      'This Run has no user whose preferences it can use.',
    );
  }
  return row.userId;
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
    const row = await find('apps', id);
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
async function find(kind: Kind, id: string) {
  const lookup = (where: { id: string } | { slug: string }) =>
    kind === 'apps'
      ? db.query.apps.findFirst({ where, columns })
      : db.query.workflows.findFirst({ where, columns });
  const row = (await lookup({ id })) ?? (await lookup({ slug: id }));
  if (!row) throw publicApiError('NOT_FOUND');
  return row;
}
async function source(kind: Kind, id: string) {
  const row = await find(kind, id);
  if (kind === 'apps') {
    const bundle = await exportAppMasterBundle(row.id);
    return {
      id: row.id,
      masterCommit: (await appMasterCommit(row.id)) ?? undefined,
      bundle: bundle ?? undefined,
    };
  }
  const bundle = await exportWorkflowMasterBundle(row.id);
  return {
    id: row.id,
    masterCommit: (await workflowMasterCommit(row.id)) ?? undefined,
    bundle: bundle ?? undefined,
  };
}

function files(value: { files: { path: string; contentBase64: string }[] }) {
  return value.files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.contentBase64, 'base64'),
  }));
}
function lifecycle(kind: Kind) {
  return {
    list: async () => ({ resources: await list(kind) }),
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
      const created =
        kind === 'apps'
          ? await createApp(input, run ? { sessionId: run.sessionId } : {})
          : await createWorkflow(input);
      return { ...created, files: files(created) };
    },
    get: async (input: { id: string }) => {
      const row = await find(kind, input.id);
      const detail =
        kind === 'apps'
          ? await getAppDetailForAgent(row.id)
          : await getWorkflowDetailForAgent(row.id);
      if (!detail) throw publicApiError('NOT_FOUND');
      // Apps already report the released commit; add it for Workflows so
      // clients can tell which pushed commit is live.
      const released =
        kind === 'apps'
          ? {}
          : {
              currentSourceCommit:
                (
                  await db.query.workflows.findFirst({
                    where: { id: row.id },
                    columns: { currentSourceCommit: true },
                  })
                )?.currentSourceCommit ?? null,
            };
      const view = (
        kind === 'apps' ? appDetailSchema : workflowDetailSchema
      ).parse({
        ...detail,
        ...released,
        updatedAt: row.updatedAt.toISOString(),
      });
      return {
        resource: {
          ...project(row),
          iconPath:
            kind === 'apps'
              ? (await appIconPaths(row.id)).get(row.id)
              : undefined,
          view: jsonValue(view),
        },
      };
    },
    source: async (input: { id: string }) => ({
      source: await source(kind, input.id),
    }),
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
      const row = await find(kind, input.id);
      if (kind === 'apps') await associate(row.id, context);
      if (input.generation !== row.createdAt.toISOString())
        throw publicApiError('RESOURCE_GENERATION_CONFLICT');
      // Deprecated bundle transport: push the uploaded HEAD to master first.
      // Current clients push over Git and name the commit to release.
      if (input.bundle?.length && input.commit)
        throw publicApiError('BAD_REQUEST');
      const pushed = input.bundle?.length
        ? kind === 'apps'
          ? await importAppBundleToMaster(row.id, Buffer.from(input.bundle))
          : await importWorkflowBundleToMaster(
              row.id,
              Buffer.from(input.bundle),
            )
        : undefined;
      const options = {
        message: input.message,
        allowDestructiveDataMigration: input.allowDestructiveDataMigration,
        dataMigrationApprovalToken: input.dataMigrationApprovalToken,
        commit: pushed ?? input.commit,
        expectedGeneration: input.generation,
      };
      const result =
        kind === 'apps'
          ? await deployApp(row.id, options)
          : await deployWorkflow(row.id, options);
      const released = await find(kind, row.id);
      const normalized =
        kind === 'apps'
          ? appManifestViewSchema.parse(
              projectAppManifestUrls(
                result.normalized as Parameters<
                  typeof projectAppManifestUrls
                >[0],
                row.id,
                released.slug,
              ),
            )
          : workflowManifestViewSchema.parse(
              projectWorkflowManifestUrls(
                result.normalized as Parameters<
                  typeof projectWorkflowManifestUrls
                >[0],
                row.id,
              ),
            );
      return {
        deployment: {
          deploymentId: result.deploymentId,
          version: result.version,
          compatibilityVersion: result.compatibilityVersion,
          slug: kind === 'apps' ? released.slug : undefined,
          normalized: jsonValue(normalized),
        },
      };
    },
    rollback: async (
      input: { id: string; version: number },
      context: HandlerContext,
    ) => {
      const row = await find(kind, input.id);
      if (kind === 'apps') await associate(row.id, context);
      const restored =
        kind === 'apps'
          ? await rollbackAppToVersion(row.id, input.version)
          : await rollbackWorkflowToVersion(row.id, input.version);
      return { restored };
    },
  };
}

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
      getWorkspace: () => readWorkspace(),
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
        return { ...catalog, defaultModel: catalog.defaultModel ?? undefined };
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
  const apps = lifecycle('apps');
  const workflows = lifecycle('workflows');
  router.rpc(
    AppService.method.associateAppSession,
    async (input, context) =>
      associate((await find('apps', input.id)).id, context),
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
            await queryAppKv((await find('apps', input.id)).id, parsed.data),
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
        const row = await find('apps', input.id);
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
        const row = await find('apps', input.id);
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
    iconMessage(await getAppIcon((await find('apps', input.id)).id)),
  );
  router.rpc(
    AppService.method.setAppIcon,
    async (input) => {
      const { id } = await find('apps', input.id);
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
    iconMessage(await clearAppIcon((await find('apps', input.id)).id)),
  );
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
  });
  router.service(ImageService, {
    listImageModels: async () => {
      const list = await listImageModels();
      return { ...list, defaultModelId: list.defaultModelId ?? undefined };
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
  router.service(ThemeService, {
    getTheme: async () => ({ theme: await getThemeState() }),
    setTheme: async (input) => ({
      theme: await updateTheme({
        accent: input.accent,
        dockLabels: input.dockLabels,
      }),
    }),
  });
  router.service(PinService, {
    listPins: async (input) => {
      const pins = await listPins();
      // One sequence across the three lists, in the documented order.
      const entries = [
        ...pins.appPins.map((pin) => ({ kind: 'app' as const, pin })),
        ...pins.workflows.map((pin) => ({ kind: 'workflow' as const, pin })),
        ...pins.dashboards.map((pin) => ({ kind: 'dashboard' as const, pin })),
      ];
      const page = listPage(entries, input);
      return {
        appPins: page.items.flatMap((entry) =>
          entry.kind === 'app' ? [pinMessage(entry.pin)] : [],
        ),
        workflows: page.items.flatMap((entry) =>
          entry.kind === 'workflow' ? [entry.pin] : [],
        ),
        dashboards: page.items.flatMap((entry) =>
          entry.kind === 'dashboard' ? [entry.pin] : [],
        ),
        nextCursor: page.nextCursor,
      };
    },
    pinApp: async (input) => {
      const result = await pinApp(input);
      return { pin: pinMessage(result.pin), created: result.created };
    },
    updateAppPin: async (input) => ({
      pin: pinMessage(
        await updateAppPin(input.id, {
          label: input.label,
          // Present but empty clears the entry point.
          entryHash:
            input.entryHash === undefined ? undefined : input.entryHash || null,
        }),
      ),
    }),
    unpinApp: async (input) => {
      if (input.target.case === 'pinId')
        return { removedPinIds: await unpinApp({ pinId: input.target.value }) };
      if (input.target.case === 'app')
        return { removedPinIds: await unpinApp({ app: input.target.value }) };
      throw publicApiError('BAD_REQUEST');
    },
    reorderAppPins: async (input) => ({
      appPins: (await reorderAppPins(input.pinIds)).map(pinMessage),
    }),
    reorderDashboards: async (input) => ({
      dashboardIds: await reorderDashboards(input.dashboardIds),
    }),
    setWorkflowPinned: (input) =>
      setWorkflowPinned(input.workflow, input.pinned),
    setDashboardPinned: (input) =>
      setDashboardPinned(input.dashboardId, input.pinned),
  });
  router.service(DashboardService, {
    listDashboards: async (input) => {
      const page = listPage(await listDashboards(), input);
      return {
        dashboards: page.items.map(dashboardMessage),
        nextCursor: page.nextCursor,
      };
    },
    getDashboard: async (input) => ({
      detail: await dashboardDetail(input.id),
    }),
    createDashboard: async (input) => ({
      dashboard: dashboardMessage(await createDashboard(input)),
    }),
    updateDashboard: async (input) => ({
      dashboard: dashboardMessage(
        await updateDashboard(input.id, {
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
    addDashboardWidget: async (input) => {
      const result = await addDashboardWidget(input.dashboardId, {
        app: input.app,
        widgetId: input.widgetId,
        position: input.position && widgetPosition(input.position),
      });
      return {
        detail: await dashboardDetail(input.dashboardId, result.data),
        placementId: result.placementId,
      };
    },
    setDashboardWidgetLayout: async (input) => {
      if (!input.position) throw publicApiError('BAD_REQUEST');
      return {
        detail: await dashboardDetail(
          input.dashboardId,
          await setDashboardWidgetLayout(
            input.dashboardId,
            input.placementId,
            widgetPosition(input.position),
          ),
        ),
      };
    },
    removeDashboardWidget: async (input) => ({
      detail: await dashboardDetail(
        input.dashboardId,
        await removeDashboardWidget(input.dashboardId, input.placementId),
      ),
    }),
  });
  router.rpc(AppService.method.listApps, apps.list);
  router.rpc(AppService.method.createApp, apps.create);
  router.rpc(AppService.method.getApp, apps.get);
  router.rpc(AppService.method.getAppSource, apps.source);
  router.rpc(AppService.method.rollbackApp, apps.rollback);
  router.rpc(AppService.method.deployApp, apps.deploy, {
    readMaxBytes: deployBodyLimit,
  });
  router.rpc(WorkflowService.method.listWorkflows, workflows.list);
  router.rpc(WorkflowService.method.createWorkflow, workflows.create);
  router.rpc(WorkflowService.method.getWorkflow, workflows.get);
  router.rpc(WorkflowService.method.getWorkflowSource, workflows.source);
  router.rpc(WorkflowService.method.rollbackWorkflow, workflows.rollback);
  router.rpc(WorkflowService.method.deployWorkflow, workflows.deploy, {
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
    getSdk: async (input) => {
      // The interceptor validates the closed set before any domain access.
      const result = await sdkPayload(input.kind as 'app' | 'workflow');
      return { files: files(result), tooling: result.tooling };
    },
  });
}
