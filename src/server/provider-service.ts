/**
 * Server-only: AI providers and their models as the Web UI and the public
 * RPCs see them. API keys go in but never come out; views only say whether
 * a provider has one.
 */
import { eq, sql } from 'drizzle-orm';
import { buildRunModels } from '~agent/remote-models';
import { db, schema } from '~/db';
import type {
  AgentModelKind,
  AgentThinkingLevel,
  ProviderApiType,
} from '~/db/schema';
import { AppError } from '~server/errors';
import { imageDriverFor } from '~server/images/drivers';
import {
  catalogModelByRef,
  catalogProvider,
  matchCatalogModel,
  parseCatalogRef,
} from '~server/model-catalog';
import {
  assertApiTypeKeepsModels,
  canGenerateImages,
  createProviderModel,
  updateProviderModel,
} from '~server/provider-models';
import { resolveModelSpec, type ModelSpec } from '~server/model-spec';

export const PROVIDER_API_TYPES = [
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
] as const satisfies readonly ProviderApiType[];

export const MAX_PROVIDER_NAME_LENGTH = 120;
export const MAX_BASE_URL_LENGTH = 500;
export const MAX_API_KEY_LENGTH = 4096;
/** Models one create request may add. */
export const MAX_MODELS_PER_CREATE = 100;

export type ModelChatSpec = Pick<
  ModelSpec,
  | 'reasoning'
  | 'thinkingLevels'
  | 'defaultThinkingLevel'
  | 'contextWindow'
  | 'maxTokens'
  | 'overridden'
  | 'catalogValues'
>;

export type ModelView = {
  id: string;
  providerId: string;
  providerName: string;
  kind: AgentModelKind;
  /** Model id sent to the provider. */
  modelId: string;
  name: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  /** Catalog entry supplying metadata, or null. */
  catalogRef: string | null;
  /** False when `catalogRef` is set but the catalog no longer has it. */
  inCatalog: boolean;
  /** "<catalog provider name> · <catalog model name>" when in the catalog. */
  catalogLabel: string | null;
  /** Stored overrides; null follows the catalog. */
  overrides: {
    reasoning: boolean | null;
    contextWindow: number | null;
    maxTokens: number | null;
  };
  /** Effective chat metadata; null for image models. */
  chat: ModelChatSpec | null;
};

export type ProviderView = {
  id: string;
  name: string;
  apiType: ProviderApiType;
  baseUrl: string;
  enabled: boolean;
  sortOrder: number;
  catalogProviderId: string | null;
  hasApiKey: boolean;
  canGenerateImages: boolean;
  /** Image model ids to suggest; empty when the API cannot make images. */
  imageModelSuggestions: string[];
  models: ModelView[];
};

type ProviderRow = typeof schema.agentProviders.$inferSelect;
type ModelRow = typeof schema.agentModels.$inferSelect;

function modelView(provider: ProviderRow, model: ModelRow): ModelView {
  const entry = model.catalogRef
    ? catalogModelByRef(model.catalogRef)
    : undefined;
  const ref = model.catalogRef ? parseCatalogRef(model.catalogRef) : null;
  const spec =
    model.kind === 'chat' ? resolveModelSpec(model, provider.apiType) : null;
  return {
    id: model.id,
    providerId: provider.id,
    providerName: provider.name,
    kind: model.kind,
    modelId: model.modelId,
    name: model.name,
    description: model.description,
    enabled: model.enabled,
    sortOrder: model.sortOrder,
    catalogRef: model.catalogRef,
    inCatalog: entry !== undefined,
    catalogLabel:
      entry && ref
        ? `${catalogProvider(ref.providerId)?.name ?? ref.providerId} · ${entry.name}`
        : null,
    overrides: {
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    },
    chat: spec && {
      reasoning: spec.reasoning,
      thinkingLevels: spec.thinkingLevels,
      defaultThinkingLevel: spec.defaultThinkingLevel,
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
      overridden: spec.overridden,
      catalogValues: spec.catalogValues,
    },
  };
}

function providerView(provider: ProviderRow, models: ModelRow[]): ProviderView {
  return {
    id: provider.id,
    name: provider.name,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    sortOrder: provider.sortOrder,
    catalogProviderId: provider.catalogProviderId,
    hasApiKey: provider.apiKey.length > 0,
    canGenerateImages: canGenerateImages(provider.apiType),
    imageModelSuggestions: [
      ...(imageDriverFor(provider.apiType)?.suggestedModels ?? []),
    ],
    models: models
      .filter((model) => model.providerId === provider.id)
      .map((model) => modelView(provider, model)),
  };
}

/** Every provider with its models, in display order. */
export async function listProviderViews(): Promise<ProviderView[]> {
  const providers = await db.query.agentProviders.findMany({
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  const models = providers.length
    ? await db.query.agentModels.findMany({
        where: { providerId: { in: providers.map((p) => p.id) } },
        orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      })
    : [];
  return providers.map((provider) => providerView(provider, models));
}

export async function getProviderView(id: string): Promise<ProviderView> {
  const provider = await db.query.agentProviders.findFirst({ where: { id } });
  if (!provider) throw new AppError('Provider not found.', 404);
  const models = await db.query.agentModels.findMany({
    where: { providerId: id },
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  return providerView(provider, models);
}

/** Every model, in provider order then model order. */
export async function listModelViews(filter: {
  kind?: AgentModelKind;
  providerId?: string;
  enabled?: boolean;
}): Promise<ModelView[]> {
  return (await listProviderViews())
    .filter(
      (provider) => !filter.providerId || provider.id === filter.providerId,
    )
    .flatMap((provider) => provider.models)
    .filter(
      (model) =>
        (!filter.kind || model.kind === filter.kind) &&
        (filter.enabled === undefined || model.enabled === filter.enabled),
    );
}

export async function getModelView(id: string): Promise<ModelView> {
  const model = await db.query.agentModels.findFirst({
    where: { id },
    columns: { providerId: true },
  });
  if (!model) throw new AppError('Model not found.', 404);
  const found = (await getProviderView(model.providerId)).models.find(
    (item) => item.id === id,
  );
  if (!found) throw new AppError('Model not found.', 404);
  return found;
}

/** Move a model between chat and image, as the Web model form can. */
export async function setProviderModelKind(
  id: string,
  kind: AgentModelKind,
): Promise<ModelView> {
  await updateProviderModel({ id, kind });
  return getModelView(id);
}

function checkProviderName(value: string): string {
  const name = value.trim();
  if (!name) throw new AppError('Provider name is required.', 400);
  if (Array.from(name).length > MAX_PROVIDER_NAME_LENGTH)
    throw new AppError(
      `Provider name must be at most ${MAX_PROVIDER_NAME_LENGTH} characters.`,
      400,
    );
  return name;
}

function checkBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AppError('Base URL must be an http(s) URL.', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new AppError('Base URL must be an http(s) URL.', 400);
  if (text.length > MAX_BASE_URL_LENGTH)
    throw new AppError(
      `Base URL must be at most ${MAX_BASE_URL_LENGTH} characters.`,
      400,
    );
  return text;
}

function checkApiKey(value: string): string {
  const key = value.trim();
  if (!key) throw new AppError('API key is required.', 400);
  if (key.length > MAX_API_KEY_LENGTH || /\s/.test(key))
    throw new AppError('API key is not valid.', 400);
  return key;
}

function checkCatalogProvider(id: string) {
  const provider = catalogProvider(id);
  if (!provider)
    throw new AppError(`Catalog provider "${id}" does not exist.`, 400);
  return provider;
}

export type CreateProviderInput = {
  /** Preset to start from; supplies name, API type and base URL defaults. */
  catalogProviderId?: string | null;
  name?: string;
  apiType?: ProviderApiType;
  baseUrl?: string;
  apiKey: string;
  /**
   * Models to add. Unset adds the catalog provider's recommended models;
   * an empty list adds none.
   */
  models?: Array<{ modelId: string; kind?: AgentModelKind }>;
};

export async function createProvider(
  input: CreateProviderInput,
): Promise<ProviderView> {
  const preset = input.catalogProviderId
    ? checkCatalogProvider(input.catalogProviderId)
    : null;
  const name = checkProviderName(input.name ?? preset?.name ?? '');
  const apiType = input.apiType ?? preset?.apiType;
  if (!apiType)
    throw new AppError('API type is required for a custom provider.', 400);
  const baseUrl = checkBaseUrl(input.baseUrl ?? preset?.baseUrl ?? '');
  const apiKey = checkApiKey(input.apiKey);
  const models: Array<{ modelId: string; kind?: AgentModelKind }> =
    input.models ?? (preset?.recommended ?? []).map((modelId) => ({ modelId }));
  if (models.length > MAX_MODELS_PER_CREATE)
    throw new AppError(
      `At most ${MAX_MODELS_PER_CREATE} models can be added at once.`,
      400,
    );

  const id = await db.transaction(async (tx) => {
    const [{ next }] = await tx
      .select({
        next: sql<number>`coalesce(max(${schema.agentProviders.sortOrder}) + 1, 0)`,
      })
      .from(schema.agentProviders);
    const [row] = await tx
      .insert(schema.agentProviders)
      .values({
        name,
        apiType,
        baseUrl,
        apiKey,
        catalogProviderId: preset?.id ?? null,
        sortOrder: Number(next),
      })
      .returning({ id: schema.agentProviders.id });
    const seen = new Set<string>();
    for (const model of models) {
      const kind = model.kind ?? 'chat';
      const key = `${kind}\u0000${model.modelId.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await createProviderModel(
        { providerId: row.id, kind, modelId: model.modelId },
        tx,
      );
    }
    return row.id;
  });
  return getProviderView(id);
}

export type UpdateProviderInput = {
  id: string;
  name?: string;
  apiType?: ProviderApiType;
  baseUrl?: string;
  /** Replaces the key; unset keeps it. */
  apiKey?: string;
  enabled?: boolean;
  /** Links to a catalog provider; null unlinks it. */
  catalogProviderId?: string | null;
};

export async function updateProvider(
  input: UpdateProviderInput,
): Promise<ProviderView> {
  const current = await db.query.agentProviders.findFirst({
    where: { id: input.id },
  });
  if (!current) throw new AppError('Provider not found.', 404);
  if (input.apiType !== undefined)
    await assertApiTypeKeepsModels(input.id, input.apiType);
  const patch: Partial<typeof schema.agentProviders.$inferInsert> = {};
  if (input.name !== undefined) patch.name = checkProviderName(input.name);
  if (input.apiType !== undefined) patch.apiType = input.apiType;
  if (input.baseUrl !== undefined) patch.baseUrl = checkBaseUrl(input.baseUrl);
  if (input.apiKey !== undefined) patch.apiKey = checkApiKey(input.apiKey);
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.catalogProviderId !== undefined)
    patch.catalogProviderId =
      input.catalogProviderId === null
        ? null
        : checkCatalogProvider(input.catalogProviderId).id;
  await db.transaction(async (tx) => {
    if (Object.keys(patch).length)
      await tx
        .update(schema.agentProviders)
        .set(patch)
        .where(eq(schema.agentProviders.id, input.id));
    const linked = patch.catalogProviderId;
    if (linked === undefined || linked === current.catalogProviderId) return;
    // Models that had no catalog entry, or one from the old link, take
    // their metadata from the new link where it has them.
    const oldPrefix = current.catalogProviderId
      ? `${current.catalogProviderId}/`
      : null;
    const models = await tx.query.agentModels.findMany({
      where: { providerId: input.id },
      columns: { id: true, modelId: true, kind: true, catalogRef: true },
    });
    for (const model of models) {
      if (
        model.catalogRef !== null &&
        !(oldPrefix && model.catalogRef.startsWith(oldPrefix))
      )
        continue;
      const catalogRef = matchCatalogModel(linked, model.modelId, model.kind);
      if (catalogRef !== model.catalogRef)
        await tx
          .update(schema.agentModels)
          .set({ catalogRef })
          .where(eq(schema.agentModels.id, model.id));
    }
  });
  return getProviderView(input.id);
}

export async function deleteProvider(id: string): Promise<void> {
  const deleted = await db
    .delete(schema.agentProviders)
    .where(eq(schema.agentProviders.id, id))
    .returning({ id: schema.agentProviders.id });
  if (!deleted.length) throw new AppError('Provider not found.', 404);
}

/** ================== talking to the provider ================== */

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const MAX_REMOTE_LIST_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_MODELS = 2000;
const MESSAGE_LIMIT = 300;

function redact(text: string, apiKey: string): string {
  const clean = apiKey ? text.replaceAll(apiKey, '[redacted]') : text;
  return clean.slice(0, MESSAGE_LIMIT);
}

async function loadProviderRow(id: string): Promise<ProviderRow> {
  const provider = await db.query.agentProviders.findFirst({ where: { id } });
  if (!provider) throw new AppError('Provider not found.', 404);
  if (!provider.apiKey)
    throw new AppError('Add an API key to this provider first.', 409);
  return provider;
}

export type ProviderTestResult = {
  ok: boolean;
  /** Model id the test asked. */
  modelId: string;
  latencyMs: number;
  /** The provider's error, without the key; absent on success. */
  error?: string;
};

/**
 * Send one tiny prompt through the same client a run uses. The model is the
 * one named, else the provider's first enabled chat model.
 */
export async function testProvider(
  id: string,
  modelId?: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  const provider = await loadProviderRow(id);
  const model = await db.query.agentModels.findFirst({
    where: modelId
      ? { providerId: id, kind: 'chat', modelId }
      : { providerId: id, kind: 'chat', enabled: true },
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  if (!model)
    throw new AppError(
      modelId
        ? `This provider has no chat model "${modelId}".`
        : 'Add a chat model to this provider first.',
      modelId ? 404 : 409,
    );
  const spec = resolveModelSpec(model, provider.apiType);
  const { models, picked } = buildRunModels({
    providerId: provider.id,
    providerName: provider.name,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    thinkingLevel: 'off',
    model: {
      id: model.modelId,
      name: model.name,
      reasoning: spec.reasoning,
      input: ['text', 'image'],
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
      thinkingLevelMap: spec.thinkingLevelMap,
      compat: spec.compat,
    },
  });
  const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  const started = Date.now();
  const lowest = spec.thinkingLevels.find((level) => level !== 'off');
  try {
    const reply = await models.completeSimple(
      picked.model,
      {
        messages: [
          { role: 'user', timestamp: started, content: 'Reply with OK.' },
        ],
      },
      {
        maxTokens: 256,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        // Models that cannot skip thinking get the cheapest level.
        ...(spec.thinkingLevels.length && !spec.thinkingLevels.includes('off')
          ? { reasoning: lowest as Exclude<AgentThinkingLevel, 'off'> }
          : {}),
      },
    );
    const latencyMs = Date.now() - started;
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted')
      return {
        ok: false,
        modelId: model.modelId,
        latencyMs,
        error: redact(
          timeout.aborted
            ? 'The provider did not answer in time.'
            : (reply.errorMessage ?? 'The provider returned an error.'),
          provider.apiKey,
        ),
      };
    return { ok: true, modelId: model.modelId, latencyMs };
  } catch (error) {
    return {
      ok: false,
      modelId: model.modelId,
      latencyMs: Date.now() - started,
      error: redact(
        error instanceof Error ? error.message : 'The request failed.',
        provider.apiKey,
      ),
    };
  }
}

export type RemoteModel = {
  /** Model id the provider lists. */
  modelId: string;
  /** Display name from the provider, when it gives one. */
  name?: string;
};

/** The provider's model-list endpoint and auth headers for its API type. */
function modelListRequest(provider: ProviderRow): {
  url: string;
  headers: Record<string, string>;
} {
  if (provider.apiType === 'anthropic-messages')
    return {
      url: `${provider.baseUrl}/v1/models?limit=1000`,
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
    };
  return {
    url: `${provider.baseUrl}/models`,
    headers: { authorization: `Bearer ${provider.apiKey}` },
  };
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REMOTE_LIST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('The provider’s model list is too large.', 400);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The models the provider itself lists (`GET …/models`). */
export async function listRemoteModels(
  id: string,
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
  const provider = await loadProviderRow(id);
  const request = modelListRequest(provider);
  const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(request.url, {
      headers: { accept: 'application/json', ...request.headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
  } catch {
    throw new AppError('The provider could not be reached.', 400);
  }
  const text = await readLimited(response);
  if (!response.ok)
    throw new AppError(
      `The provider refused to list models (${response.status}): ${redact(text, provider.apiKey) || 'no details'}`,
      400,
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError('The provider’s model list is not JSON.', 400);
  }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data))
    throw new AppError('The provider’s model list has no data.', 400);
  const seen = new Set<string>();
  const models: RemoteModel[] = [];
  for (const entry of data) {
    const modelId = (entry as { id?: unknown })?.id;
    if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 200)
      continue;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const name =
      (entry as { display_name?: unknown; name?: unknown })?.display_name ??
      (entry as { name?: unknown })?.name;
    models.push({
      modelId,
      ...(typeof name === 'string' && name.trim() && name.length <= 200
        ? { name: name.trim() }
        : {}),
    });
    if (models.length >= MAX_REMOTE_MODELS) break;
  }
  return models.sort((a, b) => a.modelId.localeCompare(b.modelId));
}
