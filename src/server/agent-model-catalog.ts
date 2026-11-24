/**
 * Server-only: the chat models a user can run the Agent with, and the one
 * they start with. Every client (Web, mobile, CLI) reads the same list and
 * the same default.
 */
import { db } from '~/db';
import type { AgentModelPreference, AgentThinkingLevel } from '~/db/schema';
import { AppError } from '~server/errors';
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
  /** The user's saved default while usable, else the first model. */
  defaultModel: AgentModelSelection | null;
  /** Whether the user has saved a default (usable or not). */
  savedDefault: boolean;
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

function findModel(
  providers: AgentCatalogProvider[],
  providerId: string,
  modelId: string,
): AgentCatalogModel | undefined {
  return providers
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => model.modelId === modelId);
}

/**
 * A saved choice resolved against what is configured now: null when the
 * model is gone; a level the model no longer offers becomes its default.
 */
export function resolveSelection(
  providers: AgentCatalogProvider[],
  choice: AgentModelPreference | null | undefined,
): AgentModelSelection | null {
  if (!choice) return null;
  const model = findModel(providers, choice.providerId, choice.modelId);
  if (!model) return null;
  const level =
    choice.thinkingLevel && model.thinkingLevels.includes(choice.thinkingLevel)
      ? choice.thinkingLevel
      : model.defaultThinkingLevel;
  return {
    providerId: choice.providerId,
    modelId: choice.modelId,
    thinkingLevel: level,
  };
}

/** Reject a default the user could not run with. */
export async function assertSelectableModel(
  choice: AgentModelPreference,
): Promise<void> {
  const model = findModel(
    await listAgentModels(),
    choice.providerId,
    choice.modelId,
  );
  if (!model)
    throw new AppError(
      'That model is not available. Pick an enabled chat model.',
      400,
      { code: 'agent.defaultModelUnavailable' },
    );
  if (
    choice.thinkingLevel &&
    !(model.thinkingLevels.length
      ? model.thinkingLevels.includes(choice.thinkingLevel)
      : choice.thinkingLevel === 'off')
  )
    throw new AppError(
      `The model does not support thinking level "${choice.thinkingLevel}".`,
      400,
      {
        code: 'agent.thinkingLevelUnsupported',
        params: { level: choice.thinkingLevel },
      },
    );
}

export async function getAgentModelCatalog(
  userId?: string | null,
): Promise<AgentModelCatalog> {
  const providers = await listAgentModels();
  const preference = userId
    ? (
        await db.query.userPreferences.findFirst({
          where: { userId },
          columns: { agentModel: true },
        })
      )?.agentModel
    : null;
  const first = providers[0]?.models[0];
  return {
    providers,
    savedDefault: Boolean(preference),
    defaultModel:
      resolveSelection(providers, preference) ??
      (first
        ? {
            providerId: providers[0].id,
            modelId: first.modelId,
            thinkingLevel: first.defaultThinkingLevel,
          }
        : null),
  };
}
