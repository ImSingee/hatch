/**
 * Automatic context compaction for Agent runs, all Runner-side.
 *
 * The session transcript stays the canonical, complete history. A compaction
 * adds a marker at the point where it happened: a `compactionSummary` item
 * holding the summary and the index of the first message that stays in the
 * model's context. Nothing is removed, so the chat history and the user-turn
 * bindings of earlier runs are unaffected; only the model-bound context is
 * derived from the newest marker (summary + kept tail + everything after).
 *
 * In the pi session the marker is a native compaction entry, so
 * `session.buildContext()` yields the compacted view and repeated compactions
 * update the previous summary instead of re-reading the whole history.
 *
 * Three triggers share one mechanism:
 *
 * - before the turn, when the stored history is over the threshold;
 * - before any provider request in the turn (harness `context` hook), when
 *   tool output grew the context past the threshold;
 * - after a provider rejected a request for context length: that one request
 *   is compacted and re-sent in place, so completed tool work is kept.
 */
import {
  compact,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  prepareCompaction,
  type AgentMessage,
  type CompactionPreparation,
  type CompactionSettings,
  type Session,
  type SessionTreeEntry,
  type ThinkingLevel,
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
import type { JsonValue } from '~/db/schema';

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
  const share = Math.floor(compactionTriggerTokens(model) / 4);
  return {
    enabled: true,
    reserveTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, share),
    keepRecentTokens: Math.min(
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
      share,
    ),
  };
}

const COMPACTION_MARKER_ROLE = 'compactionSummary';

type ParsedMarker = {
  summary: string;
  tokensBefore: number;
  timestamp: number;
  firstKeptIndex: number;
  details?: JsonValue;
};

function hasMarkerRole(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { role?: unknown }).role === COMPACTION_MARKER_ROLE
  );
}

function parseMarker(value: unknown): ParsedMarker | null {
  const record = value as Record<string, unknown>;
  const { summary, tokensBefore, timestamp, firstKeptIndex, details } = record;
  if (
    typeof summary !== 'string' ||
    typeof tokensBefore !== 'number' ||
    typeof timestamp !== 'number' ||
    typeof firstKeptIndex !== 'number' ||
    !Number.isSafeInteger(firstKeptIndex) ||
    firstKeptIndex < 0
  ) {
    return null;
  }
  return {
    summary,
    tokensBefore,
    timestamp,
    firstKeptIndex,
    ...(details === undefined ? {} : { details: details as JsonValue }),
  };
}

export type TranscriptSession = {
  /** The complete transcript: every message plus the compaction markers. */
  serialize(): Promise<JsonValue[]>;
};

/**
 * Load a stored transcript into a fresh pi session. Messages become message
 * entries; each compaction marker becomes a compaction entry pointing at the
 * message it kept from. A marker that does not point at an earlier message is
 * dropped: without a valid cut it cannot describe any context.
 */
export async function openTranscriptSession(
  session: Session,
  transcript: readonly unknown[],
): Promise<TranscriptSession> {
  const messageEntryIds: (string | undefined)[] = [];
  const markerTimestamps = new Map<string, number>();
  for (const [index, item] of transcript.entries()) {
    if (!hasMarkerRole(item)) {
      messageEntryIds[index] = await session.appendMessage(
        item as AgentMessage,
      );
      continue;
    }
    const marker = parseMarker(item);
    const firstKeptEntryId =
      marker && marker.firstKeptIndex < index
        ? messageEntryIds[marker.firstKeptIndex]
        : undefined;
    if (!marker || firstKeptEntryId === undefined) continue;
    const entryId = await session.appendCompaction(
      marker.summary,
      firstKeptEntryId,
      marker.tokensBefore,
      marker.details,
    );
    markerTimestamps.set(entryId, marker.timestamp);
  }

  return {
    async serialize() {
      const items: JsonValue[] = [];
      const messageIndexByEntryId = new Map<string, number>();
      for (const entry of await session.getEntries()) {
        if (entry.type === 'message') {
          messageIndexByEntryId.set(entry.id, items.length);
          items.push(entry.message as unknown as JsonValue);
        } else if (entry.type === 'compaction') {
          const firstKeptIndex =
            entry.firstKeptEntryId === undefined
              ? undefined
              : messageIndexByEntryId.get(entry.firstKeptEntryId);
          if (firstKeptIndex === undefined) continue;
          items.push({
            role: COMPACTION_MARKER_ROLE,
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
            // A marker loaded from the transcript keeps its original time.
            timestamp:
              markerTimestamps.get(entry.id) ?? Date.parse(entry.timestamp),
            firstKeptIndex,
            ...(entry.details === undefined
              ? {}
              : { details: entry.details as JsonValue }),
          });
        }
      }
      return items;
    },
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
export async function estimateSessionContextTokens(
  session: Session,
  overheadTokens = 0,
): Promise<number> {
  const branch = await session.getBranch();
  const messages = (await session.buildContext()).messages;
  let lastCompaction = branch.length - 1;
  while (lastCompaction >= 0 && branch[lastCompaction].type !== 'compaction') {
    lastCompaction -= 1;
  }
  if (getLastAssistantUsage(branch.slice(lastCompaction + 1))) {
    return estimateContextTokens(messages).tokens;
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
 */
function prepareSummarizableCompaction(
  branch: SessionTreeEntry[],
  settings: CompactionSettings,
  maxKeepRecentTokens: number,
): CompactionPreparation | undefined {
  for (
    let keepRecentTokens = settings.keepRecentTokens;
    ;
    keepRecentTokens *= 2
  ) {
    const preparation = prepareCompaction(branch, {
      ...settings,
      keepRecentTokens,
    });
    if (!preparation.ok || !preparation.value) return undefined;
    if (
      preparation.value.isSplitTurn ||
      preparation.value.messagesToSummarize.length > 0
    ) {
      return preparation.value;
    }
    if (keepRecentTokens >= maxKeepRecentTokens) return undefined;
  }
}

export type SessionCompactor = {
  /** Compact when the estimated context is over the threshold. */
  compactIfOverThreshold(): Promise<boolean>;
  /** Compact regardless of the estimate: the provider rejected the context. */
  compactAfterOverflow(): Promise<boolean>;
};

/**
 * Compacts the session's current branch: summarizes the older history into a
 * compaction entry and keeps the recent tail. Both methods resolve to whether
 * a compaction entry was added. `onEvent` gets `start` only once a summary is
 * actually being generated, and every `start` is followed by `done` or
 * `failed`.
 */
export function createSessionCompactor(opts: {
  session: Session;
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
}): SessionCompactor {
  const { session, models, model, signal, thinkingLevel, onEvent } = opts;
  const trigger = compactionTriggerTokens(model);
  const settings = compactionSettings(model);
  const estimate = () =>
    estimateSessionContextTokens(session, opts.overheadTokens);

  const run = async (reason: AutoCompactReason): Promise<boolean> => {
    if (signal?.aborted) return false;
    const tokensBefore = await estimate();
    if (reason === 'threshold' && tokensBefore <= trigger) return false;
    const preparation = prepareSummarizableCompaction(
      await session.getBranch(),
      settings,
      trigger,
    );
    if (!preparation) return false;

    onEvent?.(reason, 'start', tokensBefore);
    try {
      const result = await compact(
        preparation,
        models,
        model,
        undefined,
        signal,
        thinkingLevel,
      );
      if (!result.ok) {
        onEvent?.(reason, 'failed', tokensBefore);
        return false;
      }
      await session.appendCompaction(
        result.value.summary,
        result.value.firstKeptEntryId,
        tokensBefore,
        result.value.details,
        false,
        result.value.usage,
      );
    } catch {
      onEvent?.(reason, 'failed', tokensBefore);
      return false;
    }
    onEvent?.(reason, 'done', tokensBefore, await estimate());
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
 */
export function withOverflowRecovery(
  models: Models,
  opts: {
    contextWindow: number;
    recover: () => Promise<AgentMessage[] | undefined>;
  },
): Models {
  const streamSimple: Models['streamSimple'] = (model, context, options) => {
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
