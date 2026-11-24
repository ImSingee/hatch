import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { composerInputSchema } from '~agent/composer-content';
import {
  agentMessageAttachmentIdsSchema,
  agentMessageImagesSchema,
  MAX_BODY_BYTES,
  readCappedJson,
  TOO_LARGE,
} from '~server/agent-message-body';
import {
  cancelPendingMessage,
  updatePendingMessage,
} from '~server/agent-pending-messages';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { errorResponse } from '~server/errors';

/**
 * Each given field replaces that part of the message; an omitted field stays
 * unchanged. `attachmentIds` lists the attachments to keep (only removal is
 * possible), so it restates every one that stays; `[]` removes them all.
 * `mode` switches the message between queue and steer delivery.
 */
const updateBodySchema = z
  .object({
    content: composerInputSchema.optional(),
    images: agentMessageImagesSchema.optional(),
    attachmentIds: agentMessageAttachmentIdsSchema.optional(),
    mode: z.enum(['queue', 'steer']).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.content !== undefined ||
      body.images !== undefined ||
      body.attachmentIds !== undefined ||
      body.mode !== undefined,
    { message: 'Supply at least one field to change.' },
  );

function parseIds(
  request: Request,
): { sessionId: string; messageId: string } | null {
  const match = new URL(request.url).pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/pending\/([^/]+)\/?$/,
  );
  return match
    ? {
        sessionId: decodeURIComponent(match[1]),
        messageId: decodeURIComponent(match[2]),
      }
    : null;
}

export async function patchAgentPendingMessage({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;
  const ids = parseIds(request);
  if (!ids) return new Response('Not found', { status: 404 });

  let parsed: z.infer<typeof updateBodySchema>;
  try {
    const raw = await readCappedJson(request, MAX_BODY_BYTES);
    if (raw === TOO_LARGE) {
      return new Response('Payload too large', { status: 413 });
    }
    parsed = updateBodySchema.parse(raw);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const { mode, ...message } = parsed;
  try {
    return Response.json(await updatePendingMessage({ ...ids, message, mode }));
  } catch (error) {
    // Service errors carry their own status; anything else is ours.
    return errorResponse(error, 500);
  }
}

export async function deleteAgentPendingMessage({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;
  const ids = parseIds(request);
  if (!ids) return new Response('Not found', { status: 404 });
  try {
    return Response.json(await cancelPendingMessage(ids));
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export const Route = createFileRoute(
  '/api/agent/sessions/$sessionId/pending/$messageId',
)({
  server: {
    handlers: {
      PATCH: patchAgentPendingMessage,
      DELETE: deleteAgentPendingMessage,
    },
  },
});
