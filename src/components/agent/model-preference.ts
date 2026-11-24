import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { agentModelChoicesQueryOptions } from '~queries/agent';
import { updateAgentPreferenceSettings } from '~server/agent-preference-settings';
import type { ModelOption } from './model-picker';
import { splitModelValue, type ModelChoice } from './model-value';

/** Where the Web UI kept the last picked model before it was saved server-side. */
export const LAST_SELECTED_MODEL_STORAGE_KEY =
  'hatch.agent.last-selected-model';

function readLegacyChoice(): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function forgetLegacyChoice() {
  try {
    window.localStorage.removeItem(LAST_SELECTED_MODEL_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; nothing to clean up then.
  }
}

/**
 * Remember an explicit picker choice as the user's default model, shared by
 * every device and client. Merely using a model never changes it.
 */
export function useRememberModel() {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (choice: ModelChoice) => {
      const parsed = splitModelValue(choice.value);
      if (!parsed) throw new Error('Unknown model.');
      return updateAgentPreferenceSettings({
        data: {
          defaultModel: { ...parsed, thinkingLevel: choice.thinkingLevel },
        },
      });
    },
    // Remembering is a convenience: a failure must not interrupt the chat.
    meta: { errorToast: false },
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: agentModelChoicesQueryOptions.queryKey,
      }),
  });
  const { mutate } = save;
  return useCallback((choice: ModelChoice) => mutate(choice), [mutate]);
}

/**
 * Move a model remembered by an older Web UI (browser storage) to the
 * server once, unless a default is already saved there.
 */
export function useImportLegacyModelChoice(
  options: ReadonlyMap<string, ModelOption>,
  savedDefault: boolean,
) {
  const remember = useRememberModel();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const legacy = readLegacyChoice();
    if (legacy === null) return;
    forgetLegacyChoice();
    const option = options.get(legacy);
    if (savedDefault || !option) return;
    remember({
      value: option.value,
      thinkingLevel: option.defaultThinkingLevel,
    });
  }, [options, remember, savedDefault]);
}
