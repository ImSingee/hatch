/**
 * Server Functions for the AI Providers settings page and the model picker.
 * They call the same domain services as the public RPCs.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from './auth';
import {
  getAgentModelCatalog,
  type AgentModelCatalog,
} from './agent-model-catalog';
import {
  catalogProviders,
  searchCatalogModels,
  type CatalogModel,
  type CatalogProvider,
} from './model-catalog';
import {
  getCatalogStatus,
  refreshModelCatalog,
  updateCatalogSettings,
  type CatalogStatusView,
} from './model-catalog/refresh';
import {
  createProviderModel,
  deleteProviderModel,
  updateProviderModel,
} from './provider-models';
import {
  createProvider as createProviderRecord,
  deleteProvider as deleteProviderRecord,
  getModelView,
  listProviderViews,
  listRemoteModels,
  PROVIDER_API_TYPES,
  testProvider as testProviderConnection,
  updateProvider as updateProviderRecord,
  type ModelView,
  type ProviderTestResult,
  type ProviderView,
  type RemoteModel,
} from './provider-service';

export type ProviderWithModels = ProviderView;
export type ProviderModel = ModelView;

const apiTypeSchema = z.enum(PROVIDER_API_TYPES);
const kindSchema = z.enum(['chat', 'image']);
// Loose bounds on the wire; the domain services enforce the real limits.
const text = (max: number) => z.string().max(max);

/** List providers with their models. API keys are never returned. */
export const listProviders = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler((): Promise<ProviderView[]> => listProviderViews());

const createProviderSchema = z.object({
  catalogProviderId: text(80).nullish(),
  name: text(1000).optional(),
  apiType: apiTypeSchema.optional(),
  baseUrl: text(2000).optional(),
  apiKey: text(10000),
  models: z
    .array(z.object({ modelId: text(1000), kind: kindSchema.optional() }))
    .max(1000)
    .optional(),
});

export const createProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createProviderSchema>) =>
    createProviderSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const provider = await createProviderRecord(data);
    return { id: provider.id };
  });

const updateProviderSchema = z.object({
  id: z.string().min(1),
  name: text(1000).optional(),
  apiType: apiTypeSchema.optional(),
  baseUrl: text(2000).optional(),
  /** Empty or whitespace keeps the existing key. */
  apiKey: text(10000).optional(),
  enabled: z.boolean().optional(),
  catalogProviderId: text(80).nullable().optional(),
});

export const updateProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof updateProviderSchema>) =>
    updateProviderSchema.parse(data),
  )
  .handler(async ({ data }) => {
    await updateProviderRecord({
      ...data,
      apiKey: data.apiKey?.trim() ? data.apiKey : undefined,
    });
    return { ok: true };
  });

export const deleteProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await deleteProviderRecord(data.id);
    return { ok: true };
  });

const positive = z.number().int().positive();

const createModelSchema = z.object({
  providerId: z.string().min(1),
  kind: kindSchema.default('chat'),
  modelId: text(1000).min(1),
  name: text(1000).optional(),
  description: text(1000).optional(),
  catalogRef: text(400).nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
  contextWindow: positive.nullable().optional(),
  maxTokens: positive.nullable().optional(),
});

export const createModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createModelSchema>) =>
    createModelSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const row = await createProviderModel(data);
    return { id: row.id };
  });

const updateModelSchema = z.object({
  id: z.string().min(1),
  kind: kindSchema.optional(),
  modelId: text(1000).min(1).optional(),
  name: text(1000).optional(),
  description: text(1000).optional(),
  catalogRef: text(400).nullable().optional(),
  /** Null clears an override so the catalog value applies. */
  reasoning: z.boolean().nullable().optional(),
  contextWindow: positive.nullable().optional(),
  maxTokens: positive.nullable().optional(),
  enabled: z.boolean().optional(),
});

export const updateModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof updateModelSchema>) =>
    updateModelSchema.parse(data),
  )
  .handler(async ({ data }): Promise<ModelView> => {
    await updateProviderModel(data);
    return getModelView(data.id);
  });

export const deleteModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await deleteProviderModel(data.id);
    return { ok: true };
  });

/** Providers the "Add provider" gallery offers. */
export const listCatalogProviders = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler((): CatalogProvider[] => [...catalogProviders()]);

const searchCatalogSchema = z.object({
  providerId: text(80).optional(),
  query: text(200).optional(),
  kind: kindSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type CatalogSearchResult = {
  models: Array<{ providerId: string; model: CatalogModel }>;
  total: number;
};

export const searchCatalog = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof searchCatalogSchema>) =>
    searchCatalogSchema.parse(data),
  )
  .handler(({ data }): CatalogSearchResult => {
    const { hits, total } = searchCatalogModels(data);
    return { models: hits, total };
  });

export const fetchProviderModels = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) =>
    z.object({ id: z.string().min(1) }).parse(data),
  )
  .handler(
    async ({ data }): Promise<RemoteModel[]> =>
      (await listRemoteModels(data.id)).models,
  );

export const testProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string; modelId?: string }) =>
    z
      .object({ id: z.string().min(1), modelId: text(1000).optional() })
      .parse(data),
  )
  .handler(async ({ data }): Promise<ProviderTestResult> =>
    testProviderConnection(data.id, data.modelId),
  );

/** The chat models the signed-in user can pick, and the first one. */
export const getAgentModelChoices = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler((): Promise<AgentModelCatalog> => getAgentModelCatalog());

export const getModelCatalogStatus = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler((): Promise<CatalogStatusView> => getCatalogStatus());

export const refreshCatalog = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(() => refreshModelCatalog());

export const updateModelCatalogSettings = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { autoUpdate?: boolean; sourceUrl?: string | null }) =>
    z
      .object({
        autoUpdate: z.boolean().optional(),
        sourceUrl: text(2000).nullable().optional(),
      })
      .parse(data),
  )
  .handler(({ data }): Promise<CatalogStatusView> =>
    updateCatalogSettings({
      autoUpdate: data.autoUpdate,
      sourceUrl:
        data.sourceUrl === undefined
          ? undefined
          : data.sourceUrl?.trim() || null,
    }),
  );
