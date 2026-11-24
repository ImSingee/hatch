import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  agentMessageFields,
  clientMessageIdSchema,
  MessageQueuedError,
  MAX_BODY_BYTES,
  normalizeLegacyUserText,
  readCappedJson,
  refineAgentMessage,
  TOO_LARGE,
} from '~server/agent-message-body';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { assertAgentModelAvailable, startAgentRun } from '~server/agent-runs';
import { thinkingLevelSchema } from '~agent/protocol';
import { AppError, errorResponse } from '~server/errors';

const startBodySchema = z.preprocess(
  normalizeLegacyUserText,
  refineAgentMessage(
    z.object({
      sessionId: z.string().min(1),
      retry: z.literal(false).optional(),
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      /** Unset reuses the chat's level, else the model default. */
      thinkingLevel: thinkingLevelSchema.optional(),
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
    thinkingLevel: thinkingLevelSchema.optional(),
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
      return errorResponse(
        new AppError('Payload too large', 413, {
          code: 'agent.payloadTooLarge',
        }),
      );
    }
    parsed = bodySchema.parse(raw);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  try {
    // A level the user picked must suit the model; never swap it silently.
    if (parsed.thinkingLevel)
      await assertAgentModelAvailable(
        parsed.providerId,
        parsed.modelId,
        parsed.thinkingLevel,
      );
    const result = await startAgentRun({ ...parsed, userId: session.user.id });
    return Response.json(result);
  } catch (error) {
    // A resend of a message already waiting in the tray was accepted then.
    if (error instanceof MessageQueuedError) {
      return Response.json({ queued: true });
    }
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
