import { useSuspenseQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { agentModelChoicesQueryOptions } from '~queries/agent';
import type { ModelGroup, ModelOption } from './model-picker';

/** The chat models the user can pick, grouped by provider, and the default. */
export function useModelOptions() {
  const { data } = useSuspenseQuery(agentModelChoicesQueryOptions);
  return useMemo(() => {
    const groups: ModelGroup[] = data.providers.map((provider) => ({
      id: provider.id,
      group: provider.name,
      catalogProviderId: provider.catalogProviderId,
      items: provider.models.map((model) => ({
        value: `${provider.id}:${model.modelId}`,
        label: model.name,
        thinkingLevels: model.thinkingLevels,
        defaultThinkingLevel: model.defaultThinkingLevel,
      })),
    }));
    const options = new Map<string, ModelOption>(
      groups.flatMap((group) => group.items.map((item) => [item.value, item])),
    );
    const fallback = data.defaultModel
      ? {
          value: `${data.defaultModel.providerId}:${data.defaultModel.modelId}`,
          thinkingLevel: data.defaultModel.thinkingLevel,
        }
      : null;
    return { groups, options, fallback, savedDefault: data.savedDefault };
  }, [data]);
}
