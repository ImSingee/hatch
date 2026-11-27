/**
 * `@hatch/app/ai`: call the platform's configured AI models from an App
 * backend. The App names a role it declares in `hatch.json` (`ai.roles`);
 * the owner picks which model serves it, and the provider key never leaves
 * the platform. Uses the platform-injected `HATCH_AI_URL` and
 * `HATCH_SIGNING_SECRET` unless overridden.
 */
import { hmacHeaders, runtimeEnv } from './signing.js';

export type AiTextPart = { type: 'text'; text: string };
/** Base64 image bytes without a `data:` prefix. */
export type AiImagePart = {
  type: 'image';
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
};
export type AiToolCallPart = {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * Provider continuation state of the reply's reasoning. Opaque: keep it in
 * the history and send it back unchanged (a tool round-trip may require it).
 * Never show it to users.
 */
export type AiReasoningPart = { type: 'reasoning'; state: string };

export type AiMessage =
  | { role: 'user'; content: string | (AiTextPart | AiImagePart)[] }
  | {
      role: 'assistant';
      content: string | (AiTextPart | AiToolCallPart | AiReasoningPart)[];
    }
  | {
      role: 'tool';
      toolCallId: string;
      toolName: string;
      content: string | (AiTextPart | AiImagePart)[];
      isError?: boolean;
    };

export type AiToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema of the arguments, an object schema. */
  parameters: Record<string, unknown>;
};

export type ChatRequest = {
  /** A chat role declared in `hatch.json` `ai.roles`. */
  role: string;
  system?: string;
  messages: AiMessage[];
  tools?: AiToolDefinition[];
  /** Upper bound on generated tokens; capped at the model's own limit. */
  /** Upper bound on generated tokens, at least 16; capped at the model's limit. */
  maxTokens?: number;
};

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ChatResult = {
  message: {
    role: 'assistant';
    content: (AiTextPart | AiToolCallPart | AiReasoningPart)[];
  };
  /** `toolUse` means the reply asks for tool calls. */
  stopReason: 'stop' | 'length' | 'toolUse';
  usage: AiUsage;
  model: { provider: string; id: string };
};

export type ChatEvent =
  | { type: 'text'; delta: string }
  | ({ type: 'toolCall' } & Omit<AiToolCallPart, 'type'>)
  | { type: 'done'; result: ChatResult };

/** Stable codes: see the building-apps AI reference. */
export type AiErrorCode =
  | 'ai_unavailable'
  | 'ai_invalid_request'
  | 'ai_role_not_declared'
  | 'ai_role_kind_mismatch'
  | 'ai_no_model'
  | 'ai_model_unavailable'
  | 'ai_busy'
  | 'ai_provider_error'
  | 'ai_request_failed';

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** HTTP status of the platform response; 0 when no request was made. */
  readonly status: number;

  constructor(code: AiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export type AiRequestOptions = {
  url?: string;
  signingSecret?: string;
  signal?: AbortSignal;
};

async function post(
  path: '/chat' | '/image',
  payload: unknown,
  options: AiRequestOptions,
): Promise<Response> {
  const base = options.url ?? runtimeEnv('HATCH_AI_URL');
  const secret = options.signingSecret ?? runtimeEnv('HATCH_SIGNING_SECRET');
  if (!base || !secret) {
    throw new AiError(
      'ai_unavailable',
      'AI is unavailable: enable capabilities.ai with a backend and declare ai.roles.',
      0,
    );
  }
  const body = JSON.stringify(payload);
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await hmacHeaders(secret, body)),
      },
      body,
      signal: options.signal,
    });
  } catch (error) {
    throw transportError(error, options.signal);
  }
  if (!response.ok) throw await responseError(response, options.signal);
  return response;
}

/**
 * A failure reaching the platform as `AiError`, so callers classify every
 * failure by code. The caller's own cancellation stays as thrown.
 */
function transportError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof AiError || signal?.aborted) return error;
  return new AiError(
    'ai_request_failed',
    `Could not reach the platform AI endpoint: ${error instanceof Error ? error.message : String(error)}`,
    0,
  );
}

/** A response body as text; a connection lost while reading it is `AiError`. */
async function bodyText(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw transportError(error, signal);
  }
}

/** A JSON response body; a lost connection or a cut-off body is `AiError`. */
async function bodyJson<T>(
  response: Response,
  signal?: AbortSignal,
): Promise<T> {
  const text = await bodyText(response, signal);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AiError(
      'ai_request_failed',
      'The platform AI endpoint returned an unreadable response.',
      response.status,
    );
  }
}

async function responseError(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  let text: string;
  try {
    text = await bodyText(response, signal);
  } catch (error) {
    return error;
  }
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: AiErrorCode; message?: string };
    };
    if (parsed.error?.code)
      return new AiError(
        parsed.error.code,
        parsed.error.message ?? text,
        response.status,
      );
  } catch {
    // Not a structured error; fall through.
  }
  return new AiError(
    'ai_request_failed',
    text || `AI request failed (${response.status})`,
    response.status,
  );
}

async function* readServerEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  try {
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        throw transportError(error, signal);
      }
      const { done, value } = read;
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    // A caller that stops iterating early disconnects, so the platform aborts
    // the provider call instead of generating (and billing) the rest.
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** A streaming chat reply: iterate it for events, or await `result()`. */
export type ChatStream = AsyncIterable<ChatEvent> & {
  /** The final reply; consumes the stream if it was not iterated. */
  result(): Promise<ChatResult>;
  /** The reply's text, joined; consumes the stream if it was not iterated. */
  text(): Promise<string>;
};

/**
 * Stream a chat reply. Throws `AiError` (on iteration) for a rejected call
 * or a provider failure.
 */
export function chat(
  request: ChatRequest,
  options: AiRequestOptions = {},
): ChatStream {
  let final: ChatResult | undefined;
  let started = false;
  async function* events(): AsyncGenerator<ChatEvent> {
    if (started) throw new Error('A chat stream can be consumed only once.');
    started = true;
    const response = await post('/chat', { ...request, stream: true }, options);
    if (!response.body)
      throw new AiError('ai_request_failed', 'Empty AI response', 0);
    for await (const { event, data } of readServerEvents(
      response.body,
      options.signal,
    )) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new AiError(
          'ai_request_failed',
          'The platform AI stream sent an unreadable event.',
          200,
        );
      }
      if (event === 'text') {
        yield { type: 'text', delta: String(payload.delta ?? '') };
      } else if (event === 'tool_call') {
        const part = payload as AiToolCallPart;
        yield {
          type: 'toolCall',
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        };
      } else if (event === 'done') {
        final = payload as unknown as ChatResult;
        yield { type: 'done', result: final };
        return;
      } else if (event === 'error') {
        const error = (
          payload as { error?: { code?: AiErrorCode; message?: string } }
        ).error;
        throw new AiError(
          error?.code ?? 'ai_provider_error',
          error?.message ?? 'The AI call failed.',
          200,
        );
      }
    }
    throw new AiError(
      'ai_request_failed',
      'The AI stream ended without a result.',
      200,
    );
  }
  const iterable = events();
  const drain = async () => {
    if (!started) for await (const _ of iterable) void _;
    if (!final)
      throw new AiError(
        'ai_request_failed',
        'The chat stream was not read to its end.',
        0,
      );
    return final;
  };
  return {
    [Symbol.asyncIterator]: () => iterable,
    result: drain,
    text: async () => replyText(await drain()),
  };
}

/** One non-streaming chat call. */
export async function complete(
  request: ChatRequest,
  options: AiRequestOptions = {},
): Promise<ChatResult> {
  const response = await post('/chat', { ...request, stream: false }, options);
  return bodyJson<ChatResult>(response, options.signal);
}

/** The text parts of a reply, joined. */
export function replyText(result: ChatResult): string {
  return result.message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
}

export type GeneratedImage = {
  /** PNG bytes. */
  bytes: Uint8Array;
  /** The same bytes as base64. */
  base64: string;
  mimeType: 'image/png';
  model: { provider: string; id: string };
};

/** Generate one PNG image with an image role declared in `ai.roles`. */
export async function generateImage(
  request: {
    role: string;
    prompt: string;
    quality?: 'low' | 'medium' | 'high';
  },
  options: AiRequestOptions = {},
): Promise<GeneratedImage> {
  const response = await post('/image', request, options);
  const result = await bodyJson<{
    image: { data: string; mimeType: 'image/png' };
    model: { provider: string; id: string };
  }>(response, options.signal);
  const binary = atob(result.image.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return {
    bytes,
    base64: result.image.data,
    mimeType: result.image.mimeType,
    model: result.model,
  };
}

export type AiToolHandler = AiToolDefinition & {
  /** Runs with the model's arguments; the return value is sent back as JSON text. */
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
};

/**
 * Run a tool loop in this App: call the model, run the tools it asks for
 * with this App's own functions, send the results back, and repeat until it
 * answers without tool calls or `maxSteps` model calls were made. A tool
 * that throws is reported to the model as an error result.
 */
export async function runTools(
  request: Omit<ChatRequest, 'tools'> & {
    tools: AiToolHandler[];
    /** Most model calls; default 8. */
    maxSteps?: number;
  },
  options: AiRequestOptions = {},
): Promise<{ result: ChatResult; messages: AiMessage[]; steps: number }> {
  const { tools, maxSteps = 8, ...rest } = request;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
    throw new AiError(
      'ai_invalid_request',
      'maxSteps must be a positive whole number.',
      0,
    );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const definitions = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const messages = [...request.messages];
  for (let step = 1; ; step++) {
    const result = await complete(
      { ...rest, messages, tools: definitions },
      options,
    );
    messages.push(result.message);
    const calls = result.message.content.filter(
      (part): part is AiToolCallPart => part.type === 'toolCall',
    );
    if (result.stopReason !== 'toolUse' || !calls.length || step >= maxSteps)
      return { result, messages, steps: step };
    for (const call of calls) {
      const tool = byName.get(call.name);
      let content: string;
      let isError = false;
      try {
        if (!tool) throw new Error(`Unknown tool "${call.name}"`);
        const value = await tool.run(call.arguments);
        content =
          typeof value === 'string' ? value : JSON.stringify(value ?? null);
      } catch (error) {
        isError = true;
        content = error instanceof Error ? error.message : String(error);
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content,
        isError,
      });
    }
  }
}
