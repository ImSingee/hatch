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
import { refreshRunEnvironment } from './run-credential';
import {
  type AppAi,
  type AppAiDefault,
  type AppAiDefaults,
  type AppAiModel,
  type AppBackend,
  type AppTask,
  type AppTaskRun,
  type AppTaskRunStep,
  type AppTaskRunSummary,
  type AppDoc,
  type GetAppRpcReferenceResponse,
  CreateAppRequestSchema,
  AppService,
} from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { AuthService } from '../../hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import {
  ImageService,
  type ImageModel,
} from '../../hatch-platform-api/gen/hatch/platform/v1/image_pb';
import {
  ThemeService,
  type ResolvedTheme,
  type ThemeEntry,
  type ThemeProblem,
  type ThemeState,
} from '../../hatch-platform-api/gen/hatch/platform/v1/theme_pb';
import {
  ServerService,
  type BuilderStatus,
  type ServerInfo,
} from '../../hatch-platform-api/gen/hatch/platform/v1/server_pb';
import {
  ModelService,
  type ProviderModel,
} from '../../hatch-platform-api/gen/hatch/platform/v1/model_pb';
import {
  ProviderService,
  type Provider,
} from '../../hatch-platform-api/gen/hatch/platform/v1/provider_pb';
import {
  CatalogService,
  type CatalogModel,
  type CatalogProvider,
  type CatalogStatus,
} from '../../hatch-platform-api/gen/hatch/platform/v1/catalog_pb';
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
import { PreferenceService } from '../../hatch-platform-api/gen/hatch/platform/v1/preference_pb';
import {
  type AppDeployment,
  type AppIcon,
} from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { SdkService } from '../../hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { PublicErrorSchema } from '../../hatch-platform-api/gen/hatch/platform/v1/error_pb';
import {
  type Resource,
  type Deployment,
  type RestoredVersion,
} from '../../hatch-platform-api/gen/hatch/platform/v1/lifecycle_pb';
import { type File } from '../../hatch-platform-api/gen/hatch/platform/v1/file_pb';
import type { AuthStatus } from '../../hatch-platform-api/auth';
import type { Profile } from './config';
import { CliError, fetchFailure } from './error';

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
const deployment = (value: Deployment) => ({
  deploymentId: value.deploymentId,
  version: value.version,
  compatibilityVersion: value.compatibilityVersion,
  ...(value.slug === undefined ? {} : { slug: value.slug }),
  normalized: jsonObject(toJson(ValueSchema, required(value.normalized))),
});
/** A deployment request as the CLI prints it. */
export type DeploymentView = ReturnType<typeof deploymentView>;
const deploymentView = (value: AppDeployment) => ({
  deploymentId: value.id,
  appId: value.appId,
  seq: value.seq,
  commit: value.commit,
  message: value.message,
  build: value.build,
  trigger: value.trigger,
  actor: value.actor ?? null,
  status: value.status,
  finished: value.finished,
  errorCode: value.errorCode ?? null,
  errorMessage: value.errorMessage ?? null,
  ...(value.deployment
    ? (({ deploymentId: _id, ...released }) => released)(
        deployment(value.deployment),
      )
    : {}),
  createdAt: value.createdAt,
  startedAt: value.startedAt ?? null,
  finishedAt: value.finishedAt ?? null,
  logSeq: value.logSeq,
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
const appDoc = (value: AppDoc | undefined) => {
  const doc = required(value);
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description ?? null,
    path: doc.path,
    bytes: doc.bytes,
    sha256: doc.sha256,
  };
};
export type AppDocView = ReturnType<typeof appDoc>;
/** The RPC reference as a plain DTO; absent optional values are `null`. */
const rpcReference = (result: GetAppRpcReferenceResponse) => {
  const endpoint = required(result.endpoint);
  return {
    appId: result.appId,
    version: result.version,
    deploymentId: result.deploymentId,
    endpoint: { url: endpoint.url, service: endpoint.service },
    complete: result.complete,
    services: result.services.map((service) => ({
      name: service.name,
      description: service.description ?? null,
      methods: service.methods.map((method) => ({
        name: method.name,
        description: method.description ?? null,
        inputType: method.inputType,
        outputType: method.outputType,
        clientStreaming: method.clientStreaming,
        serverStreaming: method.serverStreaming,
        deprecated: method.deprecated,
        idempotency: method.idempotency ?? null,
      })),
    })),
    types: result.types
      ? {
          messages: result.types.messages.map((message) => ({
            name: message.name,
            description: message.description ?? null,
            deprecated: message.deprecated,
            fields: message.fields.map((field) => ({
              name: field.name,
              jsonName: field.jsonName,
              kind: field.kind,
              type: field.type,
              label: field.label,
              mapKey: field.mapKey ?? null,
              oneof: field.oneof ?? null,
              description: field.description ?? null,
              deprecated: field.deprecated,
            })),
          })),
          enums: result.types.enums.map((entry) => ({
            name: entry.name,
            description: entry.description ?? null,
            deprecated: entry.deprecated,
            values: entry.values.map((value) => ({
              name: value.name,
              number: value.number,
              description: value.description ?? null,
              deprecated: value.deprecated,
            })),
          })),
        }
      : null,
    protoFiles: result.protoFiles.map((file) => ({
      path: file.path,
      content: file.content,
    })),
    markdown: result.markdown,
  };
};
const icon = (app: string, value: AppIcon | undefined) => ({
  // The id or slug the caller passed; `path` carries the immutable id.
  app,
  key: required(value).key ?? null,
  path: required(value).path ?? null,
  sizes: required(value).sizes,
});
const providerModel = (value: ProviderModel | undefined) => {
  const model = required(value);
  return {
    id: model.id,
    providerId: model.providerId,
    providerName: model.providerName,
    modelId: model.modelId,
    name: model.name,
    kind: model.kind,
    description: model.description,
    enabled: model.enabled,
    catalogRef: model.catalogRef ?? null,
    inCatalog: model.inCatalog,
    // Effective chat metadata; null for image models.
    chat: model.chat
      ? {
          reasoning: model.chat.reasoning,
          thinkingLevels: model.chat.thinkingLevels,
          defaultThinkingLevel: model.chat.defaultThinkingLevel,
          contextWindow: model.chat.contextWindow,
          maxTokens: model.chat.maxTokens,
          overridden: model.chat.overridden,
          reasoningOverride: model.chat.reasoningOverride ?? null,
          contextWindowOverride: model.chat.contextWindowOverride ?? null,
          maxTokensOverride: model.chat.maxTokensOverride ?? null,
        }
      : null,
  };
};
const providerSummary = (value: Provider | undefined) => {
  const provider = required(value);
  return {
    id: provider.id,
    name: provider.name,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    catalogProviderId: provider.catalogProviderId ?? null,
    hasApiKey: provider.hasApiKey,
    canGenerateImages: provider.canGenerateImages,
    modelCount: provider.models.length,
  };
};
const providerView = (value: Provider | undefined) => ({
  ...providerSummary(value),
  models: required(value).models.map(providerModel),
});
const catalogProvider = (provider: CatalogProvider) => ({
  id: provider.id,
  name: provider.name,
  apiType: provider.apiType,
  baseUrl: provider.baseUrl,
  description: provider.description ?? null,
  url: provider.url ?? null,
  apiKeyUrl: provider.apiKeyUrl ?? null,
  featured: provider.featured,
  recommendedModels: provider.recommendedModels,
});
const catalogModel = (model: CatalogModel) => ({
  ref: model.ref,
  providerId: model.providerId,
  modelId: model.modelId,
  name: model.name,
  kind: model.kind,
  description: model.description ?? null,
  releasedAt: model.releasedAt ?? null,
  reasoning: model.reasoning,
  thinkingLevels: model.thinkingLevels,
  defaultThinkingLevel: model.defaultThinkingLevel ?? null,
  contextWindow: model.contextWindow ?? null,
  maxTokens: model.maxTokens ?? null,
});
const catalogStatus = (value: CatalogStatus | undefined) => {
  const status = required(value);
  return {
    source: status.source,
    generatedAt: status.generatedAt,
    providerCount: status.providerCount,
    modelCount: status.modelCount,
    autoUpdate: status.autoUpdate,
    sourceUrl: status.sourceUrl ?? null,
    effectiveSourceUrl: status.effectiveSourceUrl,
    lastCheckedAt: status.lastCheckedAt ?? null,
    lastUpdatedAt: status.lastUpdatedAt ?? null,
    lastError: status.lastError ?? null,
  };
};
const themeEntry = (value: ThemeEntry | undefined) => {
  const entry = required(value);
  return {
    id: entry.id,
    name: entry.name,
    source: entry.source,
    appearance: entry.appearance,
    primary: entry.primary || null,
    valid: entry.valid,
    problems: entry.problems.map(themeProblem),
    document: entry.document ?? null,
  };
};
const theme = (value: ThemeState | undefined) => {
  const state = required(value);
  return {
    accent: state.accent || null,
    defaultAccent: state.defaultAccent,
    accents: state.accents.map((accent) => ({
      name: accent.name,
      color: accent.color,
    })),
    dockLabels: state.dockLabels,
    theme: themeEntry(state.theme),
    accentOverridesPrimary: state.accentOverridesPrimary,
  };
};
const resolvedTheme = (value: ResolvedTheme) => ({
  appearance: value.appearance,
  name: value.name,
  source: value.source,
  colors: value.colors,
  ramps: Object.fromEntries(
    Object.entries(value.ramps).map(([name, ramp]) => [name, ramp.shades]),
  ),
  radius: value.radius,
  fonts: value.fonts,
  shadows: value.shadows,
});
const themeProblem = (value: ThemeProblem) => ({
  code: value.code,
  path: value.path,
  message: value.message,
  ...(value.code === 'low_contrast'
    ? {
        pair: {
          foreground: value.foreground,
          background: value.background,
          ratio: value.ratio,
          required: value.requiredRatio,
        },
      }
    : {}),
});
const serverInfo = (
  value: ServerInfo | undefined,
  builder: BuilderStatus | undefined,
) => {
  const info = required(value);
  return {
    commit: info.commit ?? null,
    commitTime: info.commitTime ?? null,
    builder: {
      configured: builder?.configured ?? false,
      builders: (builder?.builders ?? []).map((entry) => ({
        id: entry.id,
        concurrency: entry.concurrency,
        running: entry.running,
        lastSeenAt: entry.lastSeenAt,
        online: entry.online,
      })),
    },
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
const imageModel = (value: ImageModel | undefined) => {
  const model = required(value);
  return {
    id: model.id,
    providerId: model.providerId,
    providerName: model.providerName,
    modelId: model.modelId,
    name: model.name,
    description: model.description,
    usable: model.usable,
  };
};
type CreateInput = {
  slug: string;
  name: string;
  description?: string;
  pin?: boolean;
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

const jsonOf = (value: Parameters<typeof toJson<typeof ValueSchema>>[1]) =>
  toJson(ValueSchema, value);

/** Public task DTOs: absent facts are explicit nulls, durations numbers. */
function taskView(task: AppTask) {
  return {
    name: task.name,
    method: task.method,
    title: task.title ?? null,
    description: task.description ?? null,
    concurrency: task.concurrency ?? null,
    inputType: task.inputType,
    inputSchema: task.inputSchema ?? {},
    cron: task.cron.map((job) => ({
      name: job.name,
      schedule: job.schedule,
      input: job.input ? jsonOf(job.input) : {},
      nextRun: job.nextRun ?? null,
    })),
    webhook: task.webhook,
    webhookPath: task.webhookPath ?? null,
    queued: task.queued,
    running: task.running,
    latestRun: task.latestRun
      ? {
          id: task.latestRun.id,
          status: task.latestRun.status,
          createdAt: task.latestRun.createdAt,
        }
      : null,
  };
}
export type AppTaskView = ReturnType<typeof taskView>;

function taskRunSummaryView(run: AppTaskRunSummary) {
  return {
    id: run.id,
    task: run.task,
    trigger: run.trigger,
    cronName: run.cronName ?? null,
    status: run.status,
    version: run.version ?? null,
    error: run.error ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs === undefined ? null : Number(run.durationMs),
    stepCount: run.stepCount,
  };
}
export type AppTaskRunSummaryView = ReturnType<typeof taskRunSummaryView>;

function taskRunStepView(step: AppTaskRunStep) {
  return {
    seq: step.seq,
    name: step.name,
    status: step.status,
    attempt: step.attempt,
    output: step.output ? jsonOf(step.output) : null,
    error: step.error ?? null,
    startedAt: step.startedAt ?? null,
    finishedAt: step.finishedAt ?? null,
    durationMs: step.durationMs === undefined ? null : Number(step.durationMs),
  };
}

function taskRunView(value: AppTaskRun | undefined) {
  const run = required(value);
  return {
    ...taskRunSummaryView(required(run.summary)),
    actor: run.actor ?? null,
    deploymentId: run.deploymentId ?? null,
    input: run.input ? jsonOf(run.input) : null,
    output: run.output ? jsonOf(run.output) : null,
    log: run.log ?? null,
    queuePosition: run.queuePosition ?? null,
    steps: run.steps.map(taskRunStepView),
  };
}
export type AppTaskRunView = ReturnType<typeof taskRunView>;

function aiModelView(model: AppAiModel) {
  return {
    id: model.id,
    providerName: model.providerName,
    modelId: model.modelId,
    name: model.name,
    ref: model.ref,
    reasoning: model.reasoning,
  };
}

function appAiView(value: AppAi | undefined) {
  const ai = required(value);
  return {
    appId: ai.appId,
    available: ai.available,
    roles: ai.roles.map((role) => ({
      name: role.name,
      kind: role.kind,
      description: role.description,
      needs: role.needs,
      model: role.model ? aiModelView(role.model) : null,
      bound: role.bound,
      defaultSource: role.defaultSource ?? null,
      unavailable: role.unavailable,
      missingNeeds: role.missingNeeds,
    })),
    chatModels: ai.chatModels.map(aiModelView),
    imageModels: ai.imageModels.map(aiModelView),
  };
}
export type AppAiView = ReturnType<typeof appAiView>;

function appAiDefaultView(value: AppAiDefault | undefined) {
  const entry = required(value);
  return {
    model: entry.model ? aiModelView(entry.model) : null,
    source: entry.source,
    unavailable: entry.unavailable,
  };
}

function appAiDefaultsView(value: AppAiDefaults | undefined) {
  const defaults = required(value);
  return {
    chat: appAiDefaultView(defaults.chat),
    image: appAiDefaultView(defaults.image),
    chatModels: defaults.chatModels.map(aiModelView),
    imageModels: defaults.imageModels.map(aiModelView),
  };
}
export type AppAiDefaultsView = ReturnType<typeof appAiDefaultsView>;
export type AppPackageView = {
  appId: string;
  deploymentId: string;
  version: number;
  build: number;
  nshAppId: string;
  nshVersion: string | null;
  sha256: string;
  size: number;
  keyId: string;
  bytecode: boolean;
};

function appPackageView(value: {
  appId: string;
  deploymentId: string;
  version: number;
  build: number;
  nshAppId: string;
  nshVersion?: string;
  sha256: string;
  size: number;
  keyId: string;
  bytecode: boolean;
}): AppPackageView {
  return {
    appId: value.appId,
    deploymentId: value.deploymentId,
    version: value.version,
    build: value.build,
    nshAppId: value.nshAppId,
    nshVersion: value.nshVersion ?? null,
    sha256: value.sha256,
    size: value.size,
    keyId: value.keyId,
    bytecode: value.bytecode,
  };
}

export type RuntimeTrustView = {
  initialized: boolean;
  appIdPattern: string;
  roots: { keyId: string; publicKey: string }[];
  releaseKeys: {
    keyId: string;
    publicKey: string;
    certificate: string;
    apps: string[];
    notBefore: string;
    notAfter: string;
    active: boolean;
    revoked: boolean;
  }[];
  revocations: {
    sequence: number;
    issuedAt: string;
    keyIds: string[];
    packageSha256s: string[];
    signed: string;
  } | null;
};

function runtimeTrustView(value: {
  initialized: boolean;
  appIdPattern: string;
  roots: { keyId: string; publicKey: string }[];
  releaseKeys: RuntimeTrustView['releaseKeys'];
  revocations?: NonNullable<RuntimeTrustView['revocations']>;
}): RuntimeTrustView {
  return {
    initialized: value.initialized,
    appIdPattern: value.appIdPattern,
    roots: value.roots.map((root) => ({
      keyId: root.keyId,
      publicKey: root.publicKey,
    })),
    releaseKeys: value.releaseKeys.map((key) => ({
      keyId: key.keyId,
      publicKey: key.publicKey,
      certificate: key.certificate,
      apps: [...key.apps],
      notBefore: key.notBefore,
      notAfter: key.notAfter,
      active: key.active,
      revoked: key.revoked,
    })),
    revocations: value.revocations
      ? {
          sequence: value.revocations.sequence,
          issuedAt: value.revocations.issuedAt,
          keyIds: [...value.revocations.keyIds],
          packageSha256s: [...value.revocations.packageSha256s],
          signed: value.revocations.signed,
        }
      : null,
  };
}

export function cliClient(transport: Transport) {
  const apps = createClient(AppService, transport);
  function lifecycle(client: {
    list: (
      request: Record<string, never>,
    ) => Promise<{ resources: Resource[] }>;
    create: (
      request: CreateInput,
    ) => Promise<{ id: string; slug: string; name: string; files: File[] }>;
    get: (request: { id: string }) => Promise<{ resource?: Resource }>;
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
  const servers = createClient(ServerService, transport);
  const models = createClient(ModelService, transport);
  const pins = createClient(PinService, transport);
  const dashboards = createClient(DashboardService, transport);
  const preferences = createClient(PreferenceService, transport);
  const providers = createClient(ProviderService, transport);
  const catalog = createClient(CatalogService, transport);
  const agentPreferences = (
    value: { messageMode: string } | undefined,
  ): { agentMessageMode: string } => ({
    agentMessageMode: required(value).messageMode,
  });
  const deskPreferences = (
    value: { backgroundAppMinutes: number } | undefined,
  ): { backgroundAppMinutes: number } => ({
    backgroundAppMinutes: required(value).backgroundAppMinutes,
  });
  /** `language` is null until the user picks one. */
  const interfacePreferences = (
    value: { language?: string } | undefined,
  ): { language: string | null } => ({
    language: required(value).language ?? null,
  });
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
      availableWidgets: async (page: { limit: number; cursor?: string }) => {
        const result = await dashboards.listAvailableWidgets(page);
        return {
          widgets: result.widgets.map(availableWidgetView),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
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
    models: {
      list: async (input: {
        kind?: string;
        providerId?: string;
        enabled?: boolean;
        limit: number;
        cursor?: string;
      }) => {
        const result = await models.listModels(input);
        return {
          models: result.models.map(providerModel),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
      setKind: async (input: { id: string; kind: string }) =>
        providerModel((await models.setModelKind(input)).model),
      create: async (input: {
        providerId: string;
        modelId: string;
        kind?: string;
        name?: string;
        description?: string;
        catalogRef?: string;
        noCatalog?: boolean;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
      }) => providerModel((await models.createModel(input)).model),
      update: async (input: {
        id: string;
        modelId?: string;
        name?: string;
        description?: string;
        catalogRef?: string;
        noCatalog?: boolean;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
        resetFields?: string[];
        enabled?: boolean;
      }) => providerModel((await models.updateModel(input)).model),
      delete: async (input: { id: string }) => {
        await models.deleteModel(input);
        return { id: input.id, deleted: true };
      },
      reorder: async (input: { providerId: string; modelIds: string[] }) => ({
        providerId: input.providerId,
        modelIds: (await models.reorderModels(input)).modelIds,
      }),
    },
    providers: {
      list: async (input: { limit: number; cursor?: string }) => {
        const page = await providers.listProviders(input);
        return {
          providers: page.providers.map(providerSummary),
          nextCursor: page.nextCursor ?? null,
        };
      },
      get: async (input: { id: string }) =>
        providerView((await providers.getProvider(input)).provider),
      create: async (input: {
        catalogProviderId?: string;
        name?: string;
        apiType?: string;
        baseUrl?: string;
        apiKey: string;
        models: { modelId: string; kind: string }[];
        noModels: boolean;
      }) => providerView((await providers.createProvider(input)).provider),
      update: async (input: {
        id: string;
        name?: string;
        apiType?: string;
        baseUrl?: string;
        apiKey?: string;
        enabled?: boolean;
        catalogProviderId?: string;
        clearCatalogProvider?: boolean;
      }) => providerView((await providers.updateProvider(input)).provider),
      delete: async (input: { id: string }) => {
        await providers.deleteProvider(input);
        return { id: input.id, deleted: true };
      },
      reorder: async (providerIds: string[]) => ({
        providerIds: (await providers.reorderProviders({ providerIds }))
          .providerIds,
      }),
      test: async (input: { id: string; modelId?: string }) => {
        const result = await providers.testProvider(input);
        return {
          providerId: input.id,
          ok: result.ok,
          modelId: result.modelId,
          latencyMs: result.latencyMs,
          error: result.error ?? null,
        };
      },
      remoteModels: async (input: {
        id: string;
        limit: number;
        cursor?: string;
      }) => {
        const page = await providers.listRemoteModels(input);
        return {
          providerId: input.id,
          models: page.models.map((model) => ({
            modelId: model.modelId,
            name: model.name ?? null,
            catalogRef: model.catalogRef ?? null,
            added: model.added,
          })),
          nextCursor: page.nextCursor ?? null,
          truncated: page.truncated,
        };
      },
    },
    catalog: {
      providers: async (input: {
        query?: string;
        limit: number;
        cursor?: string;
      }) => {
        const page = await catalog.listCatalogProviders(input);
        return {
          providers: page.providers.map(catalogProvider),
          nextCursor: page.nextCursor ?? null,
        };
      },
      models: async (input: {
        providerId?: string;
        query?: string;
        kind?: string;
        limit: number;
        cursor?: string;
      }) => {
        const result = await catalog.listCatalogModels(input);
        return {
          models: result.models.map(catalogModel),
          total: result.total,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
      status: async () =>
        catalogStatus((await catalog.getCatalogStatus({})).status),
      refresh: async () => {
        const result = await catalog.refreshCatalog({});
        return {
          outcome: result.outcome,
          status: catalogStatus(result.status),
        };
      },
      updateSettings: async (input: {
        autoUpdate?: boolean;
        sourceUrl?: string;
        clearSourceUrl?: boolean;
      }) => catalogStatus((await catalog.updateCatalogSettings(input)).status),
    },
    server: {
      info: async () => {
        const result = await servers.getServerInfo({});
        return serverInfo(result.server, result.builder);
      },
    },
    theme: {
      get: async (resolve = false) => {
        const result = await themes.getTheme({ resolve });
        return {
          ...theme(result.theme),
          ...(resolve && result.resolved
            ? { resolved: resolvedTheme(result.resolved) }
            : {}),
        };
      },
      set: async (input: {
        accent?: string;
        clearAccent?: boolean;
        dockLabels?: boolean;
        theme?: string;
      }) => theme((await themes.setTheme(input)).theme),
      reset: async () => theme((await themes.resetTheme({})).theme),
      list: async (page: { limit: number; cursor?: string }) => {
        const result = await themes.listThemes(page);
        return {
          themes: result.themes.map(themeEntry),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
      create: async (document: JsonObject) =>
        themeEntry((await themes.createTheme({ document })).theme),
      update: async (id: string, document: JsonObject) =>
        themeEntry((await themes.updateTheme({ id, document })).theme),
      delete: async (id: string) => {
        await themes.deleteTheme({ id });
        return { deleted: id };
      },
      validate: async (document: JsonObject) => {
        const result = await themes.validateTheme({ document });
        return {
          ok: result.ok,
          problems: result.problems.map(themeProblem),
          resolved: result.resolved ? resolvedTheme(result.resolved) : null,
        };
      },
    },
    pins: {
      list: async (page: { limit: number; cursor?: string }) => {
        const result = await pins.listPins(page);
        return {
          appPins: result.appPins.map(appPin),
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
    preferences: {
      // One DTO for all of the caller's preferences, from every service.
      get: async () => ({
        ...agentPreferences(
          (await preferences.getAgentPreferences({})).preferences,
        ),
        ...deskPreferences(
          (await preferences.getDeskPreferences({})).preferences,
        ),
        ...interfacePreferences(
          (await preferences.getInterfacePreferences({})).preferences,
        ),
      }),
      /**
       * Saves the given fields one service at a time; the others are read.
       * When a later step fails after an earlier one saved, the error says
       * what was saved and carries it as `details.applied`.
       */
      update: async (input: {
        agentMessageMode?: string;
        backgroundAppMinutes?: number;
        language?: string;
      }) => {
        const steps: {
          field: string;
          /** How a failed read of the field is described. */
          reading: string;
          given: boolean;
          run: () => Promise<Record<string, unknown>>;
        }[] = [
          {
            field: 'agentMessageMode',
            reading: 'reading the agent message mode failed.',
            given: input.agentMessageMode !== undefined,
            run: async () =>
              agentPreferences(
                input.agentMessageMode === undefined
                  ? (await preferences.getAgentPreferences({})).preferences
                  : (
                      await preferences.updateAgentPreferences({
                        messageMode: input.agentMessageMode,
                      })
                    ).preferences,
              ),
          },
          {
            field: 'backgroundAppMinutes',
            reading: 'reading the background time failed.',
            given: input.backgroundAppMinutes !== undefined,
            run: async () =>
              deskPreferences(
                input.backgroundAppMinutes === undefined
                  ? (await preferences.getDeskPreferences({})).preferences
                  : (
                      await preferences.updateDeskPreferences({
                        backgroundAppMinutes: input.backgroundAppMinutes,
                      })
                    ).preferences,
              ),
          },
          {
            field: 'language',
            reading: 'reading the language failed.',
            given: input.language !== undefined,
            run: async () =>
              interfacePreferences(
                input.language === undefined
                  ? (await preferences.getInterfacePreferences({})).preferences
                  : (
                      await preferences.updateInterfacePreferences({
                        language: input.language,
                      })
                    ).preferences,
              ),
          },
        ];
        const result: Record<string, unknown> = {};
        const applied: Record<string, unknown> = {};
        for (const [index, step] of steps.entries()) {
          try {
            const value = await step.run();
            Object.assign(result, value);
            if (step.given) Object.assign(applied, value);
          } catch (error) {
            const saved = Object.keys(applied);
            if (saved.length === 0) throw error;
            // What is already saved stays saved: say so, keeping the
            // failure's own code and exit status. Whether the failed field
            // was saved is known only when the platform refused it or the
            // request never left; otherwise (a timeout, a dropped
            // connection) it may have been.
            const failure = publicError(error);
            const failed = !step.given
              ? step.reading
              : failure.code === 'network_error' ||
                  (failure.httpStatus !== undefined && failure.httpStatus < 500)
                ? `${step.field} was not set.`
                : `whether ${step.field} was set is unknown; read it with hatch preferences get.`;
            const skipped = steps
              .slice(index + 1)
              .filter((later) => later.given)
              .map((later) => later.field);
            throw new CliError(
              failure.code,
              `${failure.message} ${saved.join(' and ')} ${
                saved.length === 1 ? 'was' : 'were'
              } already set; ${failed}${
                skipped.length > 0
                  ? ` ${skipped.join(' and ')} ${
                      skipped.length === 1 ? 'was' : 'were'
                    } not attempted.`
                  : ''
              }`,
              failure.exitCode,
              failure.httpStatus,
              { applied },
            );
          }
        }
        return result;
      },
    },
    images: {
      models: async (page: { limit: number; cursor?: string }) => {
        const list = await images.listImageModels(page);
        return {
          ...(list.nextCursor ? { nextCursor: list.nextCursor } : {}),
          models: list.models.map(imageModel),
          defaultModelId: list.defaultModelId ?? null,
          providers: list.providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            enabled: provider.enabled,
            suggestedModels: provider.suggestedModels,
          })),
        };
      },
      createModel: async (input: {
        providerId: string;
        modelId: string;
        name?: string;
        description?: string;
      }) => imageModel((await images.createImageModel(input)).model),
      updateModel: async (input: {
        id: string;
        modelId?: string;
        name?: string;
        description?: string;
      }) => imageModel((await images.updateImageModel(input)).model),
      deleteModel: async (input: { id: string }) => {
        await images.deleteImageModel(input);
        return { id: input.id, deleted: true };
      },
      generate: async (input: {
        prompt: string;
        count: number;
        quality?: string;
        glyphTile?: string;
        subjectTile?: string;
        imageModelId?: string;
      }) => {
        const result = await images.generateImages(input);
        return {
          imageModelId: result.imageModelId,
          modelId: result.modelId,
          candidates: result.candidates.map((candidate) => ({
            id: candidate.id,
            path: candidate.path,
          })),
        };
      },
    },
    apps: {
      nativePackage: {
        /** The live signed package: its description and its bytes. */
        get: async (input: { id: string }) => {
          let description: AppPackageView | undefined;
          const chunks: Uint8Array[] = [];
          for await (const message of apps.getAppPackage(input)) {
            if (message.part.case === 'package')
              description = appPackageView(message.part.value);
            else if (message.part.case === 'chunk')
              chunks.push(message.part.value);
          }
          if (!description) throw invalidResponse();
          return { package: description, bytes: Buffer.concat(chunks) };
        },
        trust: async () =>
          runtimeTrustView(required((await apps.getAppRuntimeTrust({})).trust)),
      },
      docs: {
        list: async (input: {
          id: string;
          limit?: number;
          cursor?: string;
        }) => {
          const result = await apps.listAppDocs(input);
          const endpoints = result.endpoints;
          return {
            appId: result.appId,
            version: result.version,
            deploymentId: result.deploymentId,
            docs: result.docs.map((value) => appDoc(value)),
            endpoints: {
              webhook: endpoints?.webhook
                ? { url: endpoints.webhook.url, auth: endpoints.webhook.auth }
                : null,
              rpc: endpoints?.rpc
                ? { url: endpoints.rpc.url, service: endpoints.rpc.service }
                : null,
            },
            nextCursor: result.nextCursor ?? null,
          };
        },
        get: async (input: { id: string; docId: string }) => {
          const result = await apps.getAppDoc(input);
          return {
            appId: result.appId,
            version: result.version,
            deploymentId: result.deploymentId,
            doc: appDoc(result.doc),
            content: result.content,
          };
        },
        rpc: async (input: { id: string }) =>
          rpcReference(await apps.getAppRpcReference(input)),
      },
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
        rollback: apps.rollbackApp,
      }),
      deployments: {
        create: async (input: {
          id: string;
          message: string;
          generation: string;
          commit?: string;
          build: 'builder' | 'local';
          allowDestructiveDataMigration?: boolean;
          dataMigrationApprovalToken?: string;
          notify?: boolean;
          /** Repeating it returns the deployment it already made. */
          requestId?: string;
        }) =>
          deploymentView(
            required((await apps.createAppDeployment(input)).deployment),
          ),
        upload: async (input: {
          id: string;
          deploymentId: string;
          artifact: Uint8Array;
        }) =>
          deploymentView(
            required(
              (await apps.uploadAppDeploymentArtifact(input)).deployment,
            ),
          ),
        get: async (
          input: { id: string; deploymentId: string },
          options: { timeoutMs?: number; signal?: AbortSignal } = {},
        ) =>
          deploymentView(
            required(
              (
                await apps.getAppDeployment(input, {
                  timeoutMs: options.timeoutMs,
                  signal: options.signal,
                })
              ).deployment,
            ),
          ),
        list: async (input: {
          id: string;
          limit?: number;
          cursor?: number;
          /** Only the deployment this create request made. */
          requestId?: string;
        }) => {
          const result = await apps.listAppDeployments(input);
          return {
            deployments: result.deployments.map((value) =>
              deploymentView(value),
            ),
            nextCursor: result.nextCursor ?? null,
          };
        },
        /** Unfinished deployments of every App, oldest first. */
        queue: async (input: { limit?: number; cursor?: string }) => {
          const result = await apps.listDeploymentQueue(input);
          return {
            entries: result.entries.map((entry) => ({
              appSlug: entry.appSlug,
              appName: entry.appName,
              queuePosition: entry.queuePosition ?? null,
              builderId: entry.builderId ?? null,
              deployment: deploymentView(required(entry.deployment)),
            })),
            nextCursor: result.nextCursor ?? null,
          };
        },
        cancel: async (input: {
          id: string;
          deploymentId: string;
          failureMessage?: string;
          failureCode?: 'app_build_failed' | 'APP_MANIFEST_INVALID';
        }) =>
          deploymentView(
            required((await apps.cancelAppDeployment(input)).deployment),
          ),
        /** Lines and state changes until the deployment finishes. */
        async *watch(
          input: { id: string; deploymentId: string; afterSeq?: number },
          options: { timeoutMs?: number; signal?: AbortSignal } = {},
        ) {
          for await (const message of apps.watchAppDeploymentLogs(input, {
            timeoutMs: options.timeoutMs,
            signal: options.signal,
          })) {
            yield {
              lines: message.lines.map((line) => ({
                seq: line.seq,
                stream: line.stream,
                text: line.text,
                at: line.at,
              })),
              deployment: message.deployment
                ? deploymentView(message.deployment)
                : null,
            };
          }
        },
      },
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
      task: {
        list: async (input: { id: string }) => {
          const result = await apps.listAppTasks(input);
          return {
            appId: result.appId,
            available: result.available,
            concurrency: result.concurrency,
            queued: result.queued,
            running: result.running,
            tasks: result.tasks.map(taskView),
          };
        },
        run: async (input: { id: string; task: string; input: JsonObject }) => {
          const result = await apps.runAppTask(input);
          return { runId: result.runId, status: result.status };
        },
        runs: async (input: {
          id: string;
          task?: string;
          status?: string;
          limit?: number;
          cursor?: string;
        }) => {
          const result = await apps.listAppTaskRuns(input);
          return {
            runs: result.runs.map(taskRunSummaryView),
            nextCursor: result.nextCursor ?? null,
          };
        },
        get: async (input: { id: string; runId: string }) =>
          taskRunView((await apps.getAppTaskRun(input)).run),
        cancel: async (input: { id: string; runId: string }) => {
          const result = await apps.cancelAppTaskRun(input);
          return { canceled: result.canceled, status: result.status };
        },
        rotateWebhookSecret: async (input: { id: string }) => {
          const result = await apps.rotateAppWebhookSecret(input);
          return { appId: result.appId, secret: result.secret };
        },
      },
      ai: {
        show: async (input: { id: string }) =>
          appAiView((await apps.getAppAi(input)).ai),
        setModel: async (input: { id: string; role: string; model?: string }) =>
          appAiView((await apps.setAppAiRoleModel(input)).ai),
        defaults: async () =>
          appAiDefaultsView((await apps.getAppAiDefaults({})).defaults),
        setDefaults: async (input: {
          chatModel?: string;
          clearChatModel: boolean;
          imageModel?: string;
          clearImageModel: boolean;
        }) => appAiDefaultsView((await apps.setAppAiDefaults(input)).defaults),
        usage: async (input: {
          id: string;
          limit?: number;
          cursor?: string;
        }) => {
          const result = await apps.listAppAiUsage(input);
          return {
            appId: result.appId,
            calls: result.calls.map((call) => ({
              id: call.id,
              createdAt: call.createdAt,
              role: call.role,
              kind: call.kind,
              providerName: call.providerName,
              modelId: call.modelId,
              status: call.status,
              errorCode: call.errorCode ?? null,
              inputTokens: call.inputTokens,
              outputTokens: call.outputTokens,
              cacheReadTokens: call.cacheReadTokens,
              cacheWriteTokens: call.cacheWriteTokens,
              images: call.images,
              durationMs: call.durationMs,
            })),
            nextCursor: result.nextCursor ?? null,
            monthStart: result.monthStart,
            monthTotals: result.monthTotals.map((row) => ({
              role: row.role,
              providerName: row.providerName,
              modelId: row.modelId,
              calls: row.calls,
              inputTokens: Number(row.inputTokens),
              outputTokens: Number(row.outputTokens),
              images: row.images,
            })),
          };
        },
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
      get: async () => {
        const result = await sdk.getSdk({ kind: 'app' });
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
                  nshVersion: result.tooling.nshVersion || undefined,
                  builderEnabled: result.tooling.builderEnabled,
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

/** When a JWT expires (its `exp`, in ms), or null for any other token. */
function jwtExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload || token.split('.').length !== 3) return null;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        exp?: unknown;
      }
    ).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A Run credential this close to expiry is replaced before a request. */
const RUN_CREDENTIAL_MARGIN_MS = 30_000;

/**
 * Authenticated Connect transport that converts errors to safe CLI errors.
 * Inside an Agent Run (the Runner's credential endpoint is configured), the
 * short-lived Run JWT is renewed before any request it would not outlive,
 * so a long build, follow or reconnect never sends an expired one.
 */
export function platformTransport(
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
): Transport {
  let headers = credentialHeaders(credential);
  const issued = new Set(
    [credential.token, credential.apiKey].filter(Boolean) as string[],
  );
  const runCredential =
    !credential.apiKey &&
    credential.token !== undefined &&
    process.env.HATCH_CLI_RUN_ENDPOINT !== undefined &&
    process.env.HATCH_CLI_TOKEN === credential.token;
  // One renewal at a time, shared by every request that needs it. Each
  // request waits only within its own deadline; the renewal stops once no
  // request waits for it any more.
  let renewal:
    | { done: Promise<void>; stop: AbortController; waiters: number }
    | undefined;
  const renew = (callSignal: AbortSignal) => {
    if (!renewal) {
      const stop = new AbortController();
      const entry = {
        stop,
        waiters: 0,
        done: refreshRunEnvironment(
          process.env,
          AbortSignal.any([signal, stop.signal]),
        ).then(() => {
          const next = process.env.HATCH_CLI_TOKEN;
          if (next) {
            issued.add(next);
            headers = { authorization: `Bearer ${next}` };
          }
        }),
      };
      // Settled or abandoned, it is no longer the one to join.
      entry.done
        .finally(() => {
          if (renewal === entry) renewal = undefined;
        })
        .catch(() => {});
      renewal = entry;
    }
    const entry = renewal;
    entry.waiters++;
    return new Promise<void>((resolve, reject) => {
      let left = false;
      const leave = (abandoned: boolean) => {
        if (left) return;
        left = true;
        callSignal.removeEventListener('abort', onAbort);
        if (--entry.waiters === 0 && abandoned && renewal === entry) {
          renewal = undefined;
          entry.stop.abort();
        }
      };
      // Connect ends the call with its own reason (deadline or cancel).
      const onAbort = () => {
        leave(true);
        reject(callSignal.reason);
      };
      callSignal.addEventListener('abort', onAbort, { once: true });
      if (callSignal.aborted) {
        onAbort();
        return;
      }
      entry.done.then(
        () => {
          leave(false);
          resolve();
        },
        (error: unknown) => {
          leave(false);
          reject(error);
        },
      );
    });
  };
  const current = async (callSignal: AbortSignal) => {
    if (!runCredential) return headers;
    const token = headers.authorization?.slice('Bearer '.length) ?? '';
    const expiresAt = jwtExpiresAt(token);
    if (expiresAt !== null && expiresAt - Date.now() > RUN_CREDENTIAL_MARGIN_MS)
      return headers;
    await renew(callSignal);
    return headers;
  };
  const transport = createConnectTransport({
    baseUrl: `${credential.url}/api/rpc`,
    useBinaryFormat: true,
    defaultTimeoutMs: timeout,
    interceptors: [
      (next) => async (request) => {
        for (const [key, value] of Object.entries(
          await current(request.signal),
        ))
          request.header.set(key, value);
        return next(request);
      },
    ],
    fetch: async (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  const convert = (error: unknown) => {
    // Connect reports what an interceptor or fetch threw as Unknown with
    // that error as the cause: a rejected fetch is a TypeError, and a Run
    // credential renewal that failed (no request was sent) a CliError.
    const cause =
      error instanceof ConnectError && error.code === Code.Unknown
        ? error.cause
        : undefined;
    const safe =
      cause instanceof TypeError
        ? fetchFailure(credential.url, cause)
        : cause instanceof CliError
          ? cause
          : publicError(error);
    let message = safe.message;
    for (const value of issued)
      message = message.replaceAll(value, '[redacted]');
    return new CliError(safe.code, message, safe.exitCode, safe.httpStatus);
  };
  // Convert errors after Connect's call boundary, which wraps interceptor errors.
  return {
    ...transport,
    stream: async (
      method,
      callSignal,
      timeoutMs,
      callHeaders,
      input,
      contextValues,
    ) => {
      try {
        const response = await transport.stream(
          method,
          callSignal ? AbortSignal.any([callSignal, signal]) : signal,
          timeoutMs,
          callHeaders,
          input,
          contextValues,
        );
        const messages = response.message;
        return {
          ...response,
          message: (async function* () {
            try {
              yield* messages;
            } catch (error) {
              throw convert(error);
            }
          })(),
        };
      } catch (error) {
        throw convert(error);
      }
    },
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
        throw convert(error);
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
