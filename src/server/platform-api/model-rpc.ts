/**
 * Public RPCs for providers, their models and the model catalog. Every
 * credential type may call them; they share the domain services with the
 * Web UI's Server Functions.
 */
import type { ConnectRouter } from '@connectrpc/connect';
import type { AgentModelKind, ProviderApiType } from '~/db/schema';
import { listPage } from '~server/list-page';
import {
  catalogProviders,
  catalogRef,
  parseCatalogRef,
  catalogModel,
  searchCatalogModels,
  type CatalogModel,
} from '~server/model-catalog';
import {
  getCatalogStatus,
  refreshModelCatalog,
  updateCatalogSettings,
  type CatalogStatusView,
} from '~server/model-catalog/refresh';
import {
  createProviderModel,
  deleteProviderModel,
  updateProviderModel,
} from '~server/provider-models';
import {
  createProvider,
  deleteProvider,
  getModelView,
  getProviderView,
  listModelViews,
  listProviderViews,
  listRemoteModels,
  setProviderModelKind,
  testProvider,
  updateProvider,
  type ModelView,
  type ProviderView,
} from '~server/provider-service';
import { CatalogService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/catalog_pb';
import { ModelService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/model_pb';
import { ProviderService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/provider_pb';
import { publicApiError } from './errors';

const RESET_FIELDS = {
  reasoning: 'reasoning',
  context_window: 'contextWindow',
  max_tokens: 'maxTokens',
} as const;
const OVERRIDDEN_NAMES = {
  reasoning: 'reasoning',
  contextWindow: 'context_window',
  maxTokens: 'max_tokens',
} as const;

export function modelMessage(model: ModelView) {
  return {
    id: model.id,
    providerId: model.providerId,
    providerName: model.providerName,
    modelId: model.modelId,
    name: model.name,
    kind: model.kind,
    description: model.description,
    enabled: model.enabled,
    catalogRef: model.catalogRef ?? undefined,
    inCatalog: model.inCatalog,
    chat: model.chat
      ? {
          reasoning: model.chat.reasoning,
          thinkingLevels: model.chat.thinkingLevels,
          defaultThinkingLevel: model.chat.defaultThinkingLevel,
          contextWindow: model.chat.contextWindow,
          maxTokens: model.chat.maxTokens,
          overridden: model.chat.overridden.map(
            (field) => OVERRIDDEN_NAMES[field],
          ),
          reasoningOverride: model.overrides.reasoning ?? undefined,
          contextWindowOverride: model.overrides.contextWindow ?? undefined,
          maxTokensOverride: model.overrides.maxTokens ?? undefined,
        }
      : undefined,
  };
}

function providerMessage(provider: ProviderView) {
  return {
    id: provider.id,
    name: provider.name,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    catalogProviderId: provider.catalogProviderId ?? undefined,
    hasApiKey: provider.hasApiKey,
    canGenerateImages: provider.canGenerateImages,
    models: provider.models.map(modelMessage),
  };
}

function catalogModelMessage(providerId: string, model: CatalogModel) {
  return {
    ref: catalogRef(providerId, model.id),
    providerId,
    modelId: model.id,
    name: model.name,
    kind: model.kind,
    description: model.description,
    releasedAt: model.releasedAt,
    reasoning: model.reasoning,
    thinkingLevels: model.thinkingLevels,
    defaultThinkingLevel: model.defaultThinkingLevel,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function statusMessage(status: CatalogStatusView) {
  return {
    ...status,
    sourceUrl: status.sourceUrl ?? undefined,
    lastCheckedAt: status.lastCheckedAt ?? undefined,
    lastUpdatedAt: status.lastUpdatedAt ?? undefined,
    lastError: status.lastError ?? undefined,
  };
}

/** Reject two fields that contradict each other, naming both. */
function exclusive(first: boolean, second: boolean, names: string) {
  if (first && second)
    throw publicApiError('BAD_REQUEST', `Set only one of ${names}.`);
}

function catalogRefInput(
  ref: string | undefined,
  noCatalog: boolean,
): string | null | undefined {
  exclusive(ref !== undefined, noCatalog, 'catalog_ref and no_catalog');
  if (noCatalog) return null;
  if (ref !== undefined && !parseCatalogRef(ref))
    throw publicApiError(
      'BAD_REQUEST',
      'catalog_ref must look like "<catalog provider>/<model id>".',
    );
  return ref;
}

export function registerModelServices(router: ConnectRouter): void {
  router.service(ProviderService, {
    listProviders: async (input) => {
      const page = listPage(await listProviderViews(), input);
      return {
        providers: page.items.map(providerMessage),
        nextCursor: page.nextCursor,
      };
    },
    getProvider: async (input) => ({
      provider: providerMessage(await getProviderView(input.id)),
    }),
    createProvider: async (input) => {
      if (!input.catalogProviderId) {
        const missing = (['name', 'apiType', 'baseUrl'] as const).filter(
          (field) => input[field] === undefined,
        );
        if (missing.length)
          throw publicApiError(
            'BAD_REQUEST',
            'A provider without catalog_provider_id needs name, api_type and base_url.',
          );
      }
      exclusive(
        input.models.length > 0,
        input.noModels,
        'models and no_models',
      );
      const provider = await createProvider({
        catalogProviderId: input.catalogProviderId,
        name: input.name,
        apiType: input.apiType as ProviderApiType | undefined,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        models: input.noModels
          ? []
          : input.models.length
            ? input.models.map((model) => ({
                modelId: model.modelId,
                kind: model.kind as AgentModelKind | undefined,
              }))
            : undefined,
      });
      return { provider: providerMessage(provider) };
    },
    updateProvider: async (input) => {
      exclusive(
        input.catalogProviderId !== undefined,
        input.clearCatalogProvider,
        'catalog_provider_id and clear_catalog_provider',
      );
      const provider = await updateProvider({
        id: input.id,
        name: input.name,
        apiType: input.apiType as ProviderApiType | undefined,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        enabled: input.enabled,
        catalogProviderId: input.clearCatalogProvider
          ? null
          : input.catalogProviderId,
      });
      return { provider: providerMessage(provider) };
    },
    deleteProvider: async (input) => {
      await deleteProvider(input.id);
      return {};
    },
    testProvider: async (input, context) => {
      const result = await testProvider(
        input.id,
        input.modelId,
        context.signal,
      );
      return { ...result, latencyMs: Math.round(result.latencyMs) };
    },
    listRemoteModels: async (input, context) => {
      const provider = await getProviderView(input.id);
      const remote = await listRemoteModels(input.id, context.signal);
      const added = new Set(provider.models.map((model) => model.modelId));
      const page = listPage(remote.models, input);
      return {
        truncated: remote.truncated,
        nextCursor: page.nextCursor,
        models: page.items.map((model) => ({
          modelId: model.modelId,
          name: model.name,
          catalogRef:
            provider.catalogProviderId &&
            catalogModel(provider.catalogProviderId, model.modelId)
              ? catalogRef(provider.catalogProviderId, model.modelId)
              : undefined,
          added: added.has(model.modelId),
        })),
      };
    },
  });

  router.service(ModelService, {
    listModels: async (input) => {
      const page = listPage(
        await listModelViews({
          kind: input.kind as AgentModelKind | undefined,
          providerId: input.providerId,
          enabled: input.enabled,
        }),
        input,
      );
      return {
        models: page.items.map(modelMessage),
        nextCursor: page.nextCursor,
      };
    },
    setModelKind: async (input) => ({
      model: modelMessage(
        await setProviderModelKind(input.id, input.kind as AgentModelKind),
      ),
    }),
    createModel: async (input) => {
      const row = await createProviderModel({
        providerId: input.providerId,
        kind: (input.kind as AgentModelKind | undefined) ?? 'chat',
        modelId: input.modelId,
        name: input.name,
        description: input.description,
        catalogRef: catalogRefInput(input.catalogRef, input.noCatalog),
        reasoning: input.reasoning,
        contextWindow: input.contextWindow,
        maxTokens: input.maxTokens,
      });
      return { model: modelMessage(await getModelView(row.id)) };
    },
    updateModel: async (input) => {
      const reset = new Set(
        input.resetFields.map(
          (field) => RESET_FIELDS[field as keyof typeof RESET_FIELDS],
        ),
      );
      exclusive(
        reset.has('reasoning') && input.reasoning !== undefined,
        true,
        'reasoning and reset_fields "reasoning"',
      );
      exclusive(
        reset.has('contextWindow') && input.contextWindow !== undefined,
        true,
        'context_window and reset_fields "context_window"',
      );
      exclusive(
        reset.has('maxTokens') && input.maxTokens !== undefined,
        true,
        'max_tokens and reset_fields "max_tokens"',
      );
      await updateProviderModel({
        id: input.id,
        modelId: input.modelId,
        name: input.name,
        description: input.description,
        catalogRef: catalogRefInput(input.catalogRef, input.noCatalog),
        reasoning: reset.has('reasoning') ? null : input.reasoning,
        contextWindow: reset.has('contextWindow') ? null : input.contextWindow,
        maxTokens: reset.has('maxTokens') ? null : input.maxTokens,
        enabled: input.enabled,
      });
      return { model: modelMessage(await getModelView(input.id)) };
    },
    deleteModel: async (input) => {
      await deleteProviderModel(input.id);
      return {};
    },
  });

  router.service(CatalogService, {
    listCatalogProviders: () => ({
      providers: catalogProviders().map((provider) => ({
        ...provider,
        recommendedModels: provider.recommended,
      })),
    }),
    listCatalogModels: (input) => {
      const limit = input.limit || 50;
      const offset = input.cursor ? Number(input.cursor) : 0;
      const { hits, total } = searchCatalogModels({
        providerId: input.providerId,
        query: input.query,
        kind: input.kind as CatalogModel['kind'] | undefined,
        limit,
        offset,
      });
      return {
        models: hits.map((hit) =>
          catalogModelMessage(hit.providerId, hit.model),
        ),
        total,
        nextCursor: offset + limit < total ? String(offset + limit) : undefined,
      };
    },
    getCatalogStatus: async () => ({
      status: statusMessage(await getCatalogStatus()),
    }),
    refreshCatalog: async () => {
      const { outcome, status } = await refreshModelCatalog();
      return { outcome, status: statusMessage(status) };
    },
    updateCatalogSettings: async (input) => {
      exclusive(
        input.sourceUrl !== undefined,
        input.clearSourceUrl,
        'source_url and clear_source_url',
      );
      return {
        status: statusMessage(
          await updateCatalogSettings({
            autoUpdate: input.autoUpdate,
            sourceUrl: input.clearSourceUrl ? null : input.sourceUrl,
          }),
        ),
      };
    },
  });
}
