import {
  fromJson,
  toJson,
  type DescMessage,
  type JsonObject,
  type JsonValue,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { z } from 'zod';
import {
  queryAppKvRequestSchema,
  queryAppDataTableRequestSchema,
  type QueryAppKvRequest,
  type QueryAppDataTableRequest,
} from '../../../src/platform-api/data-schemas';
/** Connect transport with CLI-specific projection and recovery semantics. */
import {
  createClient,
  Code,
  ConnectError,
  type Transport,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import {
  type AppBackend,
  CreateAppRequestSchema,
  AppService,
} from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
import {
  CreateWorkflowRequestSchema,
  WorkflowService,
} from '../../hatch-platform-api/gen/hatch/platform/v1/workflow_pb';
import { AuthService } from '../../hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import {
  ImageService,
  type ImageModelState,
} from '../../hatch-platform-api/gen/hatch/platform/v1/image_pb';
import {
  ThemeService,
  type ThemeState,
} from '../../hatch-platform-api/gen/hatch/platform/v1/theme_pb';
import {
  PinService,
  type PinnedApp,
} from '../../hatch-platform-api/gen/hatch/platform/v1/pin_pb';
import {
  DashboardService,
  type AvailableWidget,
  type Dashboard,
  type DashboardDetail,
  type WidgetLayout,
  type WidgetSize,
} from '../../hatch-platform-api/gen/hatch/platform/v1/dashboard_pb';
import { type AppIcon } from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { SdkService } from '../../hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { PublicErrorSchema } from '../../hatch-platform-api/gen/hatch/platform/v1/error_pb';
import {
  type Resource,
  type Source,
  type Deployment,
  type RestoredVersion,
} from '../../hatch-platform-api/gen/hatch/platform/v1/lifecycle_pb';
import { type File } from '../../hatch-platform-api/gen/hatch/platform/v1/file_pb';
import type { AuthStatus } from '../../hatch-platform-api/auth';
import type { Profile } from './config';
import { CliError } from './error';

export function credentialHeaders(credential: Profile): Record<string, string> {
  return credential.apiKey
    ? { 'x-api-key': credential.apiKey }
    : { authorization: `Bearer ${credential.token}` };
}
const invalidResponse = () =>
  new CliError(
    'invalid_response',
    'The platform returned an incomplete response.',
    7,
  );
function required<T>(value: T | undefined): T {
  if (value === undefined) throw invalidResponse();
  return value;
}
/**
 * Released CLIs must keep working after additive platform changes. JSON views
 * are server allowlists, so read only fields the CLI uses and pass the rest
 * through unchanged instead of re-validating them against a bundled snapshot.
 */
function jsonObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidResponse();
  return value;
}
const resourceViewSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});
const basicResource = (value: Resource) => ({
  id: value.id,
  slug: value.slug,
  name: value.name,
  description: value.description ?? null,
  status: value.status,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
});
const files = (values: File[]) =>
  values.map((value) => ({
    path: value.path,
    contentBase64: Buffer.from(value.content).toString('base64'),
  }));
const source = (value: Source) => ({
  id: value.id,
  masterCommit: value.masterCommit ?? null,
  bundleBase64:
    value.bundle === undefined
      ? null
      : Buffer.from(value.bundle).toString('base64'),
});
const deployment = (value: Deployment) => ({
  deploymentId: value.deploymentId,
  version: value.version,
  compatibilityVersion: value.compatibilityVersion,
  ...(value.slug === undefined ? {} : { slug: value.slug }),
  normalized: jsonObject(toJson(ValueSchema, required(value.normalized))),
});
const restored = (value: RestoredVersion) => ({
  version: value.version,
  compatibility: {
    version: required(value.compatibility).version,
    latestVersion: required(value.compatibility).latestVersion,
    minimumSupportedVersion: required(value.compatibility)
      .minimumSupportedVersion,
    isSupported: required(value.compatibility).isSupported,
    isLatest: required(value.compatibility).isLatest,
  },
  ...(value.dataSchemaMismatch === undefined
    ? {}
    : { dataSchemaMismatch: value.dataSchemaMismatch }),
});
const icon = (app: string, value: AppIcon | undefined) => ({
  // The id or slug the caller passed; `path` carries the immutable id.
  app,
  key: required(value).key ?? null,
  path: required(value).path ?? null,
  sizes: required(value).sizes,
});
const theme = (value: ThemeState | undefined) => {
  const state = required(value);
  return {
    accent: state.accent,
    defaultAccent: state.defaultAccent,
    accents: state.accents.map((accent) => ({
      name: accent.name,
      color: accent.color,
    })),
  };
};
const appPin = (value: PinnedApp | undefined) => {
  const pin = required(value);
  return {
    id: pin.id,
    appId: pin.appId,
    appSlug: pin.appSlug,
    label: pin.label,
    entryHash: pin.entryHash ?? null,
    appStatus: pin.appStatus,
  };
};
const dashboardView = (value: Dashboard | undefined) => {
  const dashboard = required(value);
  return {
    id: dashboard.id,
    name: dashboard.name,
    description: dashboard.description ?? null,
    pinned: dashboard.pinned,
    autoRefreshSeconds: dashboard.autoRefreshSeconds,
  };
};
const widgetSize = (size: WidgetSize | undefined) => {
  const value = required(size);
  return { w: value.w, h: value.h };
};
const widgetLayout = (item: WidgetLayout) => ({
  id: item.id,
  x: item.x,
  y: item.y,
  w: item.w,
  h: item.h,
});
const dashboardDetailView = (value: DashboardDetail | undefined) => {
  const detail = required(value);
  return {
    dashboard: dashboardView(detail.dashboard),
    revision: detail.revision,
    widgets: detail.widgets.map((widget) => ({
      id: widget.id,
      appId: widget.appId,
      appSlug: widget.appSlug,
      appName: widget.appName,
      widgetId: widget.widgetId,
      name: widget.name,
      defaultSize: widgetSize(widget.defaultSize),
      supportedSizes: widget.supportedSizes.map(widgetSize),
    })),
    layouts: {
      desktop: (detail.layouts?.desktop ?? []).map(widgetLayout),
      tablet: (detail.layouts?.tablet ?? []).map(widgetLayout),
      mobile: (detail.layouts?.mobile ?? []).map(widgetLayout),
    },
  };
};
const availableWidgetView = (widget: AvailableWidget) => ({
  appId: widget.appId,
  appSlug: widget.appSlug,
  appName: widget.appName,
  widgetId: widget.widgetId,
  name: widget.name,
  defaultSize: widgetSize(widget.defaultSize),
  supportedSizes: widget.supportedSizes.map(widgetSize),
});
type WidgetPositionInput = {
  breakpoint: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};
const imageModel = (value: ImageModelState | undefined) => {
  const state = required(value);
  return {
    selected: state.selected
      ? {
          providerId: state.selected.providerId,
          providerName: state.selected.providerName,
          modelId: state.selected.modelId,
          usable: state.selected.usable,
        }
      : null,
    providers: state.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      suggestedModels: provider.suggestedModels,
    })),
  };
};
type CreateInput = {
  slug: string;
  name: string;
  description?: string;
  pin?: boolean;
};
type DeployInput = {
  params: { id: string };
  body: {
    message: string;
    generation: string;
    commit: string;
    allowDestructiveDataMigration?: boolean;
    dataMigrationApprovalToken?: string;
  };
};
function parseData<T>(
  schema: { parse: (value: unknown) => T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch {
    throw new CliError(
      'invalid_input',
      'Input does not match the data operation contract.',
      2,
    );
  }
}

/** Keep the CLI's persisted/output DTOs separate from generated wire messages. */
function parseCreate<D extends DescMessage>(schema: D, input: CreateInput) {
  try {
    return fromJson(schema, input as JsonObject, { ignoreUnknownFields: true });
  } catch {
    throw new CliError(
      'invalid_input',
      'Create input does not match the Protobuf message types.',
      2,
    );
  }
}

/** Public backend DTO: absent runtime facts are explicit nulls. */
function backendView(value: AppBackend | undefined) {
  const backend = required(value);
  const runtime = required(backend.runtime);
  return {
    id: backend.id,
    slug: backend.slug,
    name: backend.name,
    mode: backend.mode,
    runtimeSupported: backend.runtimeSupported,
    runtime: {
      state: runtime.state,
      pid: runtime.pid ?? null,
      port: runtime.port ?? null,
      startedAt: runtime.startedAt ?? null,
      stoppedAt: runtime.stoppedAt ?? null,
      lastExitCode: runtime.lastExitCode ?? null,
      lastExitSignal: runtime.lastExitSignal ?? null,
      lastError: runtime.lastError ?? null,
      restartCount: runtime.restartCount,
      keepAlive: runtime.keepAlive,
      drainingInstances: runtime.drainingInstances,
    },
  };
}
export type AppBackendView = ReturnType<typeof backendView>;

export function cliClient(transport: Transport) {
  const apps = createClient(AppService, transport);
  const workflows = createClient(WorkflowService, transport);
  function lifecycle(client: {
    list: (
      request: Record<string, never>,
    ) => Promise<{ resources: Resource[] }>;
    create: (
      request: CreateInput,
    ) => Promise<{ id: string; slug: string; name: string; files: File[] }>;
    get: (request: { id: string }) => Promise<{ resource?: Resource }>;
    source: (request: { id: string }) => Promise<{ source?: Source }>;
    deploy: (request: {
      id: string;
      message: string;
      generation: string;
      commit?: string;
      allowDestructiveDataMigration?: boolean;
      dataMigrationApprovalToken?: string;
    }) => Promise<{ deployment?: Deployment }>;
    rollback: (request: {
      id: string;
      version: number;
    }) => Promise<{ restored?: RestoredVersion }>;
  }) {
    const resource = (value: Resource) => {
      const result = resourceViewSchema.safeParse({
        ...basicResource(value),
        ...jsonObject(toJson(ValueSchema, required(value.view))),
        ...(value.iconPath === undefined ? {} : { iconPath: value.iconPath }),
      });
      if (!result.success) throw invalidResponse();
      return result.data;
    };
    return {
      list: async (_input: Record<string, never>) =>
        (await client.list({})).resources.map((value) => resource(value)),
      create: async (input: CreateInput) => {
        const result = await client.create(input);
        return {
          id: result.id,
          slug: result.slug,
          name: result.name,
          files: files(result.files),
        };
      },
      get: async (input: { id: string }) =>
        resource(required((await client.get(input)).resource)),
      source: async (input: { id: string }) =>
        source(required((await client.source(input)).source)),
      deploy: async (input: DeployInput) =>
        deployment(
          required(
            (
              await client.deploy({
                id: input.params.id,
                ...input.body,
              })
            ).deployment,
          ),
        ),
      rollback: async (input: {
        params: { id: string };
        body: { version: number };
      }) =>
        restored(
          required(
            (
              await client.rollback({
                id: input.params.id,
                version: input.body.version,
              })
            ).restored,
          ),
        ),
    };
  }
  const auth = createClient(AuthService, transport);
  const sdk = createClient(SdkService, transport);
  const images = createClient(ImageService, transport);
  const themes = createClient(ThemeService, transport);
  const pins = createClient(PinService, transport);
  const dashboards = createClient(DashboardService, transport);
  return {
    dashboards: {
      list: async (page: { limit: number; cursor?: string }) => {
        const result = await dashboards.listDashboards(page);
        return {
          dashboards: result.dashboards.map(dashboardView),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
      get: async (id: string) =>
        dashboardDetailView((await dashboards.getDashboard({ id })).detail),
      create: async (input: { name: string; description?: string }) => ({
        dashboard: dashboardView(
          (
            await dashboards.createDashboard({
              name: input.name,
              description: input.description,
            })
          ).dashboard,
        ),
      }),
      update: async (input: {
        id: string;
        name?: string;
        description?: string;
        autoRefreshSeconds?: number;
      }) => ({
        dashboard: dashboardView(
          (
            await dashboards.updateDashboard({
              id: input.id,
              name: input.name,
              description: input.description,
              autoRefreshSeconds: input.autoRefreshSeconds,
            })
          ).dashboard,
        ),
      }),
      delete: async (id: string) => ({
        deletedDashboardId: (await dashboards.deleteDashboard({ id })).id,
      }),
      availableWidgets: async () => ({
        widgets: (await dashboards.listAvailableWidgets({})).widgets.map(
          availableWidgetView,
        ),
      }),
      addWidget: async (input: {
        dashboardId: string;
        app: string;
        widgetId: string;
        position?: WidgetPositionInput;
      }) => {
        const result = await dashboards.addDashboardWidget({
          dashboardId: input.dashboardId,
          app: input.app,
          widgetId: input.widgetId,
          position: input.position,
        });
        return {
          placementId: result.placementId,
          ...dashboardDetailView(result.detail),
        };
      },
      setWidgetLayout: async (input: {
        dashboardId: string;
        placementId: string;
        position: WidgetPositionInput;
      }) =>
        dashboardDetailView(
          (
            await dashboards.setDashboardWidgetLayout({
              dashboardId: input.dashboardId,
              placementId: input.placementId,
              position: input.position,
            })
          ).detail,
        ),
      removeWidget: async (input: {
        dashboardId: string;
        placementId: string;
      }) => ({
        removedPlacementId: input.placementId,
        ...dashboardDetailView(
          (
            await dashboards.removeDashboardWidget({
              dashboardId: input.dashboardId,
              placementId: input.placementId,
            })
          ).detail,
        ),
      }),
    },
    theme: {
      get: async () => theme((await themes.getTheme({})).theme),
      set: async (input: { accent: string }) =>
        theme((await themes.setTheme(input)).theme),
    },
    pins: {
      list: async (page: { limit: number; cursor?: string }) => {
        const result = await pins.listPins(page);
        return {
          appPins: result.appPins.map(appPin),
          workflows: result.workflows.map((workflow) => ({
            id: workflow.id,
            slug: workflow.slug,
            name: workflow.name,
          })),
          dashboards: result.dashboards.map((dashboard) => ({
            id: dashboard.id,
            name: dashboard.name,
          })),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
      pinApp: async (input: {
        app: string;
        label?: string;
        entryHash?: string;
        ifAbsent: boolean;
      }) => {
        const result = await pins.pinApp({
          app: input.app,
          label: input.label,
          entryHash: input.entryHash,
          ifAbsent: input.ifAbsent,
        });
        return { pin: appPin(result.pin), created: result.created };
      },
      updateAppPin: async (input: {
        id: string;
        label?: string;
        entryHash?: string;
      }) => ({
        pin: appPin(
          (
            await pins.updateAppPin({
              id: input.id,
              label: input.label,
              entryHash: input.entryHash,
            })
          ).pin,
        ),
      }),
      unpinApp: async (input: { pinId: string } | { app: string }) => ({
        removedPinIds: (
          await pins.unpinApp({
            target:
              'pinId' in input
                ? { case: 'pinId', value: input.pinId }
                : { case: 'app', value: input.app },
          })
        ).removedPinIds,
      }),
      reorderAppPins: async (input: { pinIds: string[] }) => ({
        appPins: (
          await pins.reorderAppPins({ pinIds: input.pinIds })
        ).appPins.map(appPin),
      }),
      reorderDashboards: async (input: { dashboardIds: string[] }) => ({
        dashboardIds: (
          await pins.reorderDashboards({ dashboardIds: input.dashboardIds })
        ).dashboardIds,
      }),
      setWorkflowPinned: async (input: {
        workflow: string;
        pinned: boolean;
      }) => {
        const result = await pins.setWorkflowPinned({
          workflow: input.workflow,
          pinned: input.pinned,
        });
        return { workflowId: result.id, pinned: result.pinned };
      },
      setDashboardPinned: async (input: {
        dashboardId: string;
        pinned: boolean;
      }) => {
        const result = await pins.setDashboardPinned({
          dashboardId: input.dashboardId,
          pinned: input.pinned,
        });
        return { dashboardId: result.id, pinned: result.pinned };
      },
    },
    images: {
      model: async () => imageModel((await images.getImageModel({})).state),
      setModel: async (input: { providerId: string; modelId: string }) =>
        imageModel((await images.setImageModel(input)).state),
      clearModel: async () =>
        imageModel((await images.clearImageModel({})).state),
      generate: async (input: {
        prompt: string;
        count: number;
        quality?: string;
        glyphTile?: string;
      }) => {
        const result = await images.generateImages(input);
        return {
          modelId: result.modelId,
          candidates: result.candidates.map((candidate) => ({
            id: candidate.id,
            path: candidate.path,
          })),
        };
      },
    },
    apps: {
      icon: {
        get: async (input: { id: string }) =>
          icon(input.id, (await apps.getAppIcon(input)).icon),
        set: async (
          input: { id: string } & (
            | { image: Uint8Array }
            | { candidateId: string }
          ),
        ) =>
          icon(
            input.id,
            (
              await apps.setAppIcon({
                id: input.id,
                source:
                  'image' in input
                    ? { case: 'image', value: input.image }
                    : { case: 'candidateId', value: input.candidateId },
              })
            ).icon,
          ),
        clear: async (input: { id: string }) =>
          icon(input.id, (await apps.clearAppIcon(input)).icon),
      },
      ...lifecycle({
        list: apps.listApps,
        create: (input) =>
          apps.createApp(parseCreate(CreateAppRequestSchema, input)),
        get: apps.getApp,
        source: apps.getAppSource,
        deploy: apps.deployApp,
        rollback: apps.rollbackApp,
      }),
      backend: {
        list: async (input: { limit?: number; cursor?: string }) => {
          const result = await apps.listAppBackends(input);
          return {
            backends: result.backends.map((value) => backendView(value)),
            nextCursor: result.nextCursor ?? null,
          };
        },
        get: async (input: { params: { id: string } }) =>
          backendView((await apps.getAppBackend(input.params)).backend),
        start: async (input: { params: { id: string } }) =>
          backendView((await apps.startAppBackend(input.params)).backend),
        stop: async (input: { params: { id: string }; force: boolean }) =>
          backendView(
            (
              await apps.stopAppBackend({
                id: input.params.id,
                force: input.force,
              })
            ).backend,
          ),
        restart: async (input: { params: { id: string }; force: boolean }) =>
          backendView(
            (
              await apps.restartAppBackend({
                id: input.params.id,
                force: input.force,
              })
            ).backend,
          ),
      },
      kv: async (input: {
        params: { id: string };
        body: QueryAppKvRequest;
      }) => {
        const body = parseData(queryAppKvRequestSchema, input.body);
        const result = await apps.queryAppKv({
          id: input.params.id,
          input: fromJson(ValueSchema, body),
        });
        return jsonObject(toJson(ValueSchema, required(result.result)));
      },
      dataTable: async (input: {
        params: { id: string };
        body: QueryAppDataTableRequest;
      }) => {
        const body = parseData(queryAppDataTableRequestSchema, input.body);
        const result = await apps.queryAppDataTable({
          id: input.params.id,
          input: fromJson(ValueSchema, body),
        });
        return jsonObject(toJson(ValueSchema, required(result.result)));
      },
      dbQuery: async (input: {
        params: { id: string };
        body: { sql: string };
      }) => {
        const result = await apps.queryAppDb({
          id: input.params.id,
          sql: input.body.sql,
        });
        return { text: result.text, rowCount: result.rowCount };
      },
      associate: async (input: {
        params: { id: string };
        body: Record<string, never>;
      }) => {
        const result = await apps.associateAppSession({ id: input.params.id });
        return { appId: result.appId, association: result.association };
      },
    },
    workflows: lifecycle({
      list: workflows.listWorkflows,
      create: (input) =>
        workflows.createWorkflow(
          parseCreate(CreateWorkflowRequestSchema, input),
        ),
      get: workflows.getWorkflow,
      source: workflows.getWorkflowSource,
      deploy: workflows.deployWorkflow,
      rollback: workflows.rollbackWorkflow,
    }),
    auth: {
      status: async (_input: Record<string, never>): Promise<AuthStatus> => {
        const result = await auth.getStatus({});
        const common = {
          authenticated: true as const,
          authority: 'platform' as const,
          expiresAt: result.expiresAt ?? null,
        };
        const credential = result.credential;
        if (credential.case === 'run')
          return {
            ...common,
            credentialType: 'run',
            context: {
              runId: credential.value.runId,
              sessionId: credential.value.sessionId,
              runnerId: credential.value.runnerId,
            },
          };
        if (credential.case === 'session' || credential.case === 'apiKey') {
          const value = credential.value;
          if (!value.user)
            throw new CliError(
              'invalid_response',
              'Missing authorization metadata.',
              7,
            );
          const user = {
            id: value.user.id,
            email: value.user.email,
            name: value.user.name,
          };
          if (credential.case === 'session')
            return { ...common, credentialType: 'session', user };
          return {
            ...common,
            credentialType: 'api-key',
            user,
            key: {
              id: credential.value.id,
              name: credential.value.name ?? null,
            },
          };
        }
        throw new CliError(
          'invalid_response',
          'Missing authorization metadata.',
          7,
        );
      },
    },
    sdk: {
      get: async (input: { kind: 'app' | 'workflow' }) => {
        const result = await sdk.getSdk(input);
        return {
          files: files(result.files),
          ...(result.tooling
            ? {
                tooling: {
                  bufVersion: result.tooling.bufVersion,
                  protocGenEsVersion: result.tooling.protocGenEsVersion,
                  // Empty on a platform without the pnpm build toolchain.
                  typescriptVersion:
                    result.tooling.typescriptVersion || undefined,
                  esbuildVersion: result.tooling.esbuildVersion || undefined,
                  pnpmVersion: result.tooling.pnpmVersion || undefined,
                },
              }
            : {}),
        };
      },
    },
  };
}
export type PlatformClient = ReturnType<typeof cliClient>;

export function platformClient(
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
) {
  return cliClient(platformTransport(credential, timeout, signal));
}

/** Authenticated Connect transport that converts errors to safe CLI errors. */
export function platformTransport(
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
): Transport {
  const headers = credentialHeaders(credential);
  const transport = createConnectTransport({
    baseUrl: `${credential.url}/api/rpc`,
    useBinaryFormat: true,
    defaultTimeoutMs: timeout,
    interceptors: [
      (next) => (request) => {
        for (const [key, value] of Object.entries(headers))
          request.header.set(key, value);
        return next(request);
      },
    ],
    fetch: async (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  // Convert errors after Connect's call boundary, which wraps interceptor errors.
  return {
    ...transport,
    unary: async (
      method,
      callSignal,
      timeoutMs,
      callHeaders,
      input,
      contextValues,
    ) => {
      try {
        return await transport.unary(
          method,
          callSignal ? AbortSignal.any([callSignal, signal]) : signal,
          timeoutMs,
          callHeaders,
          input,
          contextValues,
        );
      } catch (error) {
        const safe = publicError(error);
        let message = safe.message;
        for (const value of [credential.token, credential.apiKey])
          if (value) message = message.replaceAll(value, '[redacted]');
        throw new CliError(safe.code, message, safe.exitCode, safe.httpStatus);
      }
    },
  };
}

export function publicError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ConnectError) {
    const detail = error.findDetails(PublicErrorSchema)[0];
    const status = detail?.httpStatus;
    const exit =
      error.code === Code.Unauthenticated
        ? 3
        : error.code === Code.PermissionDenied
          ? 4
          : error.code === Code.NotFound
            ? 5
            : error.code === Code.Aborted ||
                error.code === Code.AlreadyExists ||
                error.code === Code.FailedPrecondition
              ? 6
              : error.code === Code.InvalidArgument ||
                  error.code === Code.OutOfRange ||
                  error.code === Code.ResourceExhausted
                ? 2
                : error.code === Code.Canceled
                  ? 130
                  : 7;
    const known = !!detail && !!status && status < 500;
    return new CliError(
      detail?.code ??
        (error.code === Code.Canceled
          ? 'cancelled'
          : error.code === Code.DeadlineExceeded
            ? 'outcome_unknown'
            : 'rpc_error'),
      known
        ? error.rawMessage
        : 'The platform request failed. Inspect platform state before retrying mutations.',
      exit,
      status,
    );
  }
  return new CliError('internal_error', 'CLI operation failed.', 1);
}
