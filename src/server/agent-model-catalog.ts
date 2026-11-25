/**
 * Server-only: the chat models the Agent can run with, and the first one,
 * which clients start new chats with until the user picks another.
 */
import { db } from '~/db';
import type { AgentThinkingLevel } from '~/db/schema';
import { resolveModelSpec } from '~server/model-spec';

export type AgentCatalogModel = {
  /** Model row id. */
  id: string;
  /** Model id sent to the provider; what runs and sessions name. */
  modelId: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Levels the picker offers; empty when the model does not reason. */
  thinkingLevels: AgentThinkingLevel[];
  defaultThinkingLevel: AgentThinkingLevel;
};

export type AgentCatalogProvider = {
  id: string;
  name: string;
  /** Built-in catalog provider it is linked to, for its icon. */
  catalogProviderId: string | null;
  models: AgentCatalogModel[];
};

export type AgentModelSelection = {
  providerId: string;
  modelId: string;
  thinkingLevel: AgentThinkingLevel;
};

export type AgentModelCatalog = {
  providers: AgentCatalogProvider[];
  /** The first model, at its default level; clients start new chats with it. */
  defaultModel: AgentModelSelection | null;
};

/** Enabled chat models of enabled providers, in display order. */
export async function listAgentModels(): Promise<AgentCatalogProvider[]> {
  const providers = await db.query.agentProviders.findMany({
    where: { enabled: true },
    columns: { id: true, name: true, apiType: true, catalogProviderId: true },
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  const models = providers.length
    ? await db.query.agentModels.findMany({
        where: {
          enabled: true,
          kind: 'chat',
          providerId: { in: providers.map((provider) => provider.id) },
        },
        orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      })
    : [];
  return providers
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      catalogProviderId: provider.catalogProviderId,
      models: models
        .filter((model) => model.providerId === provider.id)
        .map((model) => {
          const spec = resolveModelSpec(model, provider.apiType);
          return {
            id: model.id,
            modelId: model.modelId,
            name: model.name,
            reasoning: spec.reasoning,
            contextWindow: spec.contextWindow,
            maxTokens: spec.maxTokens,
            thinkingLevels: spec.thinkingLevels,
            defaultThinkingLevel: spec.defaultThinkingLevel,
          };
        }),
    }))
    .filter((provider) => provider.models.length > 0);
}

export async function getAgentModelCatalog(): Promise<AgentModelCatalog> {
  const providers = await listAgentModels();
  const first = providers[0]?.models[0];
  return {
    providers,
    defaultModel: first
      ? {
          providerId: providers[0].id,
          modelId: first.modelId,
          thinkingLevel: first.defaultThinkingLevel,
        }
      : null,
  };
}
