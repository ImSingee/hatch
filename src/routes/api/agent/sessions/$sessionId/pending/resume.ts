import { createFileRoute } from '@tanstack/react-router';
import { resumePendingMessages } from '~server/agent-pending-messages';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { errorResponse } from '~server/errors';

function parseSessionId(request: Request): string | null {
  const match = new URL(request.url).pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/pending\/resume\/?$/,
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/** Resume paused delivery; an idle session delivers right away. */
export async function postAgentPendingResume({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;
  const sessionId = parseSessionId(request);
  if (!sessionId) return new Response('Not found', { status: 404 });
  try {
    return Response.json(await resumePendingMessages(sessionId));
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export const Route = createFileRoute(
  '/api/agent/sessions/$sessionId/pending/resume',
)({
  server: {
    handlers: {
      POST: postAgentPendingResume,
    },
  },
});
