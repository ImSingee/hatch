import { createFileRoute } from '@tanstack/react-router';
import { sendPendingMessageNow } from '~server/agent-pending-messages';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { errorResponse } from '~server/errors';

function parseIds(
  request: Request,
): { sessionId: string; messageId: string } | null {
  const match = new URL(request.url).pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/pending\/([^/]+)\/send-now\/?$/,
  );
  return match
    ? {
        sessionId: decodeURIComponent(match[1]),
        messageId: decodeURIComponent(match[2]),
      }
    : null;
}

/**
 * Stop the session's active run (its tool calls too) and start a run with
 * this pending message (`startedRunId`).
 */
export async function postAgentPendingSendNow({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;
  const ids = parseIds(request);
  if (!ids) return new Response('Not found', { status: 404 });
  try {
    return Response.json(
      await sendPendingMessageNow({ ...ids, userId: session.user.id }),
    );
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export const Route = createFileRoute(
  '/api/agent/sessions/$sessionId/pending/$messageId/send-now',
)({
  server: {
    handlers: {
      POST: postAgentPendingSendNow,
    },
  },
});
