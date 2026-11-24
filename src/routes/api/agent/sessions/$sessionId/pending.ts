import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  agentMessageFields,
  clientMessageIdSchema,
  MAX_BODY_BYTES,
  readCappedJson,
  refineAgentMessage,
  TOO_LARGE,
} from '~server/agent-message-body';
import {
  enqueuePendingMessage,
  getPendingMessages,
} from '~server/agent-pending-messages';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { errorResponse } from '~server/errors';

const enqueueBodySchema = refineAgentMessage(
  z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    /** Reused when resending the same draft; see agent-message-receipts. */
    clientMessageId: clientMessageIdSchema.optional(),
    /** Delivery for this message; the sender's preference when omitted. */
    mode: z.enum(['queue', 'steer']).optional(),
    ...agentMessageFields,
  }),
);

function parseSessionId(request: Request): string | null {
  const match = new URL(request.url).pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/pending\/?$/,
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/** The session's undelivered messages and whether delivery is paused. */
export async function getAgentPendingMessages({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;
  const sessionId = parseSessionId(request);
  if (!sessionId) return new Response('Not found', { status: 404 });
  try {
    return Response.json(await getPendingMessages(sessionId));
  } catch (error) {
    return errorResponse(error, 500);
  }
}

/**
 * Send a message while the session's run is working, in the given
 * queue/steer mode or the user's preferred one. An idle session delivers it right away
 * (`startedRunId`).
 */
export async function postAgentPendingMessage({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;
  const sessionId = parseSessionId(request);
  if (!sessionId) return new Response('Not found', { status: 404 });

  let parsed: z.infer<typeof enqueueBodySchema>;
  try {
    const raw = await readCappedJson(request, MAX_BODY_BYTES);
    if (raw === TOO_LARGE) {
      return new Response('Payload too large', { status: 413 });
    }
    parsed = enqueueBodySchema.parse(raw);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  try {
    const { providerId, modelId, clientMessageId, mode, ...message } = parsed;
    return Response.json(
      await enqueuePendingMessage({
        sessionId,
        userId: session.user.id,
        providerId,
        modelId,
        message,
        mode,
        clientMessageId,
      }),
    );
  } catch (error) {
    // Service errors carry their own status; anything else is ours.
    return errorResponse(error, 500);
  }
}

export const Route = createFileRoute('/api/agent/sessions/$sessionId/pending')({
  server: {
    handlers: {
      GET: getAgentPendingMessages,
      POST: postAgentPendingMessage,
    },
  },
});
