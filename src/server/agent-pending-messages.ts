/**
 * Server-only: messages a user sends while an Agent run is working.
 *
 * The user's preference picks how each one is delivered:
 *   - `queue`: after the run completes, each queued message starts its own
 *     run, one at a time and in send order;
 *   - `steer`: the running run's Runner claims every waiting steer message at
 *     its next tool-call boundary and injects them together; whatever is
 *     still waiting when the run ends is delivered together as the next run.
 *
 * Messages stay editable and cancellable until they are claimed or start a
 * run. Send now stops the active run (its tools too) and starts a run with
 * that message. A user Stop or a run that failed for good pauses delivery
 * until the user resumes it or sends a message now.
 *
 * Delivery itself is part of the run lifecycle (`~server/agent-runs`); every
 * operation here is serialized with it per session.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema, type DB, type TX } from '~/db';
import type { JsonValue } from '~/db/schema';
import type { AgentAttachmentRef } from '~agent/attachments';
import {
  hasComposerText,
  type ComposerInputPart,
} from '~agent/composer-content';
import type { SendImage } from '~agent/protocol';
import {
  effectivePendingStatus,
  listSessionPendingMessages,
  loadPendingRows,
  pendingRowContent,
  setPendingPaused,
  type SessionPendingMessages,
} from './agent-pending-store';
import { MAX_MESSAGE_FILES } from './agent-message-body';
import { readAgentPreferences } from './agent-preferences';
import {
  assertAgentModelAvailable,
  cancelAgentRun,
  dispatchPendingMessages,
  enqueuePendingTask,
  getActiveAgentRun,
  kickPendingDispatch,
  notifyActiveRunOfSteer,
  startAgentRun,
} from './agent-runs';
import {
  deletePendingReceipt,
  findMessageReceipt,
  messageFingerprint,
  recordMessageReceipt,
} from './agent-message-receipts';
import { AppError } from './errors';

export type PendingMessageInput = {
  content: ComposerInputPart[];
  images?: SendImage[];
  attachmentIds?: string[];
};

/** A run an earlier send of a message started, while it is still active. */
async function activeRunOf(executor: DB | TX, runId: string | null) {
  if (!runId) return null;
  const run = await executor.query.agentRuns.findFirst({
    where: { id: runId, status: { in: ['running', 'blocked'] } },
    columns: { id: true },
  });
  return run?.id ?? null;
}

/** The tray after an operation, and the run it started, if any. */
export type PendingMessagesResult = {
  pending: SessionPendingMessages;
  startedRunId: string | null;
};

const NOT_EDITABLE = 'This message is already being delivered.';

async function lockSession(tx: TX, sessionId: string): Promise<void> {
  const [session] = await tx
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .for('update');
  if (!session) throw new AppError('Session not found.', 404);
}

/** Lock a message that is still the user's to change. */
async function lockEditable(tx: TX, sessionId: string, messageId: string) {
  await lockSession(tx, sessionId);
  const rows = await loadPendingRows(tx, sessionId, { forUpdate: true });
  const row = rows.find((candidate) => candidate.id === messageId);
  if (!row) throw new AppError('Pending message not found.', 404);
  if (effectivePendingStatus(row, row.claimedRunStatus) !== 'pending') {
    throw new AppError(NOT_EDITABLE, 409);
  }
  return row;
}

/** Return attachments to the unattached state (pruned like any upload). */
async function releaseAttachments(
  tx: TX,
  sessionId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(schema.agentAttachments)
    .set({ attachedAt: null })
    .where(
      and(
        eq(schema.agentAttachments.sessionId, sessionId),
        inArray(schema.agentAttachments.id, ids),
      ),
    );
}

async function result(
  sessionId: string,
  startedRunId: string | null = null,
): Promise<PendingMessagesResult> {
  return {
    pending: await listSessionPendingMessages(sessionId),
    startedRunId,
  };
}

/**
 * Add a message in the sender's preferred mode. When the session is idle
 * (and not paused) it is delivered right away.
 *
 * With a `clientMessageId`, a resend of a message sent before (to this
 * endpoint or as a run start) adds nothing and returns the current tray, with
 * the run that message started while it is still active.
 */
export async function enqueuePendingMessage(input: {
  sessionId: string;
  userId: string;
  providerId: string;
  modelId: string;
  message: PendingMessageInput;
  clientMessageId?: string;
}): Promise<PendingMessagesResult> {
  const receiptKey = input.clientMessageId
    ? {
        clientMessageId: input.clientMessageId,
        fingerprint: messageFingerprint(input.message),
      }
    : null;
  // The message is already in. An idle session's earlier send may have
  // failed before delivering it, so delivery is resumed (it adds nothing).
  const replay = async (runId: string | null) => {
    const started = await dispatchPendingMessages(input.sessionId);
    return result(
      input.sessionId,
      (await activeRunOf(db, runId)) ?? started?.runId ?? null,
    );
  };
  return enqueuePendingTask(input.sessionId, async () => {
    // Before the checks only a new message must pass (its model may have
    // been disabled since the first send).
    if (receiptKey) {
      const receipt = await findMessageReceipt(
        db,
        input.sessionId,
        receiptKey.clientMessageId,
        receiptKey.fingerprint,
      );
      if (receipt) return replay(receipt.runId);
    }
    await assertAgentModelAvailable(input.providerId, input.modelId);
    const { messageMode: mode } = await readAgentPreferences(input.userId);
    const replayed = await db.transaction(async (tx) => {
      await lockSession(tx, input.sessionId);
      if (receiptKey) {
        const receipt = await findMessageReceipt(
          tx,
          input.sessionId,
          receiptKey.clientMessageId,
          receiptKey.fingerprint,
        );
        if (receipt) return { runId: receipt.runId };
      }
      const attachmentIds = [...new Set(input.message.attachmentIds ?? [])];
      const rows =
        attachmentIds.length > 0
          ? await tx
              .select()
              .from(schema.agentAttachments)
              .where(
                and(
                  eq(schema.agentAttachments.sessionId, input.sessionId),
                  inArray(schema.agentAttachments.id, attachmentIds),
                ),
              )
              .for('update')
          : [];
      if (rows.length !== attachmentIds.length) {
        throw new AppError('One or more attachments were not found.', 404);
      }
      if (rows.some((row) => row.attachedAt != null)) {
        throw new AppError(
          'One or more attachments are already attached.',
          409,
        );
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      const attachments = attachmentIds.map((id) => {
        const row = byId.get(id)!;
        return {
          id: row.id,
          name: row.name,
          mimeType: row.contentType,
          size: row.size,
        } satisfies AgentAttachmentRef;
      });
      if (attachmentIds.length > 0) {
        // Committed to this message: never pruned, never reused elsewhere.
        await tx
          .update(schema.agentAttachments)
          .set({ attachedAt: new Date() })
          .where(inArray(schema.agentAttachments.id, attachmentIds));
      }
      const [inserted] = await tx
        .insert(schema.agentPendingMessages)
        .values({
          sessionId: input.sessionId,
          userId: input.userId,
          mode,
          content: input.message.content as unknown as JsonValue[],
          images: (input.message.images ?? []) as unknown as JsonValue[],
          attachments: attachments as unknown as JsonValue[],
          providerId: input.providerId,
          modelId: input.modelId,
        })
        .returning({ id: schema.agentPendingMessages.id });
      if (receiptKey) {
        await recordMessageReceipt(tx, {
          sessionId: input.sessionId,
          ...receiptKey,
          pendingMessageId: inserted.id,
        });
      }
      return null;
    });
    if (replayed) return replay(replayed.runId);
    if (mode === 'steer') await notifyActiveRunOfSteer(input.sessionId);
    const started = await dispatchPendingMessages(input.sessionId);
    return result(input.sessionId, started?.runId ?? null);
  });
}

/**
 * Change a waiting message. Each given field replaces that part; an omitted
 * field stays unchanged. Attachments can only be removed (`attachmentIds`
 * lists the ones to keep); removed ones are released.
 */
export async function updatePendingMessage(input: {
  sessionId: string;
  messageId: string;
  message: Partial<PendingMessageInput>;
}): Promise<PendingMessagesResult> {
  return enqueuePendingTask(input.sessionId, async () => {
    await db.transaction(async (tx) => {
      const row = await lockEditable(tx, input.sessionId, input.messageId);
      const current = pendingRowContent(row);
      const content = input.message.content ?? current.content;
      const images = input.message.images ?? current.images;
      const keep = new Set(
        input.message.attachmentIds ??
          current.attachments.map((attachment) => attachment.id),
      );
      const currentIds = new Set(
        current.attachments.map((attachment) => attachment.id),
      );
      if ([...keep].some((id) => !currentIds.has(id))) {
        throw new AppError(
          'An edit can only remove attachments, not add them.',
          400,
        );
      }
      const kept = current.attachments.filter((attachment) =>
        keep.has(attachment.id),
      );
      if (
        !hasComposerText(content) &&
        images.length === 0 &&
        kept.length === 0
      ) {
        throw new AppError(
          'Message must include text or an attachment. Cancel it instead.',
          400,
        );
      }
      if (images.length + kept.length > MAX_MESSAGE_FILES) {
        throw new AppError(
          `Message supports at most ${MAX_MESSAGE_FILES} attachments.`,
          400,
        );
      }
      await releaseAttachments(
        tx,
        input.sessionId,
        current.attachments
          .filter((attachment) => !keep.has(attachment.id))
          .map((attachment) => attachment.id),
      );
      await tx
        .update(schema.agentPendingMessages)
        .set({
          status: 'pending',
          claimedRunId: null,
          content: content as unknown as JsonValue[],
          images: images as unknown as JsonValue[],
          attachments: kept as unknown as JsonValue[],
          updatedAt: new Date(),
        })
        .where(eq(schema.agentPendingMessages.id, input.messageId));
    });
    return result(input.sessionId);
  });
}

/** Drop a waiting message and release its attachments. */
export async function cancelPendingMessage(input: {
  sessionId: string;
  messageId: string;
}): Promise<PendingMessagesResult> {
  return enqueuePendingTask(input.sessionId, async () => {
    await db.transaction(async (tx) => {
      const row = await lockEditable(tx, input.sessionId, input.messageId);
      await releaseAttachments(
        tx,
        input.sessionId,
        pendingRowContent(row).attachments.map((attachment) => attachment.id),
      );
      await tx
        .delete(schema.agentPendingMessages)
        .where(eq(schema.agentPendingMessages.id, input.messageId));
      await deletePendingReceipt(tx, input.sessionId, input.messageId);
    });
    return result(input.sessionId);
  });
}

/**
 * Stop the active run, if any (its tool calls are aborted, and its partial
 * reply is kept), then start a run with this message. The other waiting
 * messages keep their place and delivery resumes.
 */
export async function sendPendingMessageNow(input: {
  sessionId: string;
  messageId: string;
  userId: string;
}): Promise<PendingMessagesResult> {
  return enqueuePendingTask(input.sessionId, async () => {
    const row = await db.transaction(async (tx) => {
      const locked = await lockEditable(tx, input.sessionId, input.messageId);
      // While `sending`, no other delivery starts in this session.
      await tx
        .update(schema.agentPendingMessages)
        .set({ status: 'sending', claimedRunId: null, updatedAt: new Date() })
        .where(eq(schema.agentPendingMessages.id, input.messageId));
      return locked;
    });
    try {
      const active = await getActiveAgentRun(input.sessionId);
      if (active) await cancelAgentRun(active.id, { pausePending: false });
      const { runId } = await startAgentRun({
        sessionId: input.sessionId,
        pendingMessageIds: [input.messageId],
        providerId: row.providerId,
        modelId: row.modelId,
        userId: input.userId,
      });
      return result(input.sessionId, runId);
    } catch (error) {
      await db
        .update(schema.agentPendingMessages)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(
          and(
            eq(schema.agentPendingMessages.id, input.messageId),
            eq(schema.agentPendingMessages.status, 'sending'),
          ),
        );
      // The message is waiting again, possibly behind an idle session.
      kickPendingDispatch(input.sessionId);
      throw error;
    }
  });
}

/** Resume paused delivery; delivers right away when the session is idle. */
export async function resumePendingMessages(
  sessionId: string,
): Promise<PendingMessagesResult> {
  return enqueuePendingTask(sessionId, async () => {
    await db.transaction(async (tx) => {
      await lockSession(tx, sessionId);
      await setPendingPaused(tx, sessionId, false);
    });
    const started = await dispatchPendingMessages(sessionId);
    return result(sessionId, started?.runId ?? null);
  });
}

export async function getPendingMessages(
  sessionId: string,
): Promise<SessionPendingMessages> {
  const session = await db.query.agentSessions.findFirst({
    where: { id: sessionId },
    columns: { id: true },
  });
  if (!session) throw new AppError('Session not found.', 404);
  return listSessionPendingMessages(sessionId);
}
