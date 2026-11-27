/**
 * Server-only: run one App AI call against the resolved model. Converts the
 * provider-neutral wire messages into pi-ai's context, streams the reply and
 * maps it back. The provider key stays inside this process.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  JsonObject,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import sharp from 'sharp';
import { z } from 'zod';
import type { RunModelConfig } from '~agent/protocol';
import { buildRunModels } from '~agent/remote-models';
import {
  AiCallError,
  type AiAssistantPart,
  type AiChatRequest,
  type AiChatResult,
  type AiMessage,
  type AiUsageView,
} from './contract';
import type { ResolvedImageRole } from './models';

const IMAGE_TIMEOUT_MS = 120_000;

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

type InputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function inputParts(
  content: string | InputPart[],
): (TextContent | ImageContent)[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', data: part.data, mimeType: part.mimeType },
  );
}

/**
 * A reasoning block as the App carries it back: the thinking content with its
 * signature, and the model that produced it. pi-ai replays it only to that
 * model and converts it for any other, so a role switched mid-conversation
 * still gets a valid history.
 */
const reasoningStateSchema = z
  .object({
    v: z.literal(1),
    api: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    thinking: z.string(),
    signature: z.string().optional(),
    redacted: z.boolean().optional(),
  })
  .strict();
type ReasoningState = z.infer<typeof reasoningStateSchema>;

export function encodeReasoning(
  block: ThinkingContent,
  source: Pick<AssistantMessage, 'api' | 'provider' | 'model'>,
): string {
  const state: ReasoningState = {
    v: 1,
    api: source.api,
    provider: source.provider,
    model: source.model,
    thinking: block.thinking,
    ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}),
    ...(block.redacted ? { redacted: true } : {}),
  };
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeReasoning(state: string): ReasoningState {
  try {
    return reasoningStateSchema.parse(
      JSON.parse(Buffer.from(state, 'base64url').toString('utf8')),
    );
  } catch {
    throw new AiCallError(
      'ai_invalid_request',
      'A reasoning part was changed; pass reasoning parts back exactly as received.',
    );
  }
}

/** Wire history into pi-ai messages, attributed to the model being called. */
export function toModelMessages(
  messages: AiMessage[],
  config: RunModelConfig,
): Message[] {
  const timestamp = Date.now();
  return messages.map((message): Message => {
    switch (message.role) {
      case 'user':
        return {
          role: 'user',
          content: inputParts(message.content),
          timestamp,
        };
      case 'assistant': {
        // A reply that carries reasoning is attributed to the model that
        // wrote it, so pi-ai keeps its signatures only for that model.
        let source: ReasoningState | undefined;
        const content: (TextContent | ThinkingContent | ToolCall)[] =
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content.map((part) => {
                if (part.type === 'text')
                  return { type: 'text', text: part.text };
                if (part.type === 'reasoning') {
                  const state = decodeReasoning(part.state);
                  source ??= state;
                  return {
                    type: 'thinking',
                    thinking: state.thinking,
                    ...(state.signature
                      ? { thinkingSignature: state.signature }
                      : {}),
                    ...(state.redacted ? { redacted: true } : {}),
                  };
                }
                return {
                  type: 'toolCall',
                  id: part.id,
                  name: part.name,
                  arguments: part.arguments as JsonObject,
                };
              });
        const assistant: AssistantMessage = {
          role: 'assistant',
          content,
          api: (source?.api ?? config.apiType) as AssistantMessage['api'],
          provider: source?.provider ?? config.providerId,
          model: source?.model ?? config.model.id,
          usage: zeroUsage(),
          stopReason: content.some((part) => part.type === 'toolCall')
            ? 'toolUse'
            : 'stop',
          timestamp,
        };
        return assistant;
      }
      case 'tool':
        return {
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: inputParts(message.content),
          isError: message.isError ?? false,
          timestamp,
        };
    }
  });
}

/**
 * The reply's text, tool calls and opaque reasoning state, which the App
 * sends back with tool results (some providers require the signed reasoning
 * blocks there).
 */
export function assistantParts(message: AssistantMessage): AiAssistantPart[] {
  return message.content.flatMap((part): AiAssistantPart[] => {
    if (part.type === 'thinking')
      return part.thinking || part.thinkingSignature
        ? [{ type: 'reasoning', state: encodeReasoning(part, message) }]
        : [];
    if (part.type === 'text')
      return part.text ? [{ type: 'text', text: part.text }] : [];
    if (part.type === 'toolCall')
      return [
        {
          type: 'toolCall',
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        },
      ];
    return [];
  });
}

export function usageView(
  usage: Usage | undefined,
  priced: boolean,
): AiUsageView {
  return {
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    costUsd:
      priced || usage?.cost.totalFromProvider ? (usage?.cost.total ?? 0) : null,
  };
}

/** Streaming events the endpoint forwards, in order, then one terminal. */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; part: Extract<AiAssistantPart, { type: 'toolCall' }> }
  | { type: 'done'; result: AiChatResult }
  | {
      type: 'error';
      aborted: boolean;
      message: string;
      usage: AiUsageView;
    };

/**
 * The model context for one request. Throws `AiCallError` for history the
 * platform cannot replay, before any provider call or call slot.
 */
export function chatContext(
  config: RunModelConfig,
  request: AiChatRequest,
): Context {
  return {
    ...(request.system ? { systemPrompt: request.system } : {}),
    messages: toModelMessages(request.messages, config),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
  };
}

/**
 * Stream one chat completion. Always ends with exactly one `done` or
 * `error` event; provider failures become `error`, never a throw.
 */
export async function* streamChat(
  config: RunModelConfig,
  request: AiChatRequest,
  context: Context,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const { models, picked } = buildRunModels(config);
  const priced = Boolean(config.model.cost);
  const maxTokens = Math.min(
    request.maxTokens ?? config.model.maxTokens,
    config.model.maxTokens,
  );
  const reasoning =
    picked.model.reasoning && config.thinkingLevel !== 'off'
      ? config.thinkingLevel
      : undefined;

  let stream: AsyncIterable<AssistantMessageEvent>;
  try {
    stream = models.streamSimple(picked.model, context, {
      signal,
      maxTokens,
      ...(reasoning ? { reasoning } : {}),
    });
  } catch (error) {
    yield {
      type: 'error',
      aborted: false,
      message: error instanceof Error ? error.message : String(error),
      usage: usageView(undefined, priced),
    };
    return;
  }

  try {
    for await (const event of stream) {
      if (event.type === 'text_delta' && event.delta) {
        yield { type: 'text', delta: event.delta };
      } else if (event.type === 'toolcall_end') {
        yield {
          type: 'toolCall',
          part: {
            type: 'toolCall',
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          },
        };
      } else if (event.type === 'done') {
        if (event.reason === 'deferred') {
          yield {
            type: 'error',
            aborted: false,
            message: 'The provider deferred the response.',
            usage: usageView(event.message.usage, priced),
          };
          return;
        }
        yield {
          type: 'done',
          result: {
            ok: true,
            message: {
              role: 'assistant',
              content: assistantParts(event.message),
            },
            stopReason: event.reason,
            usage: usageView(event.message.usage, priced),
            model: { provider: config.providerName, id: config.model.id },
          },
        };
        return;
      } else if (event.type === 'error') {
        yield {
          type: 'error',
          aborted: event.reason === 'aborted' || signal.aborted,
          message:
            event.error.errorMessage ??
            (event.reason === 'aborted'
              ? 'The call was cancelled.'
              : 'The provider returned an error.'),
          usage: usageView(event.error.usage, priced),
        };
        return;
      }
    }
  } catch (error) {
    yield {
      type: 'error',
      aborted: signal.aborted,
      message: error instanceof Error ? error.message : String(error),
      usage: usageView(undefined, priced),
    };
    return;
  }
  yield {
    type: 'error',
    aborted: signal.aborted,
    message: 'The provider stream ended without a result.',
    usage: usageView(undefined, priced),
  };
}

/** Generate one image and re-encode it as PNG (provider bytes never pass through as-is). */
export async function generateImage(
  role: ResolvedImageRole,
  prompt: string,
  quality: 'low' | 'medium' | 'high',
  signal: AbortSignal,
): Promise<Buffer> {
  const raw = await role.driver.generate(role.provider, {
    model: role.modelId,
    prompt,
    quality,
    background: 'opaque',
    signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
  });
  return sharp(raw, { limitInputPixels: 4096 * 4096 })
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}
