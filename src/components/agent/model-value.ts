import type { AgentThinkingLevel } from '~/db/schema';
import type { ModelOption } from './model-picker';

/** What the composer runs with: a model and its thinking level. */
export type ModelChoice = { value: string; thinkingLevel: AgentThinkingLevel };

/**
 * The model and level a send uses: the composer's pick, else the chat's last
 * model and level, else the user's default — each only while the model is
 * still available. A level the model no longer offers becomes its default.
 */
export function resolveEffectiveModel(
  options: ReadonlyMap<string, ModelOption>,
  ...candidates: Array<
    | { value: string | null; thinkingLevel?: AgentThinkingLevel | null }
    | null
    | undefined
  >
): ModelChoice | null {
  for (const candidate of candidates) {
    const option = candidate?.value ? options.get(candidate.value) : undefined;
    if (!option) continue;
    const level = candidate?.thinkingLevel;
    return {
      value: option.value,
      thinkingLevel: !option.thinkingLevels.length
        ? 'off'
        : level && option.thinkingLevels.includes(level)
          ? level
          : option.defaultThinkingLevel,
    };
  }
  return null;
}

/**
 * Decode a model picker value (`<providerId>:<modelId>`). Provider ids are
 * ULIDs (never contain a colon), but model ids legitimately do — e.g.
 * Bedrock-style ids ending in `:0` — so split only on the first separator and
 * keep the remainder intact instead of `split(':')` which would truncate them.
 */
export function splitModelValue(
  value: string,
): { providerId: string; modelId: string } | null {
  const sep = value.indexOf(':');
  if (sep <= 0) return null;
  const providerId = value.slice(0, sep);
  const modelId = value.slice(sep + 1);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}
