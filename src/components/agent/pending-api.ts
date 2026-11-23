/** Browser requests for messages sent while an Agent run works. */
import type { ComposerInputPart } from '~agent/composer-content';
import type {
  AgentPendingMessage,
  SessionPendingMessages,
} from '~server/agent-pending-store';
import type { SendImage } from './use-agent-stream';

export type { AgentPendingMessage, SessionPendingMessages };

/** The tray after an operation, and the run it started, if any. */
export type PendingMessagesResult = {
  pending: SessionPendingMessages;
  startedRunId: string | null;
};

async function request(
  path: string,
  init: { method: string; body?: unknown },
): Promise<PendingMessagesResult> {
  const res = await fetch(path, {
    method: init.method,
    ...(init.body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(init.body),
        }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Request failed (${res.status})`);
  }
  return (await res.json()) as PendingMessagesResult;
}

const base = (sessionId: string) =>
  `/api/agent/sessions/${encodeURIComponent(sessionId)}/pending`;

const item = (sessionId: string, messageId: string) =>
  `${base(sessionId)}/${encodeURIComponent(messageId)}`;

/** Send a message while the run works, in the user's queue/steer mode. */
export function enqueuePendingMessage(
  sessionId: string,
  message: {
    content: ComposerInputPart[];
    images: SendImage[];
    attachmentIds: string[];
    providerId: string;
    modelId: string;
    /** Reused when resending the same draft (see `./draft-send`). */
    clientMessageId: string;
  },
) {
  return request(base(sessionId), { method: 'POST', body: message });
}

/** Change a waiting message; omitted fields stay as they are. */
export function updatePendingMessage(
  sessionId: string,
  messageId: string,
  changes: {
    content?: ComposerInputPart[];
    images?: SendImage[];
    attachmentIds?: string[];
  },
) {
  return request(item(sessionId, messageId), {
    method: 'PATCH',
    body: changes,
  });
}

export function cancelPendingMessage(sessionId: string, messageId: string) {
  return request(item(sessionId, messageId), { method: 'DELETE' });
}

/** Stop the active run and start one with this message. */
export function sendPendingMessageNow(sessionId: string, messageId: string) {
  return request(`${item(sessionId, messageId)}/send-now`, { method: 'POST' });
}

export function resumePendingMessages(sessionId: string) {
  return request(`${base(sessionId)}/resume`, { method: 'POST' });
}
