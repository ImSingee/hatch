/**
 * Wire contract of the App AI endpoints (`/api/app/<id>/ai/*`). The App
 * backend calls them through `@hatch/app/ai`; the request and response
 * shapes are provider-neutral so an App never depends on which provider the
 * owner picked for a role.
 */
import { z } from 'zod';

/** Largest signed request body: room for a few inline images. */
export const MAX_AI_BODY_BYTES = 8 * 1024 * 1024;
/** Calls one App may have in flight at once. */
export const MAX_AI_CONCURRENT_CALLS = 4;
/** Longest an image prompt may be. */
export const MAX_IMAGE_PROMPT_CHARS = 4000;

/** Stable error codes App code may branch on. */
export const AI_ERROR_CODES = [
  'ai_invalid_request',
  'ai_role_not_declared',
  'ai_role_kind_mismatch',
  'ai_no_model',
  'ai_model_unavailable',
  'ai_busy',
  'ai_provider_error',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

const HTTP_STATUS: Record<AiErrorCode, number> = {
  ai_invalid_request: 400,
  ai_role_not_declared: 422,
  ai_role_kind_mismatch: 422,
  ai_no_model: 409,
  ai_model_unavailable: 409,
  ai_busy: 429,
  ai_provider_error: 502,
};

export class AiCallError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiCallError';
    this.code = code;
    this.status = HTTP_STATUS[code];
  }
}

export function aiErrorBody(code: AiErrorCode, message: string) {
  return { ok: false as const, error: { code, message } };
}

export function aiErrorResponse(error: AiCallError): Response {
  return Response.json(aiErrorBody(error.code, error.message), {
    status: error.status,
  });
}

const roleName = z.string().min(1).max(64);
const textPart = z
  .object({ type: z.literal('text'), text: z.string() })
  .strict();
const imagePart = z
  .object({
    type: z.literal('image'),
    /** Base64 image bytes, without a `data:` prefix. */
    data: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  })
  .strict();
const toolName = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{1,64}$/,
    'tool names are 1-64 letters, digits, "_" or "-"',
  );
const toolCallPart = z
  .object({
    type: z.literal('toolCall'),
    id: z.string().min(1).max(256),
    name: toolName,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * Provider continuation state of a reply's reasoning (for example signed
 * thinking blocks a tool round-trip must send back). Opaque to the App: it
 * passes the part back unchanged in the next request's history.
 */
const reasoningPart = z
  .object({
    type: z.literal('reasoning'),
    state: z.string().min(1).max(2_000_000),
  })
  .strict();

const userMessage = z
  .object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.union([textPart, imagePart]))]),
  })
  .strict();
const assistantMessage = z
  .object({
    role: z.literal('assistant'),
    content: z.union([
      z.string(),
      z.array(z.union([textPart, toolCallPart, reasoningPart])),
    ]),
  })
  .strict();
const toolResultMessage = z
  .object({
    role: z.literal('tool'),
    toolCallId: z.string().min(1).max(256),
    toolName,
    content: z.union([z.string(), z.array(z.union([textPart, imagePart]))]),
    isError: z.boolean().optional(),
  })
  .strict();

export const aiMessageSchema = z.discriminatedUnion('role', [
  userMessage,
  assistantMessage,
  toolResultMessage,
]);
export type AiMessage = z.infer<typeof aiMessageSchema>;

export const aiToolSchema = z
  .object({
    name: toolName,
    description: z.string().max(4000),
    /** JSON Schema of the tool arguments (an object schema). */
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AiTool = z.infer<typeof aiToolSchema>;

export const aiChatRequestSchema = z
  .object({
    role: roleName,
    system: z.string().max(200_000).optional(),
    messages: z.array(aiMessageSchema).min(1).max(500),
    tools: z
      .array(aiToolSchema)
      .max(64)
      .optional()
      .superRefine((tools, ctx) => {
        const seen = new Set<string>();
        tools?.forEach((tool, index) => {
          if (seen.has(tool.name))
            ctx.addIssue({
              code: 'custom',
              message: 'duplicate tool name',
              path: [index, 'name'],
            });
          seen.add(tool.name);
        });
      }),
    /** Upper bound on generated tokens; capped at the model's own limit. */
    maxTokens: z.number().int().positive().optional(),
    /** Stream server-sent events (default) or return one JSON response. */
    stream: z.boolean().optional(),
  })
  .strict();
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

export const aiImageRequestSchema = z
  .object({
    role: roleName,
    prompt: z.string().trim().min(1).max(MAX_IMAGE_PROMPT_CHARS),
    quality: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();
export type AiImageRequest = z.infer<typeof aiImageRequestSchema>;

/** Token usage the App sees for one call. */
export type AiUsageView = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type AiAssistantPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; state: string }
  | {
      type: 'toolCall';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };

/** Final result of a chat call; also the payload of the stream's `done`. */
export type AiChatResult = {
  ok: true;
  message: { role: 'assistant'; content: AiAssistantPart[] };
  stopReason: 'stop' | 'length' | 'toolUse';
  usage: AiUsageView;
  model: { provider: string; id: string };
};

export type AiImageResult = {
  ok: true;
  image: { data: string; mimeType: 'image/png' };
  model: { provider: string; id: string };
};

/** First issue of a failed parse, as one sentence naming the field. */
export function aiIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request body';
  const at = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}
