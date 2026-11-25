import { useLocalStorage } from '@mantine/hooks';
import { useCallback } from 'react';
import type { AgentThinkingLevel } from '~/db/schema';

export const LAST_SELECTED_MODEL_STORAGE_KEY =
  'hatch.agent.last-selected-model';

/** A picked model; a `null` level means the model's default one. */
export type RememberedModel = {
  value: string;
  thinkingLevel: AgentThinkingLevel | null;
};

const THINKING_LEVELS: ReadonlySet<string> = new Set<AgentThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Reads `{ value, thinkingLevel }`, and the bare model value older versions
 * stored, which then uses the model's default thinking level.
 */
function deserializeChoice(
  raw: string | undefined,
): RememberedModel | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string')
      return parsed ? { value: parsed, thinkingLevel: null } : undefined;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { value, thinkingLevel } = parsed as Record<string, unknown>;
    if (typeof value !== 'string' || !value) return undefined;
    return {
      value,
      thinkingLevel:
        typeof thinkingLevel === 'string' && THINKING_LEVELS.has(thinkingLevel)
          ? (thinkingLevel as AgentThinkingLevel)
          : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * Remembers an explicit picker choice in this browser across chats. Reading
 * the value does not write a fallback, so merely using a model never changes
 * the remembered selection.
 */
export function useLastSelectedModel() {
  const [stored, setStored] = useLocalStorage<RememberedModel | undefined>({
    key: LAST_SELECTED_MODEL_STORAGE_KEY,
    deserialize: deserializeChoice,
  });
  const remember = useCallback(
    (choice: RememberedModel) => setStored(choice),
    [setStored],
  );
  return [stored ?? null, remember] as const;
}
