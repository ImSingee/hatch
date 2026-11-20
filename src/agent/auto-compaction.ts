/**
 * Automatic context compaction for Agent runs. Three cooperating mechanisms,
 * all Runner-side:
 *
 * - A threshold trigger: estimated context usage above 80% of the model's
 *   *input* budget (`contextWindow - maxTokens`) compacts the session.
 * - A mid-turn transform for the harness `context` hook, so tool output that
 *   outgrows the estimate mid-run is summarized before the next request.
 * - The payload pin helpers, which keep `max_tokens` at the configured value
 *   (pi-ai otherwise shrinks it as the context fills).
 *
 * Persisted compaction goes through the pi session tree (`prepareCompaction` +
 * `compact` + `appendCompaction`) so `session.buildContext()` — and therefore
 * the transcript reported back to the platform — already carries the summary.
 */
import {
  compact,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  generateSummary,
  prepareCompaction,
  type AgentMessage,
  type Session,
  type SessionTreeEntry,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';

/** Fraction of the model's input budget that triggers auto compaction. */
export const AUTO_COMPACT_RATIO = 0.8;

export type AutoCompactReason = 'threshold' | 'overflow';

export type AutoCompactPhase = 'start' | 'done' | 'failed';

/**
 * Estimated input-token budget the Agent may fill before compaction triggers:
 * 80% of `contextWindow - maxTokens`. The output budget is pinned and reserved,
 * so only the input share is elastic. A `maxTokens >= contextWindow` config is
 * a modeling error; fall back to the full window rather than a non-positive
 * budget that would compact forever without helping.
 */
export function compactionTriggerTokens(model: {
  contextWindow: number;
  maxTokens: number;
}): number {
  const inputBudget = model.contextWindow - model.maxTokens;
  const basis = inputBudget > 0 ? inputBudget : model.contextWindow;
  return basis * AUTO_COMPACT_RATIO;
}

/** Whether the estimated context usage crosses the auto-compact threshold. */
export function isOverCompactThreshold(
  messages: AgentMessage[],
  model: { contextWindow: number; maxTokens: number },
): boolean {
  return (
    estimateContextTokens(messages).tokens > compactionTriggerTokens(model)
  );
}

export type SessionCompactionOutcome =
  | { status: 'compacted'; tokensBefore: number; tokensAfter: number }
  | { status: 'nothing' }
  | { status: 'failed' };

/**
 * Compact the session's current branch: summarize older history into a
 * compaction entry while keeping the recent tail. Equivalent to
 * `AgentHarness.compact()` but abortable via `signal` and usable while the
 * harness is busy.
 */
export async function compactSessionMessages(opts: {
  session: Session;
  models: Models;
  model: Model<Api>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
}): Promise<SessionCompactionOutcome> {
  const preparation = prepareCompaction(
    await opts.session.getBranch(),
    DEFAULT_COMPACTION_SETTINGS,
  );
  if (!preparation.ok) return { status: 'failed' };
  if (!preparation.value) return { status: 'nothing' };
  // The retained tail already holds everything summarizable (e.g. one recent
  // tool result pushed usage over the threshold) — a summary of an empty head
  // would only add a degenerate compaction entry.
  if (
    !preparation.value.isSplitTurn &&
    preparation.value.messagesToSummarize.length === 0
  ) {
    return { status: 'nothing' };
  }
  const result = await compact(
    preparation.value,
    opts.models,
    opts.model,
    undefined,
    opts.signal,
    opts.thinkingLevel,
  );
  if (!result.ok) return { status: 'failed' };
  const {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details,
    usage,
    retainedTail,
  } = result.value;
  await opts.session.appendCompaction(
    summary,
    firstKeptEntryId,
    tokensBefore,
    details,
    false,
    usage,
    retainedTail,
  );
  const tokensAfter = estimateContextTokens(
    (await opts.session.buildContext()).messages,
  ).tokens;
  return { status: 'compacted', tokensBefore, tokensAfter };
}

/**
 * Transcript prefix up to (but excluding) the last user message, or undefined
 * when there is none. The overflow retry drops the failed turn's partial work
 * — everything from the last user message on — and re-prompts the same input.
 */
export function transcriptBeforeLastUserMessage(
  messages: AgentMessage[],
): AgentMessage[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return messages.slice(0, index);
  }
  return undefined;
}

type MidTurnCompactionState = {
  /** Index in the live message list where the retained tail starts. */
  cutIndex: number;
  /** Text of the generated summary (reused while the head is unchanged). */
  summaryText: string;
  /** The compactionSummary message injected at the head of the context. */
  message: AgentMessage;
};

function messageEntries(messages: AgentMessage[]): SessionTreeEntry[] {
  return messages.map((message, index) => ({
    type: 'message',
    id: `m${index}`,
    parentId: index > 0 ? `m${index - 1}` : null,
    timestamp: '',
    message,
  }));
}

/**
 * Sticky mid-turn compactor for the harness `context` hook. When the estimated
 * context crosses the threshold, the head of the outgoing context is replaced
 * by a generated summary; the transform then keeps applying while the turn
 * grows, re-summarizing only when the retained tail itself overflows.
 *
 * This only rewrites the provider-bound context — the session transcript keeps
 * full fidelity. Persisted compaction (run start / overflow retry) covers the
 * stored side.
 */
export function createMidTurnCompactor(opts: {
  models: Models;
  model: Model<Api>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  onEvent?: (phase: AutoCompactPhase, tokensBefore?: number) => void;
}): (messages: AgentMessage[]) => Promise<AgentMessage[] | undefined> {
  const trigger = compactionTriggerTokens(opts.model);
  const { reserveTokens, keepRecentTokens } = DEFAULT_COMPACTION_SETTINGS;
  let state: MidTurnCompactionState | null = null;

  return async (messages) => {
    // Sticky: once compacted, keep substituting the summary while the tail
    // stays under the trigger. Real `usage` on new assistant messages reflects
    // the compacted request, so re-estimating the raw list would oscillate
    // between compacted and uncompacted payloads.
    if (state) {
      const candidate = [state.message, ...messages.slice(state.cutIndex)];
      if (estimateContextTokens(candidate).tokens <= trigger) {
        return candidate;
      }
    } else if (estimateContextTokens(messages).tokens <= trigger) {
      return undefined;
    }

    // (Re)compact: pick a cut that keeps roughly keepRecentTokens of tail and
    // never splits a tool call from its result.
    const cut = findCutPoint(
      messageEntries(messages),
      0,
      messages.length,
      keepRecentTokens,
    );
    const cutIndex = cut.firstKeptEntryIndex;
    // Nothing summarizable, or the boundary cannot advance past the previous
    // summary — compaction cannot shrink this context further. Leave it and
    // let the provider-side overflow path handle the rejection.
    if (cutIndex <= (state?.cutIndex ?? 0)) return undefined;
    const tail = messages.slice(cutIndex);
    // Even a perfect summary cannot help when the retained tail alone already
    // exceeds the budget (e.g. one giant tool result). Measure the tail with
    // the per-message heuristic: estimateContextTokens would reuse the tail's
    // last assistant usage, which still describes the *uncompacted* request.
    if (
      tail.reduce((total, message) => total + estimateTokens(message), 0) >
      trigger
    ) {
      return undefined;
    }

    const tokensBefore = estimateContextTokens(messages).tokens;
    opts.onEvent?.('start', tokensBefore);
    const summaryResult = await generateSummary(
      messages.slice(0, cutIndex),
      opts.models,
      opts.model,
      reserveTokens,
      opts.signal,
      undefined,
      state?.summaryText,
      opts.thinkingLevel,
    );
    if (!summaryResult.ok) {
      opts.onEvent?.('failed', tokensBefore);
      return undefined;
    }
    const message = createCompactionSummaryMessage(
      summaryResult.value,
      tokensBefore,
      new Date().toISOString(),
    );
    state = { cutIndex, summaryText: summaryResult.value, message };
    opts.onEvent?.('done', tokensBefore);
    return [message, ...tail];
  };
}

/**
 * Pin the serialized request's max-output field to the configured value. pi-ai
 * clamps `max_tokens` to the remaining context budget (`clampMaxTokensToContext`),
 * which silently shrinks output as the context fills; the auto-compaction
 * threshold instead reserves `maxTokens` up front so output never degrades.
 *
 * Covers all three provider APIs: Anthropic `max_tokens`, OpenAI completions
 * `max_tokens`/`max_completion_tokens` (compat-selected), Responses
 * `max_output_tokens`.
 */
export function pinMaxOutputTokens(
  payload: unknown,
  maxTokens: number,
): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.max_tokens === 'number') {
    return { ...record, max_tokens: maxTokens };
  }
  if (typeof record.max_completion_tokens === 'number') {
    return { ...record, max_completion_tokens: maxTokens };
  }
  if (typeof record.max_output_tokens === 'number') {
    return { ...record, max_output_tokens: maxTokens };
  }
  return payload;
}
