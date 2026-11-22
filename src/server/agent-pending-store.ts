/**
 * Server-only: rows of messages sent while an Agent run was working, and the
 * state transitions the run control plane (`~server/agent-runs`) applies to
 * them. User-facing operations live in `~server/agent-pending-messages`.
 *
 * Callers pass a transaction that already holds the session row lock (the
 * lock order is always session, then run), except for plain reads.
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { db, schema, type DB, type TX } from '~/db';
import type {
  AgentMessageMode,
  AgentPendingMessageStatus,
  AgentRunStatus,
  JsonValue,
} from '~/db/schema';
import type { AgentAttachmentRef } from '~agent/attachments';
import {
  composerDisplayText,
  composerModelText,
  hasComposerReference,
  type ComposerInputPart,
} from '~agent/composer-content';
import type { SendImage, SteerMessage } from '~agent/protocol';
import { isSteeredUserMessage } from '~agent/user-turns';

type PendingRow = typeof schema.agentPendingMessages.$inferSelect;

const ACTIVE_RUN_STATUSES: AgentRunStatus[] = ['running', 'blocked'];

/**
 * A Send now that has not started its run after this long is treated as
 * abandoned (the process stopped mid-way), so the message is editable again.
 */
export const PENDING_SENDING_STALE_MS = 2 * 60_000;

/** A pending message as the chat tray shows it. */
export type AgentPendingMessage = {
  id: string;
  mode: AgentMessageMode;
  /**
   * `pending` can be edited, cancelled or sent now; `claimed` is being
   * handed to the running run; `sending` is starting its own run.
   */
  status: 'pending' | 'claimed' | 'sending';
  content: ComposerInputPart[];
  /** Display text (resource mentions as `@name`). */
  text: string;
  images: SendImage[];
  attachments: AgentAttachmentRef[];
  providerId: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
};

/** The tray: undelivered messages in send order, and whether it is paused. */
export type SessionPendingMessages = {
  paused: boolean;
  messages: AgentPendingMessage[];
};

export type EffectivePendingStatus = AgentPendingMessageStatus | 'delivered';

/**
 * A row's status once the run it was handed to is taken into account. A
 * claim or injection only holds while that run is active: once it settled
 * without persisting the message, the message is the user's again.
 * `delivered` is an injected message of the active run (shown in its reply).
 */
export function effectivePendingStatus(
  row: Pick<PendingRow, 'status' | 'updatedAt'>,
  claimedRunStatus: AgentRunStatus | null,
  now = Date.now(),
): EffectivePendingStatus {
  if (row.status === 'claimed' || row.status === 'injected') {
    if (!claimedRunStatus || !ACTIVE_RUN_STATUSES.includes(claimedRunStatus)) {
      return 'pending';
    }
    return row.status === 'injected' ? 'delivered' : 'claimed';
  }
  if (
    row.status === 'sending' &&
    now - row.updatedAt.getTime() > PENDING_SENDING_STALE_MS
  ) {
    return 'pending';
  }
  return row.status;
}

export type PendingRowWithRun = PendingRow & {
  claimedRunStatus: AgentRunStatus | null;
};

/** Every row of the session, oldest first, with its claiming run's status. */
export async function loadPendingRows(
  executor: DB | TX,
  sessionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PendingRowWithRun[]> {
  const query = executor
    .select({
      row: schema.agentPendingMessages,
      claimedRunStatus: schema.agentRuns.status,
    })
    .from(schema.agentPendingMessages)
    .leftJoin(
      schema.agentRuns,
      eq(schema.agentRuns.id, schema.agentPendingMessages.claimedRunId),
    )
    .where(eq(schema.agentPendingMessages.sessionId, sessionId))
    .orderBy(asc(schema.agentPendingMessages.id));
  const rows = options.forUpdate
    ? await query.for('update', { of: schema.agentPendingMessages })
    : await query;
  return rows.map(({ row, claimedRunStatus }) => ({
    ...row,
    claimedRunStatus: claimedRunStatus ?? null,
  }));
}

function asParts(value: JsonValue[]): ComposerInputPart[] {
  return value as unknown as ComposerInputPart[];
}

export function pendingRowContent(row: PendingRow): {
  content: ComposerInputPart[];
  images: SendImage[];
  attachments: AgentAttachmentRef[];
} {
  return {
    content: asParts(row.content),
    images: row.images as unknown as SendImage[],
    attachments: row.attachments as unknown as AgentAttachmentRef[],
  };
}

export function toPendingMessageView(
  row: PendingRowWithRun,
  now = Date.now(),
): AgentPendingMessage | null {
  const status = effectivePendingStatus(row, row.claimedRunStatus, now);
  if (status === 'delivered' || status === 'injected') return null;
  const { content, images, attachments } = pendingRowContent(row);
  return {
    id: row.id,
    mode: row.mode,
    status,
    content,
    text: composerDisplayText(content),
    images,
    attachments,
    providerId: row.providerId,
    modelId: row.modelId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSessionPendingMessages(
  sessionId: string,
  executor: DB | TX = db,
): Promise<SessionPendingMessages> {
  const [session, rows] = await Promise.all([
    executor.query.agentSessions.findFirst({
      where: { id: sessionId },
      columns: { pendingPaused: true },
    }),
    loadPendingRows(executor, sessionId),
  ]);
  const now = Date.now();
  const messages = rows
    .map((row) => toPendingMessageView(row, now))
    .filter((message) => message !== null);
  return {
    // A pause only matters while something waits behind it.
    paused: messages.length > 0 && (session?.pendingPaused ?? false),
    messages,
  };
}

/** The message as the Runner injects it into a running run. */
export function toSteerMessage(row: PendingRow): SteerMessage {
  const { content, images, attachments } = pendingRowContent(row);
  return {
    id: row.id,
    userText: composerModelText(content),
    composerContent: hasComposerReference(content) ? content : [],
    images,
    attachments,
  };
}

/** Ids of pending messages a transcript holds as steered user messages. */
export function steeredPendingMessageIds(messages: unknown[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!isSteeredUserMessage(message)) continue;
    const id = (message as { pendingMessageId?: unknown }).pendingMessageId;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * Settle the messages a finished run claimed. Those its persisted transcript
 * holds are delivered and removed; the rest return to the tray. A transcript
 * that was not persisted (`null`) delivered nothing.
 */
export async function settleRunPendingMessages(
  tx: TX,
  sessionId: string,
  runId: string,
  persisted: unknown[] | null,
): Promise<void> {
  const delivered = persisted ? steeredPendingMessageIds(persisted) : [];
  if (delivered.length > 0) {
    // Whatever their status: a late report can deliver a message the tray
    // already got back after the run was stopped.
    await tx
      .delete(schema.agentPendingMessages)
      .where(
        and(
          eq(schema.agentPendingMessages.sessionId, sessionId),
          inArray(schema.agentPendingMessages.id, delivered),
        ),
      );
  }
  await tx
    .update(schema.agentPendingMessages)
    .set({ status: 'pending', claimedRunId: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentPendingMessages.sessionId, sessionId),
        eq(schema.agentPendingMessages.claimedRunId, runId),
      ),
    );
}

/**
 * Return claims of runs that are no longer active to the tray. A new run
 * makes every older transcript stale, so nothing those runs claimed can be
 * delivered by them anymore.
 */
export async function releaseSettledClaims(
  tx: TX,
  sessionId: string,
): Promise<void> {
  const active = tx
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.sessionId, sessionId),
        inArray(schema.agentRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );
  await tx
    .update(schema.agentPendingMessages)
    .set({ status: 'pending', claimedRunId: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentPendingMessages.sessionId, sessionId),
        inArray(schema.agentPendingMessages.status, ['claimed', 'injected']),
        or(
          isNull(schema.agentPendingMessages.claimedRunId),
          notInArray(schema.agentPendingMessages.claimedRunId, active),
        ),
      ),
    );
}

/** Hand every waiting steer message to the active run, in send order. */
export async function claimSteerRows(
  tx: TX,
  sessionId: string,
  runId: string,
): Promise<PendingRow[]> {
  const rows = await loadPendingRows(tx, sessionId, { forUpdate: true });
  const now = Date.now();
  const claimable = rows.filter(
    (row) =>
      row.mode === 'steer' &&
      effectivePendingStatus(row, row.claimedRunStatus, now) === 'pending',
  );
  if (claimable.length === 0) return [];
  await tx
    .update(schema.agentPendingMessages)
    .set({ status: 'claimed', claimedRunId: runId, updatedAt: new Date() })
    .where(
      inArray(
        schema.agentPendingMessages.id,
        claimable.map((row) => row.id),
      ),
    );
  return claimable;
}

/** The injected message is in the run's context now (hidden from the tray). */
export async function markPendingMessageInjected(
  executor: DB | TX,
  runId: string,
  pendingId: string,
): Promise<void> {
  await executor
    .update(schema.agentPendingMessages)
    .set({ status: 'injected', updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentPendingMessages.id, pendingId),
        eq(schema.agentPendingMessages.claimedRunId, runId),
        eq(schema.agentPendingMessages.status, 'claimed'),
      ),
    );
}

/** True when an undelivered message waits in the session. */
export async function hasPendingMessages(
  executor: DB | TX,
  sessionId: string,
): Promise<boolean> {
  const rows = await loadPendingRows(executor, sessionId);
  const now = Date.now();
  return rows.some((row) => {
    const status = effectivePendingStatus(row, row.claimedRunStatus, now);
    return status !== 'delivered' && status !== 'injected';
  });
}

/** True when a steer message waits to be claimed by the active run. */
export async function hasClaimableSteer(
  executor: DB | TX,
  sessionId: string,
): Promise<boolean> {
  const rows = await loadPendingRows(executor, sessionId);
  const now = Date.now();
  return rows.some(
    (row) =>
      row.mode === 'steer' &&
      effectivePendingStatus(row, row.claimedRunStatus, now) === 'pending',
  );
}

export async function setPendingPaused(
  tx: TX,
  sessionId: string,
  paused: boolean,
): Promise<void> {
  await tx
    .update(schema.agentSessions)
    // Not a transcript change: keep the Retry revision and the list order.
    .set({
      pendingPaused: paused,
      updatedAt: sql`${schema.agentSessions.updatedAt}`,
    })
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        sql`${schema.agentSessions.pendingPaused} is distinct from ${paused}`,
      ),
    );
}
