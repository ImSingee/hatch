import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  agentMessageFields,
  clientMessageIdSchema,
  MAX_BODY_BYTES,
  normalizeLegacyUserText,
  readCappedJson,
  refineAgentMessage,
  TOO_LARGE,
} from '~server/agent-message-body';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { startAgentRun } from '~server/agent-runs';
import { errorResponse } from '~server/errors';

const startBodySchema = z.preprocess(
  normalizeLegacyUserText,
  refineAgentMessage(
    z.object({
      sessionId: z.string().min(1),
      retry: z.literal(false).optional(),
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      /** Reused when resending the same draft; see agent-message-receipts. */
      clientMessageId: clientMessageIdSchema.optional(),
      ...agentMessageFields,
    }),
  ),
);

// Retry is deliberately a separate, strict shape. The server reconstructs the
// prompt, images, and transcript boundary from the persisted session, while
// the client supplies the model currently selected in the composer and the
// exact session revision whose error the user chose to retry.
const retryBodySchema = z
  .object({
    sessionId: z.string().min(1),
    retry: z.literal(true),
    expectedSessionUpdatedAt: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();

const bodySchema = z.union([retryBodySchema, startBodySchema]);

export async function postAgentRun({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;

  let parsed: z.infer<typeof bodySchema>;
  try {
    const raw = await readCappedJson(request, MAX_BODY_BYTES);
    if (raw === TOO_LARGE) {
      return new Response('Payload too large', { status: 413 });
    }
    parsed = bodySchema.parse(raw);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  try {
    const result = await startAgentRun({ ...parsed, userId: session.user.id });
    return Response.json(result);
  } catch (error) {
    // AppError carries its own status (409 for an already-running turn,
    // 404 for a missing session); anything untagged is a bad request.
    return errorResponse(error, 400);
  }
}

export const Route = createFileRoute('/api/agent/runs')({
  server: {
    handlers: {
      POST: postAgentRun,
    },
  },
});
