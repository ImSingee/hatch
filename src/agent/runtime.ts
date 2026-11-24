/**
 * Run one Agent turn for a session and stream events out. Executes inside
 * the Agent Runner process: all platform state flows through the injected
 * PlatformClient, never through direct server imports.
 */
import type { CommandCredentials } from './command-credentials';
import { Buffer } from 'node:buffer';
import {
  runAgentLoop,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models,
  type SystemMessage,
} from '@earendil-works/pi-ai';
import type { JsonValue } from '~/db/schema';
import {
  createTranscriptCompactor,
  withOverflowRecovery,
} from './auto-compaction';
import { formatAttachmentPrompt, type AgentAttachmentRef } from './attachments';
import {
  composerDisplayText,
  type AgentComposerContentPart,
} from './composer-content';
import type { AgentStreamEvent } from './events';
import { convertToLlm } from './llm-messages';
import type { SteerMessage } from './protocol';
import { SKILLS_DIR } from './paths';
import type { PlatformClient } from './platform-client';
import type { ResolvedModel } from './remote-models';
import { agentShellEnv } from './shell-env';
import { SessionExecutionEnv } from './sandboxed-file-io';
import { prepareAgentSessionSandbox } from './shell-sandbox';
import { Transcript } from './transcript';
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

/**
 * Steer messages the user sent while this run is working. The platform owns
 * them until `claim` hands them over, so edits and cancels stay exact up to
 * the tool-call boundary where they are injected.
 */
export type SteerBridge = {
  /** True when the platform said steer messages wait for this run. */
  pending(): boolean;
  /** Claim the waiting messages now; resolves [] when none or unreachable. */
  claim(): Promise<SteerMessage[]>;
};

function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * Put Hatch metadata back onto the user messages this run added. Only the
 * run's prompt and the steer messages injected into it are new user
 * messages, so the last `steered.length` of them are the steered ones (in
 * injection order) and the one before is the prompt.
 */
export function annotateRunUserMessages(
  messages: JsonValue[],
  run: {
    attachments: AgentAttachmentRef[];
    composerContent: AgentComposerContentPart[];
    steered: readonly SteerMessage[];
  },
): JsonValue[] {
  const userIndexes: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (asRecord(message)?.role === 'user') userIndexes.push(index);
  }
  const steeredIndexes = userIndexes.slice(
    Math.max(0, userIndexes.length - run.steered.length),
  );
  const result = [...messages];
  steeredIndexes.forEach((index, position) => {
    const steer =
      run.steered[run.steered.length - steeredIndexes.length + position];
    result[index] = {
      ...asRecord(result[index])!,
      steered: true,
      pendingMessageId: steer.id,
      ...(steer.attachments.length > 0
        ? { attachments: steer.attachments as unknown as JsonValue }
        : {}),
      ...(steer.composerContent.length > 0
        ? { composerContent: steer.composerContent as unknown as JsonValue }
        : {}),
    };
  });
  const promptIndex =
    userIndexes[userIndexes.length - steeredIndexes.length - 1];
  if (
    promptIndex !== undefined &&
    (run.attachments.length > 0 || run.composerContent.length > 0)
  ) {
    result[promptIndex] = {
      ...asRecord(result[promptIndex])!,
      ...(run.attachments.length > 0
        ? { attachments: run.attachments as unknown as JsonValue }
        : {}),
      ...(run.composerContent.length > 0
        ? { composerContent: run.composerContent as unknown as JsonValue }
        : {}),
    };
  }
  return result;
}

function userMessage(text: string, images: ImageContent[]): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...images],
    timestamp: Date.now(),
  };
}

/**
 * The assistant message a run ends with when the loop itself failed, so the
 * failure is recorded in the transcript like a provider error.
 */
function failureMessage(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export type RunAgentTurnOptions = {
  commandCredentials?: CommandCredentials;
  appUrl: string;
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
  steer?: SteerBridge;
  emit: (event: AgentStreamEvent) => void;
};

export type RunAgentTurnResult = {
  messages: JsonValue[];
  error?: string;
};

export async function runAgentTurn(
  opts: RunAgentTurnOptions,
): Promise<RunAgentTurnResult> {
  const { priorMessages, sessionId, userText, signal, emit, models, picked } =
    opts;

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

  // `priorMessages` is the complete transcript, compaction markers included;
  // the transcript derives the (possibly compacted) model context from it.
  const transcript = Transcript.load(priorMessages);

  const skills = await loadAgentSkills(env);
  const tools = createTools(env, {
    commandCredentials: opts.commandCredentials,
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

  const thinkingLevel = picked.model.reasoning ? 'medium' : 'off';
  const systemPrompt = buildSystemPrompt(opts.appUrl, skills);
  // The prompt and the tool declarations travel as the leading system message
  // of every request. It is rebuilt for each run and never stored.
  const systemMessage: SystemMessage = {
    role: 'system',
    content: systemPrompt,
    toolsAdded: tools.map(toToolDeclaration),
    timestamp: Date.now(),
  };
  const modelContext = (): AgentMessage[] => [
    systemMessage,
    ...transcript.modelContext(),
  ];
  const compactor = createTranscriptCompactor({
    transcript,
    models,
    model: picked.model,
    signal,
    thinkingLevel,
    // Every request also carries the system prompt and the tool schemas.
    overheadTokens: Math.ceil(
      (systemPrompt.length +
        JSON.stringify(
          tools.map((tool) => [tool.name, tool.description, tool.parameters]),
        ).length) /
        4,
    ),
    onEvent: (reason, phase, tokensBefore, tokensAfter) =>
      emit({
        type: 'compact',
        reason,
        phase,
        tokensBefore: Math.round(tokensBefore),
        ...(tokensAfter === undefined
          ? {}
          : { tokensAfter: Math.round(tokensAfter) }),
      }),
  });
  // A request the provider rejects for context length is compacted and
  // re-sent in place, so the turn keeps the tool work it already did.
  const streamModels = withOverflowRecovery(models, {
    contextWindow: picked.model.contextWindow,
    signal,
    recover: async () =>
      (await compactor.compactAfterOverflow()) ? modelContext() : undefined,
  });
  // Only these options reach the provider: the Hatch session id routes
  // provider-side prompt caching, and nothing opts into deferred responses or
  // pi's provider attribution (the loop's `identity`).
  const streamFn: StreamFn = (model, context, options) =>
    streamModels.streamSimple(model, context, {
      reasoning: options?.reasoning,
      signal: options?.signal,
      sessionId,
    });

  const toolStartDetailsById = new Map<string, JsonValue | undefined>();

  // Did the current thinking block stream any real text delta? Some providers
  // (notably OpenAI reasoning summaries via the relay) stream empty
  // `thinking_delta` events and only deliver the full summary text in the
  // final `thinking_end`. We track this per block so we can backfill.
  let sawThinkingDelta = false;

  // Steer messages claimed for pi to inject, and the ones already injected
  // (in order) for the transcript.
  const awaitingInjection: SteerMessage[] = [];
  const injected: SteerMessage[] = [];

  // pi polls for steering once when the run starts and again after every
  // completed turn (after `turn_end`), never after an errored or aborted
  // reply. Claiming at those later polls injects the messages at this exact
  // boundary: after the assistant message and all of its tool calls, before
  // the next LLM call. The run's own prompt goes first, so the first poll
  // claims nothing.
  let steeringPolled = false;
  const getSteeringMessages = async (): Promise<AgentMessage[]> => {
    if (!steeringPolled) {
      steeringPolled = true;
      return [];
    }
    if (!opts.steer?.pending() || signal.aborted) return [];
    const messages: AgentMessage[] = [];
    try {
      for (const message of await opts.steer.claim()) {
        if (signal.aborted) break;
        const images = message.images.map((image) => ({
          type: 'image' as const,
          data: image.data,
          mimeType: image.mimeType,
        }));
        messages.push(
          userMessage(
            formatAttachmentPrompt(message.userText, message.attachments),
            images,
          ),
        );
        awaitingInjection.push(message);
      }
    } catch (error) {
      // A failed hand-over must not fail the run: whatever was claimed but
      // not injected returns to the user's pending messages when the
      // platform settles this run.
      console.error('[agent] steer messages could not be injected:', error);
    }
    return messages;
  };

  const handleEvent = async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_start': {
        if (!('message' in event)) break;
        if (event.message.role === 'assistant') {
          emit({ type: 'assistant_start' });
        } else if (
          event.message.role === 'user' &&
          awaitingInjection.length > 0
        ) {
          // The run's own prompt starts before anything can be claimed, so a
          // user message while claimed messages wait is the next one of them.
          const message = awaitingInjection.shift()!;
          injected.push(message);
          emit({
            type: 'user_message',
            pendingId: message.id,
            text: message.composerContent.length
              ? composerDisplayText(message.composerContent)
              : message.userText,
            ...(message.composerContent.length > 0
              ? { composerContent: message.composerContent }
              : {}),
            ...(message.attachments.length > 0
              ? { attachments: message.attachments }
              : {}),
            images: message.images.map((image) => ({
              mimeType: image.mimeType,
            })),
          });
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
  };
  // Every message is recorded before listeners see its end, as pi's harness
  // did, so a compaction triggered by the next request includes it. System
  // messages are per-run request framing, not conversation history.
  const sink = async (event: AgentEvent) => {
    if (event.type === 'message_end' && event.message.role !== 'system') {
      transcript.appendMessage(event.message);
    }
    await handleEvent(event);
  };

  // Persist the path identity selected at tool start even when execution
  // fails. The same hook also marks a non-zero shell exit as an error while
  // retaining its useful stdout/stderr/details.
  const afterToolCall: AgentLoopConfig['afterToolCall'] = async ({
    toolCall,
    args,
    result,
    isError,
  }) => {
    const startDetails = toolStartDetailsById.has(toolCall.id)
      ? toolStartDetailsById.get(toolCall.id)
      : selectBoundedDetails(
          args as Record<string, unknown>,
          streamStartDetailsByName.get(toolCall.name),
        );
    const details = mergeToolStartDetails(startDetails, result.details);
    const commandFailed =
      toolCall.name === 'run_command' &&
      !isError &&
      isCommandResultDetails(result.details) &&
      result.details.exitCode !== 0;

    if (details || commandFailed) {
      return {
        ...(details ? { details } : {}),
        ...(commandFailed ? { isError: true } : {}),
      };
    }
    return undefined;
  };

  const images = (opts.images ?? []).map((i) => ({
    type: 'image' as const,
    data: i.data,
    mimeType: i.mimeType,
  }));

  const buildTranscript = async (): Promise<JsonValue[]> => {
    const messages = addToolStartDetailsToTranscript(
      transcript.serialize(),
      toolStartDetailsById,
    );
    return annotateRunUserMessages(messages, {
      attachments: opts.attachments ?? [],
      composerContent: opts.composerContent ?? [],
      steered: injected,
    });
  };

  const runLoop = async (): Promise<AgentMessage[]> => {
    const prompt = userMessage(
      formatAttachmentPrompt(userText, opts.attachments ?? []),
      images,
    );
    try {
      return await runAgentLoop(
        [prompt],
        { messages: modelContext(), tools },
        {
          model: picked.model,
          reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel,
          convertToLlm,
          // Every provider request passes through here with the transcript
          // already holding the messages it is about to send (the new user
          // message on the first request, tool results on later ones). Over
          // the threshold, the transcript is compacted first; the request
          // always goes out on the transcript's model context.
          transformContext: async () => {
            await compactor.compactIfOverThreshold();
            return modelContext();
          },
          afterToolCall,
          getSteeringMessages,
        },
        sink,
        signal,
        streamFn,
      );
    } catch (error) {
      // A loop failure (not a provider error, which the stream reports) ends
      // the run with a failed assistant message, like a provider error.
      const failure = failureMessage(picked.model, error, signal.aborted);
      await sink({ type: 'message_start', message: failure });
      await sink({ type: 'message_end', message: failure });
      await sink({ type: 'turn_end', message: failure, toolResults: [] });
      await sink({ type: 'agent_end', messages: [failure] });
      return [failure];
    }
  };

  try {
    const assistant = (await runLoop())
      .filter(
        (message): message is AssistantMessage => message.role === 'assistant',
      )
      .at(-1);
    if (!assistant) {
      throw new Error('Agent run completed without an assistant message.');
    }
    const messages = await buildTranscript();

    // Provider/stream failures end the loop with an assistant message instead
    // of a rejection. Propagate those terminal reasons to the runner while
    // keeping the full transcript (including partial text).
    if (
      assistant.stopReason === 'error' ||
      assistant.stopReason === 'aborted'
    ) {
      return {
        messages,
        error:
          assistant.errorMessage ||
          (assistant.stopReason === 'aborted'
            ? 'Agent run was aborted.'
            : 'Agent run failed.'),
      };
    }

    return { messages };
  } catch (error) {
    return {
      messages: await buildTranscript(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
