/**
 * Server-only: safe resends of Agent chat messages.
 *
 * A client names each message it sends with a `clientMessageId`, generated
 * once per draft and reused when it sends the same draft again after a lost
 * response. Starting a run and adding a pending message share one record per
 * session and id, so a resend that reaches either endpoint (the session may
 * have become busy or idle in between) returns the original outcome instead
 * of delivering the message twice or starting a second run.
 *
 * Both endpoints look the receipt up under the session's row lock, which
 * every send already takes; the primary key backs that up.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type DB, type TX } from '~/db';
import type { ComposerInputPart } from '~agent/composer-content';
import type { SendImage } from '~agent/protocol';
import { AppError } from './errors';

export type AgentMessageReceipt =
  typeof schema.agentMessageReceipts.$inferSelect;

/** What makes a resend the same message; the chosen model may change. */
export function messageFingerprint(message: {
  content: ComposerInputPart[];
  images?: SendImage[];
  attachmentIds?: string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.content,
        (message.images ?? []).map((image) => [image.mimeType, image.data]),
        message.attachmentIds ?? [],
      ]),
    )
    .digest('base64url');
}

/**
 * The receipt of an earlier send of this message, if any. A different
 * message under the same id is a client bug, rejected rather than dropped.
 */
export async function findMessageReceipt(
  executor: DB | TX,
  sessionId: string,
  clientMessageId: string,
  fingerprint: string,
): Promise<AgentMessageReceipt | null> {
  const receipt = await executor.query.agentMessageReceipts.findFirst({
    where: { sessionId, clientMessageId },
  });
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) {
    throw new AppError(
      'clientMessageId was already used for a different message.',
      409,
    );
  }
  return receipt;
}

export async function recordMessageReceipt(
  tx: TX,
  receipt: {
    sessionId: string;
    clientMessageId: string;
    fingerprint: string;
    pendingMessageId?: string;
    runId?: string;
  },
): Promise<void> {
  await tx.insert(schema.agentMessageReceipts).values(receipt);
}

/** Pending messages a run delivered (as its prompt or by steering) point at it. */
export async function bindReceiptsToRun(
  tx: TX,
  sessionId: string,
  pendingMessageIds: string[],
  runId: string,
): Promise<void> {
  if (pendingMessageIds.length === 0) return;
  await tx
    .update(schema.agentMessageReceipts)
    .set({ runId })
    .where(
      and(
        eq(schema.agentMessageReceipts.sessionId, sessionId),
        inArray(
          schema.agentMessageReceipts.pendingMessageId,
          pendingMessageIds,
        ),
        isNull(schema.agentMessageReceipts.runId),
      ),
    );
}

/** A cancelled message was never delivered: sending it again is new. */
export async function deletePendingReceipt(
  tx: TX,
  sessionId: string,
  pendingMessageId: string,
): Promise<void> {
  await tx
    .delete(schema.agentMessageReceipts)
    .where(
      and(
        eq(schema.agentMessageReceipts.sessionId, sessionId),
        eq(schema.agentMessageReceipts.pendingMessageId, pendingMessageId),
      ),
    );
}
