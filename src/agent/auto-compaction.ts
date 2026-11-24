/**
 * Automatic context compaction for Agent runs, all Runner-side.
 *
 * The transcript stays the canonical, complete history. A compaction adds a
 * marker where it happened (see `./transcript`); only the model-bound context
 * is derived from the newest marker, so the chat history and the user-turn
 * bindings of earlier runs are unaffected, and repeated compactions update
 * the previous summary instead of re-reading the whole history.
 *
 * Three triggers share one mechanism:
 *
 * - before the turn, when the stored history is over the threshold;
 * - before any provider request in the turn (the loop's `transformContext`),
 *   when tool output grew the context past the threshold;
 * - after a provider rejected a request for context length: that one request
 *   is compacted and re-sent in place, so completed tool work is kept.
 */
import type {
  AgentMessage,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  prepareCompaction,
  type CompactionPreparation,
  type CompactionSettings,
} from './compaction';
import { convertToLlm } from './llm-messages';
import {
  lastCompactionIndex,
  type Transcript,
  type TranscriptEntry,
} from './transcript';

/** Fraction of the model's input budget that triggers auto compaction. */
export const AUTO_COMPACT_RATIO = 0.8;

export type AutoCompactReason = 'threshold' | 'overflow';

export type AutoCompactPhase = 'start' | 'done' | 'failed';

type ModelBudget = { contextWindow: number; maxTokens: number };

/**
 * Estimated input-token budget the Agent may fill before compaction triggers:
 * 80% of `contextWindow - maxTokens`, so the configured output budget stays
 * available. A `maxTokens >= contextWindow` config is a modeling error; fall
 * back to the full window rather than a non-positive budget that would compact
 * forever without helping.
 */
export function compactionTriggerTokens(model: ModelBudget): number {
  const inputBudget = model.contextWindow - model.maxTokens;
  const basis = inputBudget > 0 ? inputBudget : model.contextWindow;
  return basis * AUTO_COMPACT_RATIO;
}

/**
 * Compaction sizes for a model. The pi defaults assume a large window; a
 * small model would otherwise keep a tail (or request a summary) larger than
 * its whole budget, and compaction could never bring it under the trigger.
 */
export function compactionSettings(model: ModelBudget): CompactionSettings {
  // At least one token each: a zero tail budget could never be widened.
  const share = Math.max(1, Math.floor(compactionTriggerTokens(model) / 4));
  return {
    reserveTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, share),
    keepRecentTokens: Math.min(
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
      share,
    ),
  };
}

/**
 * Estimated tokens of the context the next request would send.
 *
 * pi estimates from the newest assistant `usage` plus the messages after it.
 * That is only valid while the usage describes the current context: right
 * after a compaction the newest usage sits in the kept tail and still counts
 * the history that was just summarized away. Until a reply arrives on the
 * compacted context, fall back to the per-message heuristic plus
 * `overheadTokens`: the part of every request that is not a message (system
 * prompt, tool schemas), which provider usage includes and the heuristic
 * cannot see.
 */
export function estimateTranscriptContextTokens(
  transcript: Transcript,
  overheadTokens = 0,
): number {
  const branch = transcript.branch();
  const messages = transcript.modelContext();
  const lastCompaction = lastCompactionIndex(branch);
  if (getLastAssistantUsage(branch.slice(lastCompaction + 1))) {
    return estimateContextTokens(messages);
  }
  return messages.reduce(
    (total, message) => total + estimateTokens(message),
    overheadTokens,
  );
}

/**
 * Pick what to summarize. pi keeps roughly `keepRecentTokens` of tail and can
 * only cut in front of a user or assistant message, so one tool result larger
 * than the tail budget leaves it with no cut at all. Widening the tail until a
 * cut appears still summarizes the history in front of that result.
 *
 * pi summarizes a split turn's prefix on its own and only consults the
 * previous summary when older history precedes the turn. When the previous
 * compaction kept exactly from this turn's user message, there is none, and
 * the earlier summary would be replaced by "No prior history." The prefix is
 * then summarized as ordinary history, which updates the previous summary.
 */
function prepareSummarizableCompaction(
  branch: readonly TranscriptEntry[],
  settings: CompactionSettings,
  maxKeepRecentTokens: number,
): CompactionPreparation | undefined {
  for (
    let keepRecentTokens = settings.keepRecentTokens;
    ;
    keepRecentTokens *= 2
  ) {
    const value = prepareCompaction(branch, {
      ...settings,
      keepRecentTokens,
    });
    if (!value) return undefined;
    if (value.messagesToSummarize.length > 0) return value;
    if (value.isSplitTurn) {
      return value.previousSummary === undefined
        ? value
        : {
            ...value,
            isSplitTurn: false,
            messagesToSummarize: value.turnPrefixMessages,
            turnPrefixMessages: [],
          };
    }
    if (keepRecentTokens >= maxKeepRecentTokens) return undefined;
  }
}

export type TranscriptCompactor = {
  /** Compact when the estimated context is over the threshold. */
  compactIfOverThreshold(): Promise<boolean>;
  /** Compact regardless of the estimate: the provider rejected the context. */
  compactAfterOverflow(): Promise<boolean>;
};

/**
 * Compacts the transcript's current branch: summarizes the older history into
 * a compaction marker and keeps the recent tail. Both methods resolve to whether
 * a compaction entry was added. `onEvent` gets `start` only once a summary is
 * actually being generated, and every `start` is followed by `done` or
 * `failed`.
 */
export function createTranscriptCompactor(opts: {
  transcript: Transcript;
  models: Models;
  model: Model<Api>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  /** Estimated tokens of the system prompt and tool schemas. */
  overheadTokens?: number;
  onEvent?: (
    reason: AutoCompactReason,
    phase: AutoCompactPhase,
    tokensBefore: number,
    tokensAfter?: number,
  ) => void;
}): TranscriptCompactor {
  const { transcript, models, model, signal, thinkingLevel, onEvent } = opts;
  const trigger = compactionTriggerTokens(model);
  const settings = compactionSettings(model);
  const estimate = () =>
    estimateTranscriptContextTokens(transcript, opts.overheadTokens);

  const run = async (reason: AutoCompactReason): Promise<boolean> => {
    if (signal?.aborted) return false;
    const tokensBefore = estimate();
    if (reason === 'threshold' && tokensBefore <= trigger) return false;
    const preparation = prepareSummarizableCompaction(
      transcript.branch(),
      settings,
      trigger,
    );
    if (!preparation) return false;

    onEvent?.(reason, 'start', tokensBefore);
    try {
      const result = await compact(preparation, {
        models,
        model,
        signal,
        thinkingLevel,
      });
      if (!result) {
        onEvent?.(reason, 'failed', tokensBefore);
        return false;
      }
      transcript.appendCompaction({
        summary: result.summary,
        firstKept: result.firstKept,
        tokensBefore,
        details: result.details,
      });
    } catch {
      onEvent?.(reason, 'failed', tokensBefore);
      return false;
    }
    onEvent?.(reason, 'done', tokensBefore, estimate());
    return true;
  };

  return {
    compactIfOverThreshold: () => run('threshold'),
    compactAfterOverflow: () => run('overflow'),
  };
}

/** Whether a stream event carries reply content the consumer would render. */
function hasReplyContent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return Boolean(event.delta);
    case 'text_end':
    case 'thinking_end':
      return Boolean(event.content);
    case 'toolcall_end':
      return true;
    default:
      return false;
  }
}

/**
 * Wrap `models` so a request the provider rejects for context length is
 * compacted and re-sent once, inside the same request. The agent loop never
 * sees the rejection, so the turn continues with its completed tool calls
 * instead of being replayed.
 *
 * Only a response that ends before any content is treated as a rejection:
 * an error, or a `length` stop with no output (providers that truncate the
 * input instead of failing). `recover` returns the compacted context, or
 * undefined when nothing could be compacted; the original response is then
 * passed through unchanged.
 *
 * Every request also observes `signal`, the run's own cancellation, so a stop
 * that lands while a compaction is in flight still reaches the provider call
 * that follows.
 */
export function withOverflowRecovery(
  models: Models,
  opts: {
    contextWindow: number;
    signal: AbortSignal;
    recover: () => Promise<AgentMessage[] | undefined>;
  },
): Models {
  const streamSimple: Models['streamSimple'] = (model, context, request) => {
    const options = {
      ...request,
      signal: request?.signal
        ? AbortSignal.any([request.signal, opts.signal])
        : opts.signal,
    };
    const output = createAssistantMessageEventStream();
    void (async () => {
      let source = models.streamSimple(model, context, options);
      let recovered = false;
      for (let resend = true; resend;) {
        resend = false;
        const held: AssistantMessageEvent[] = [];
        let passThrough = false;
        for await (const event of source) {
          if (passThrough) {
            output.push(event);
            continue;
          }
          const ended = event.type === 'error' || event.type === 'done';
          if (!ended && !hasReplyContent(event)) {
            held.push(event);
            continue;
          }
          const terminal: AssistantMessage | undefined =
            event.type === 'error'
              ? event.error
              : event.type === 'done'
                ? event.message
                : undefined;
          if (
            !recovered &&
            terminal &&
            isContextOverflow(terminal, opts.contextWindow)
          ) {
            recovered = true;
            const messages = await opts.recover();
            if (messages) {
              source = models.streamSimple(
                model,
                { ...context, messages: convertToLlm(messages) },
                options,
              );
              resend = true;
              break;
            }
          }
          for (const heldEvent of held) output.push(heldEvent);
          output.push(event);
          passThrough = true;
        }
      }
      output.end();
    })();
    return output;
  };

  return new Proxy(models, {
    get(target, property) {
      if (property === 'streamSimple') return streamSimple;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
