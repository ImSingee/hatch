/**
 * Run one Agent turn for a session and stream events out. Executes inside
 * the Agent Runner process: all platform state flows through the injected
 * PlatformClient, never through direct server imports.
 */
import type { CommandCredentials } from './command-credentials';
import { Buffer } from 'node:buffer';
import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentMessage,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
  isContextOverflow,
  type AssistantMessage,
  type Models,
} from '@earendil-works/pi-ai';
import { hasBetaFeature, WORKFLOW_BETA_FEATURE } from '~/beta-features';
import type { JsonValue } from '~/db/schema';
import {
  compactSessionMessages,
  createMidTurnCompactor,
  isOverCompactThreshold,
  pinMaxOutputTokens,
  transcriptBeforeLastUserMessage,
  type AutoCompactPhase,
  type AutoCompactReason,
} from './auto-compaction';
import { formatAttachmentPrompt, type AgentAttachmentRef } from './attachments';
import type { AgentComposerContentPart } from './composer-content';
import type { AgentStreamEvent } from './events';
import { SKILLS_DIR } from './paths';
import type { PlatformClient } from './platform-client';
import type { ResolvedModel } from './remote-models';
import { agentShellEnv } from './shell-env';
import { SessionExecutionEnv } from './sandboxed-file-io';
import { prepareAgentSessionSandbox } from './shell-sandbox';
import { loadAgentSkills } from './skills';
import { buildSystemPrompt } from './system-prompt';
import { createTools, type AskBridge, type EnvBridge } from './tools';
import { isCommandResultDetails } from './tools/command';
import type {
  StreamDetailsSelector,
  StreamStartDetailsSelector,
} from './tools/shared';

/** Keep streamed tool output small; the full result is persisted on `done`. */
const MAX_STREAM_OUTPUT = 4000;
/** Hard cap for tool-declared details crossing WS, DB event JSON, and SSE. */
const MAX_STREAM_DETAILS_BYTES = 32 * 1024;

function clip(text: string): string {
  return text.length > MAX_STREAM_OUTPUT
    ? `${text.slice(0, MAX_STREAM_OUTPUT)}\n… (truncated)`
    : text;
}

/** Extract readable text from a tool result or a tool's partial update. */
function extractToolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const content = (value as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

/** Keep only details that can safely cross WebSocket, DB JSON, and SSE. */
function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function selectBoundedDetails<T>(
  value: T,
  selectDetails: ((value: T) => unknown) | undefined,
): JsonValue | undefined {
  if (!selectDetails) return undefined;
  try {
    const details = selectDetails(value);
    if (!isJsonValue(details)) return undefined;
    const serialized = JSON.stringify(details);
    return Buffer.byteLength(serialized, 'utf8') <= MAX_STREAM_DETAILS_BYTES
      ? details
      : undefined;
  } catch {
    return undefined;
  }
}

function extractToolDetails(
  value: unknown,
  selectDetails: StreamDetailsSelector | undefined,
): JsonValue | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return selectBoundedDetails(
    (value as { details?: unknown }).details,
    selectDetails,
  );
}

function asDetailsRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeToolStartDetails(
  startDetails: unknown,
  existingDetails: unknown,
): Record<string, unknown> | undefined {
  const startDetailsRecord = asDetailsRecord(startDetails);
  if (!startDetailsRecord) return undefined;
  return {
    ...startDetailsRecord,
    ...asDetailsRecord(existingDetails),
  };
}

function addToolStartDetailsToTranscript(
  messages: JsonValue[],
  toolStartDetailsById: ReadonlyMap<string, JsonValue | undefined>,
): JsonValue[] {
  const latestToolResultIndexById = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const messageRecord = asDetailsRecord(message);
    if (
      messageRecord?.role === 'toolResult' &&
      typeof messageRecord.toolCallId === 'string' &&
      toolStartDetailsById.has(messageRecord.toolCallId)
    ) {
      latestToolResultIndexById.set(messageRecord.toolCallId, index);
    }
  }
  return messages.map((message, index) => {
    const messageRecord = asDetailsRecord(message);
    if (
      messageRecord?.role !== 'toolResult' ||
      typeof messageRecord.toolCallId !== 'string' ||
      latestToolResultIndexById.get(messageRecord.toolCallId) !== index
    ) {
      return message;
    }
    const details = mergeToolStartDetails(
      toolStartDetailsById.get(messageRecord.toolCallId),
      messageRecord.details,
    );
    return details ? ({ ...messageRecord, details } as JsonValue) : message;
  });
}

export type RunAgentTurnOptions = {
  commandCredentials?: CommandCredentials;
  appUrl: string;
  betaFeatures: readonly string[];
  tavilyApiKey?: string | null;
  priorMessages: AgentMessage[];
  sessionId: string;
  userText: string;
  composerContent?: AgentComposerContentPart[];
  images?: { data: string; mimeType: string }[];
  attachments?: AgentAttachmentRef[];
  models: Models;
  picked: ResolvedModel;
  platform: PlatformClient;
  signal: AbortSignal;
  ask?: AskBridge;
  requestEnv?: EnvBridge;
  emit: (event: AgentStreamEvent) => void;
};

export type RunAgentTurnResult = {
  messages: JsonValue[];
  error?: string;
};

export async function runAgentTurn(
  opts: RunAgentTurnOptions,
): Promise<RunAgentTurnResult> {
  const { sessionId, userText, signal, emit, models, picked } = opts;
  const workflowBetaEnabled = hasBetaFeature(
    opts.betaFeatures,
    WORKFLOW_BETA_FEATURE,
  );

  prepareAgentSessionSandbox(sessionId);

  // Never hand the model's shell the raw server env: with run_command it could
  // otherwise read host secrets (DATABASE_URL, auth keys, provider keys, …),
  // including via prompt-injected project files. agentShellEnv() strips
  // everything outside a small dev allowlist.
  const env = new SessionExecutionEnv({
    sessionId,
    shellEnv: agentShellEnv(sessionId),
    readOnlyRoots: [SKILLS_DIR],
  });

  const skills = await loadAgentSkills(env, { workflowBetaEnabled });
  const tools = createTools(env, {
    commandCredentials: opts.commandCredentials,
    workflowBetaEnabled,
    platform: opts.platform,
    ...(opts.tavilyApiKey ? { tavilyApiKey: opts.tavilyApiKey } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.requestEnv ? { requestEnv: opts.requestEnv } : {}),
    readOnlyRoots: [SKILLS_DIR],
    sessionId,
  });
  // Server-side source of truth for tool display labels. Emitting the label on
  // tool_start lets the client show it without maintaining a second copy of
  // every tool name (which drifted out of date and showed raw snake_case).
  const labelByName = new Map(tools.map((tool) => [tool.name, tool.label]));
  const streamStartDetailsByName = new Map<
    string,
    StreamStartDetailsSelector
  >();
  const streamDetailsByName = new Map<string, StreamDetailsSelector>();
  for (const tool of tools) {
    if (tool.selectStreamStartDetails) {
      streamStartDetailsByName.set(tool.name, tool.selectStreamStartDetails);
    }
    if (tool.selectStreamDetails) {
      streamDetailsByName.set(tool.name, tool.selectStreamDetails);
    }
  }

  const images = (opts.images ?? []).map((i) => ({
    type: 'image' as const,
    data: i.data,
    mimeType: i.mimeType,
  }));
  const thinkingLevel: ThinkingLevel = picked.model.reasoning
    ? 'medium'
    : 'off';

  const emitCompact = (
    reason: AutoCompactReason,
    phase: AutoCompactPhase,
    tokensBefore?: number,
    tokensAfter?: number,
  ) =>
    emit({
      type: 'compact',
      reason,
      phase,
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      ...(tokensAfter === undefined ? {} : { tokensAfter }),
    });

  let attemptPriorMessages = opts.priorMessages;
  // The overflow retry always compacts: the estimate already cleared this
  // history once and the provider rejected it anyway.
  let forceCompact = false;
  for (;;) {
    const attempt = await runAgentTurnAttempt({
      appUrl: opts.appUrl,
      priorMessages: attemptPriorMessages,
      sessionId,
      userText,
      composerContent: opts.composerContent,
      attachments: opts.attachments,
      images,
      models,
      picked,
      tools,
      labelByName,
      streamStartDetailsByName,
      streamDetailsByName,
      thinkingLevel,
      signal,
      emit,
      emitCompact,
      forceCompact,
      skills,
      workflowBetaEnabled,
    });

    // A provider-side context-length rejection means the estimate was wrong
    // (or a silent truncation). Retry the turn once on a compacted history:
    // drop the failed turn's partial work (everything from the last user
    // message on), force-persisted compaction on the rest, then re-prompt.
    const retryable =
      !forceCompact &&
      attempt.assistant !== undefined &&
      (attempt.assistant.stopReason === 'error' ||
        attempt.assistant.stopReason === 'length') &&
      isContextOverflow(attempt.assistant, picked.model.contextWindow);
    if (retryable) {
      const head = transcriptBeforeLastUserMessage(attempt.messages);
      if (head && head.length > 0) {
        attemptPriorMessages = head;
        forceCompact = true;
        continue;
      }
    }
    return attempt.result;
  }
}

type TurnAttemptResult = {
  result: RunAgentTurnResult;
  /** The prompt's assistant message, for overflow classification. */
  assistant?: AssistantMessage;
  /** Undecorated transcript messages (post-compaction view). */
  messages: AgentMessage[];
};

async function runAgentTurnAttempt(opts: {
  appUrl: string;
  priorMessages: AgentMessage[];
  sessionId: string;
  userText: string;
  composerContent?: AgentComposerContentPart[];
  attachments?: AgentAttachmentRef[];
  images: { type: 'image'; data: string; mimeType: string }[];
  models: Models;
  picked: ResolvedModel;
  tools: ReturnType<typeof createTools>;
  labelByName: Map<string, string>;
  streamStartDetailsByName: Map<string, StreamStartDetailsSelector>;
  streamDetailsByName: Map<string, StreamDetailsSelector>;
  thinkingLevel: ThinkingLevel;
  signal: AbortSignal;
  emit: (event: AgentStreamEvent) => void;
  emitCompact: (
    reason: AutoCompactReason,
    phase: AutoCompactPhase,
    tokensBefore?: number,
    tokensAfter?: number,
  ) => void;
  forceCompact: boolean;
  skills: Awaited<ReturnType<typeof loadAgentSkills>>;
  workflowBetaEnabled: boolean;
}): Promise<TurnAttemptResult> {
  const {
    priorMessages,
    sessionId,
    userText,
    signal,
    emit,
    emitCompact,
    models,
    picked,
    tools,
    labelByName,
    streamStartDetailsByName,
    streamDetailsByName,
    thinkingLevel,
    forceCompact,
    skills,
    workflowBetaEnabled,
  } = opts;

  const repo = new InMemorySessionRepo();
  const session = await repo.create({ id: sessionId });
  for (const message of priorMessages) {
    await session.appendMessage(message);
  }

  // Persisted compaction before the turn: history over the input budget is
  // summarized into a session compaction entry, so buildContext() — and the
  // transcript reported back — already carries the compressed view.
  if (forceCompact || isOverCompactThreshold(priorMessages, picked.model)) {
    const reason: AutoCompactReason = forceCompact ? 'overflow' : 'threshold';
    const outcome = await compactSessionMessages({
      session,
      models,
      model: picked.model,
      signal,
      thinkingLevel,
      onStart: () => emitCompact(reason, 'start'),
    });
    if (outcome.status === 'compacted') {
      emitCompact(reason, 'done', outcome.tokensBefore, outcome.tokensAfter);
    } else if (outcome.status === 'failed') {
      emitCompact(reason, 'failed');
    }
  }

  const harness = new AgentHarness({
    session,
    models,
    model: picked.model,
    tools,
    resources: { skills },
    systemPrompt: ({ resources }) =>
      buildSystemPrompt(
        opts.appUrl,
        { workflowBetaEnabled },
        resources.skills ?? [],
      ),
    thinkingLevel,
  });
  const toolStartDetailsById = new Map<string, JsonValue | undefined>();

  // Mid-turn compaction: each provider request's context runs through this
  // transform, so tool output that outgrows the estimate mid-run is replaced
  // by a summary before the next call. Context-only — the session transcript
  // keeps full fidelity.
  const transformContext = createMidTurnCompactor({
    models,
    model: picked.model,
    signal,
    thinkingLevel,
    onEvent: (phase, tokensBefore) =>
      emitCompact('threshold', phase, tokensBefore),
  });
  const removeContextHook = harness.on('context', async (event) => {
    const messages = await transformContext(event.messages);
    return messages === undefined ? undefined : { messages };
  });

  // Keep the configured max output on every request: pi-ai otherwise shrinks
  // max_tokens as the context fills, and the compaction trigger already
  // reserves the output budget up front.
  const removePayloadHook = harness.on('before_provider_payload', (event) => ({
    payload: pinMaxOutputTokens(event.payload, picked.model.maxTokens),
  }));

  // Persist the path identity selected at tool start even when execution
  // fails. The same hook also marks a non-zero shell exit as an error while
  // retaining its useful stdout/stderr/details.
  const removeToolResultHook = harness.on('tool_result', (event) => {
    const startDetails = toolStartDetailsById.has(event.toolCallId)
      ? toolStartDetailsById.get(event.toolCallId)
      : selectBoundedDetails(
          event.input,
          streamStartDetailsByName.get(event.toolName),
        );
    const details = mergeToolStartDetails(startDetails, event.details);
    const commandFailed =
      event.toolName === 'run_command' &&
      !event.isError &&
      isCommandResultDetails(event.details) &&
      event.details.exitCode !== 0;

    if (details || commandFailed) {
      return {
        ...(details ? { details } : {}),
        ...(commandFailed ? { isError: true } : {}),
      };
    }
    return undefined;
  });

  const onAbort = () => {
    // Swallow abort rejections: a rejected abort() would otherwise become a
    // process-level unhandledRejection that can crash the server.
    void Promise.resolve(harness.abort()).catch(() => {});
  };
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) {
    onAbort();
  }

  // Did the current thinking block stream any real text delta? Some providers
  // (notably OpenAI reasoning summaries via the relay) stream empty
  // `thinking_delta` events and only deliver the full summary text in the
  // final `thinking_end`. We track this per block so we can backfill.
  let sawThinkingDelta = false;

  const unsubscribe = harness.subscribe((event) => {
    switch (event.type) {
      case 'message_start': {
        if ('message' in event && event.message.role === 'assistant') {
          emit({ type: 'assistant_start' });
        }
        break;
      }
      case 'message_update': {
        const inner = event.assistantMessageEvent;
        // Forward only real string deltas. Reasoning models with encrypted/
        // redacted thinking (e.g. OpenAI responses) emit thinking_delta events
        // whose `delta` is undefined; forwarding those would render "undefined".
        if (inner.type === 'text_delta' && inner.delta) {
          emit({ type: 'text', delta: inner.delta });
        } else if (inner.type === 'thinking_start') {
          sawThinkingDelta = false;
        } else if (inner.type === 'thinking_delta' && inner.delta) {
          // Only real (non-whitespace) text counts as "seen". Some relays emit
          // a lone "\n\n" separator as the only delta while the actual summary
          // arrives in thinking_end; that must not suppress the backfill below.
          if (inner.delta.trim()) sawThinkingDelta = true;
          emit({ type: 'thinking', delta: inner.delta });
        } else if (inner.type === 'thinking_end') {
          // Relays that strip streaming summary deltas still send the full
          // text here. Backfill it so the thinking is shown at least once.
          const content = (inner as { content?: string }).content;
          if (!sawThinkingDelta && content) {
            emit({ type: 'thinking', delta: content });
          }
        }
        break;
      }
      case 'tool_execution_start': {
        const label = labelByName.get(event.toolName);
        const streamedArgs = isJsonValue(event.args) ? event.args : null;
        const args = asDetailsRecord(streamedArgs);
        const details = args
          ? selectBoundedDetails(
              args,
              streamStartDetailsByName.get(event.toolName),
            )
          : undefined;
        // Keep an explicit undefined entry: validation may coerce invalid raw
        // arguments before the tool-result hook runs, and recomputing details
        // from those coerced values would fabricate a different path.
        toolStartDetailsById.set(event.toolCallId, details);
        emit({
          type: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          ...(label ? { label } : {}),
          args: streamedArgs,
          ...(details === undefined ? {} : { details }),
        });
        break;
      }
      case 'tool_execution_update': {
        const output = extractToolText(event.partialResult);
        if (output) {
          emit({
            type: 'tool_update',
            id: event.toolCallId,
            name: event.toolName,
            output: clip(output),
          });
        }
        break;
      }
      case 'tool_execution_end': {
        const details =
          extractToolDetails(
            event.result,
            streamDetailsByName.get(event.toolName),
          ) ?? toolStartDetailsById.get(event.toolCallId);
        emit({
          type: 'tool_end',
          id: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          output: clip(extractToolText(event.result)),
          ...(details === undefined ? {} : { details }),
        });
        break;
      }
      case 'turn_end': {
        emit({ type: 'turn_end' });
        break;
      }
      default:
        break;
    }
  });

  const rawTranscript = async (): Promise<AgentMessage[]> =>
    (await session.buildContext()).messages;

  const buildTranscript = async (): Promise<JsonValue[]> => {
    const messages = addToolStartDetailsToTranscript(
      (await rawTranscript()) as unknown as JsonValue[],
      toolStartDetailsById,
    );
    const attachments = opts.attachments ?? [];
    const composerContent = opts.composerContent ?? [];
    if (attachments.length === 0 && composerContent.length === 0) {
      return messages;
    }
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'user'
      ) {
        messages[index] = {
          ...message,
          ...(attachments.length > 0
            ? { attachments: attachments as unknown as JsonValue }
            : {}),
          ...(composerContent.length > 0
            ? { composerContent: composerContent as unknown as JsonValue }
            : {}),
        };
        break;
      }
    }
    return messages;
  };

  try {
    const assistant = await harness.prompt(
      formatAttachmentPrompt(userText, opts.attachments ?? []),
      opts.images.length > 0 ? { images: opts.images } : undefined,
    );
    const messages = await buildTranscript();
    const rawMessages = await rawTranscript();

    // AgentHarness reports provider/stream failures as a resolved assistant
    // message rather than rejecting prompt(). Propagate those terminal reasons
    // to the runner while keeping the full transcript (including partial text).
    if (
      assistant.stopReason === 'error' ||
      assistant.stopReason === 'aborted'
    ) {
      return {
        result: {
          messages,
          error:
            assistant.errorMessage ||
            (assistant.stopReason === 'aborted'
              ? 'Agent run was aborted.'
              : 'Agent run failed.'),
        },
        assistant,
        messages: rawMessages,
      };
    }

    return { result: { messages }, assistant, messages: rawMessages };
  } catch (error) {
    return {
      result: {
        messages: await buildTranscript(),
        error: error instanceof Error ? error.message : String(error),
      },
      messages: await rawTranscript(),
    };
  } finally {
    unsubscribe();
    removeContextHook();
    removePayloadHook();
    removeToolResultHook();
    signal.removeEventListener('abort', onAbort);
  }
}
