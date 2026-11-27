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
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import sharp from 'sharp';
import type { RunModelConfig } from '~agent/protocol';
import { buildRunModels } from '~agent/remote-models';
import type {
  AiAssistantPart,
  AiChatRequest,
  AiChatResult,
  AiMessage,
  AiUsageView,
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
        const content: (TextContent | ToolCall)[] =
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : {
                      type: 'toolCall',
                      id: part.id,
                      name: part.name,
                      arguments: part.arguments as JsonObject,
                    },
              );
        const assistant: AssistantMessage = {
          role: 'assistant',
          content,
          api: config.apiType,
          provider: config.providerId,
          model: config.model.id,
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

/** The reply's text and tool calls; reasoning content is not returned. */
export function assistantParts(message: AssistantMessage): AiAssistantPart[] {
  return message.content.flatMap((part): AiAssistantPart[] => {
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
 * Stream one chat completion. Always ends with exactly one `done` or
 * `error` event; provider failures become `error`, never a throw.
 */
export async function* streamChat(
  config: RunModelConfig,
  request: AiChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const { models, picked } = buildRunModels(config);
  const priced = Boolean(config.model.cost);
  const context: Context = {
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
