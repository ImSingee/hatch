/**
 * Server-only: resolve a configured chat model into the self-contained config
 * a model call needs, including the provider API key scoped to that provider.
 * Agent Runs send it to the Runner; App AI calls use it in the platform
 * process. Callers never get a list of provider secrets.
 */
import { db } from '~/db';
import type { AgentThinkingLevel } from '~/db/schema';
import type { RunModelConfig } from '~agent/protocol';
import { AppError } from '~server/errors';
import { effectiveThinkingLevel, resolveModelSpec } from '~server/model-spec';

type ProviderRow = NonNullable<
  Awaited<ReturnType<typeof db.query.agentProviders.findFirst>>
>;
type ModelRow = NonNullable<
  Awaited<ReturnType<typeof db.query.agentModels.findFirst>>
>;

/** Build the call config from an enabled provider and one of its chat models. */
export function chatModelConfig(
  provider: ProviderRow,
  model: ModelRow,
  thinkingLevel: AgentThinkingLevel | null | undefined,
): RunModelConfig {
  const spec = resolveModelSpec(model, provider.apiType);
  return {
    providerId: provider.id,
    providerName: provider.name,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    thinkingLevel: effectiveThinkingLevel(spec, thinkingLevel),
    model: {
      id: model.modelId,
      name: model.name,
      reasoning: spec.reasoning,
      // Keep the wire field for existing Runners; it is not configurable.
      input: ['text', 'image'],
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
      thinkingLevelMap: spec.thinkingLevelMap,
      compat: spec.compat,
      cost: spec.cost,
    },
  };
}

/**
 * Resolve an enabled provider/model pair. `thinkingLevel` the model no longer
 * offers falls back to the model default.
 */
export async function resolveChatModelConfig(
  providerId: string,
  modelId: string,
  thinkingLevel: AgentThinkingLevel | null | undefined,
): Promise<RunModelConfig> {
  const provider = await db.query.agentProviders.findFirst({
    where: { id: providerId, enabled: true },
  });
  if (!provider) {
    throw new AppError('The selected Agent model is unavailable.', 409, {
      code: 'agent.modelUnavailable',
    });
  }

  const model = await db.query.agentModels.findFirst({
    where: { providerId, modelId, kind: 'chat', enabled: true },
  });
  if (!model) {
    throw new AppError('The selected Agent model is unavailable.', 409, {
      code: 'agent.modelUnavailable',
    });
  }
  return chatModelConfig(provider, model, thinkingLevel);
}
