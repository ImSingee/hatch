/**
 * Request bodies of Agent message endpoints (a run start, a pending message):
 * capped JSON reading and the shared message fields.
 */
import { z } from 'zod';
import { composerInputSchema, hasComposerText } from '~agent/composer-content';

/** ~25 MB: comfortably fits the composer's downscaled images plus prose. */
export const MAX_BODY_BYTES = 25_000_000;
/** Matches the composer's MAX_ATTACHMENTS. */
const MAX_IMAGES = 6;
const MAX_ATTACHMENTS = 6;
/** Per-image base64 length cap (~6 MB decoded). */
const MAX_IMAGE_CHARS = 8_000_000;
const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const TOO_LARGE = Symbol('too-large');

/**
 * Read and JSON-parse the body while enforcing a hard byte cap. `request.json()`
 * buffers the entire body before any validation runs, so a large (or lying
 * Content-Length) request could exhaust memory; this rejects early on the
 * declared size and again while streaming so the cap can't be bypassed.
 */
export async function readCappedJson(
  request: Request,
  max: number,
): Promise<unknown | typeof TOO_LARGE> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return TOO_LARGE;

  const body = request.body;
  if (!body) return undefined;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

export function normalizeLegacyUserText(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }

  const body = input as Record<string, unknown>;
  if (!Object.hasOwn(body, 'userText')) return input;

  // Already-open clients send userText instead of content. Ambiguous or
  // malformed transition payloads must fail instead of dropping either field.
  if (Object.hasOwn(body, 'content') || typeof body.userText !== 'string') {
    return undefined;
  }

  const { userText, ...modernBody } = body;
  return {
    ...modernBody,
    content: [{ type: 'text', text: userText }],
  };
}

export const MAX_MESSAGE_FILES = MAX_ATTACHMENTS;

export const agentMessageImagesSchema = z
  .array(
    z.object({
      data: z.string().min(1).max(MAX_IMAGE_CHARS),
      mimeType: z.string().refine((m) => ALLOWED_IMAGE_MIME.has(m), {
        message: 'Unsupported image type.',
      }),
    }),
  )
  .max(MAX_IMAGES);

export const agentMessageAttachmentIdsSchema = z
  .array(z.string().min(1))
  .max(MAX_ATTACHMENTS);

/** Fields of a user message, shared by run starts and pending messages. */
export const agentMessageFields = {
  content: composerInputSchema.default([]),
  images: agentMessageImagesSchema.optional(),
  attachmentIds: agentMessageAttachmentIdsSchema.optional(),
};

type AgentMessageBody = {
  content: z.infer<typeof composerInputSchema>;
  images?: unknown[];
  attachmentIds?: string[];
};

/** A message needs content, and at most MAX_ATTACHMENTS images and files. */
export function refineAgentMessage<T extends z.ZodType<AgentMessageBody>>(
  schema: T,
) {
  return schema
    .refine(
      (body) =>
        hasComposerText(body.content) ||
        (body.images?.length ?? 0) > 0 ||
        (body.attachmentIds?.length ?? 0) > 0,
      { message: 'Message must include text or an attachment.' },
    )
    .refine(
      (body) =>
        (body.images?.length ?? 0) + (body.attachmentIds?.length ?? 0) <=
        MAX_ATTACHMENTS,
      { message: `Message supports at most ${MAX_ATTACHMENTS} attachments.` },
    );
}
