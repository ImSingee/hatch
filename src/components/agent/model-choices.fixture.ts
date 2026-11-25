import type { AgentThinkingLevel } from '~/db/schema';
import type { AgentModelCatalog } from '~server/agent-model-catalog';

type FixtureProvider = {
  id: string;
  name: string;
  enabled?: boolean;
  catalogProviderId?: string | null;
  models: Array<{
    kind?: string;
    modelId: string;
    name: string;
    enabled?: boolean;
    thinkingLevels?: AgentThinkingLevel[];
    defaultThinkingLevel?: AgentThinkingLevel;
  }>;
};

/** Browser-test model choices built from provider fixtures. */
export function choicesFrom(
  providers: readonly FixtureProvider[],
): AgentModelCatalog {
  const enabled = providers
    .filter((provider) => provider.enabled !== false)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      catalogProviderId: provider.catalogProviderId ?? null,
      models: provider.models
        .filter((model) => model.enabled !== false && model.kind !== 'image')
        .map((model, index) => ({
          id: `${provider.id}-${index}`,
          modelId: model.modelId,
          name: model.name,
          reasoning: Boolean(model.thinkingLevels?.length),
          contextWindow: 128000,
          maxTokens: 8192,
          thinkingLevels: model.thinkingLevels ?? [],
          defaultThinkingLevel: model.defaultThinkingLevel ?? 'off',
        })),
    }))
    .filter((provider) => provider.models.length > 0);
  const first = enabled[0];
  return {
    providers: enabled,
    defaultModel: first
      ? {
          providerId: first.id,
          modelId: first.models[0].modelId,
          thinkingLevel: first.models[0].defaultThinkingLevel,
        }
      : null,
  };
}
