/**
 * Sending a chat draft again after a lost response, without delivering it
 * twice. Every send of one unchanged draft carries the same
 * `clientMessageId`, so the server returns the first send's outcome instead
 * of a second message or run, and files an earlier attempt uploaded (which
 * that send may have attached) are not uploaded again.
 */
import type { AgentAttachmentRef } from '~agent/attachments';
import { uploadAgentFiles } from './attachment-api';
import type { ComposerFile, ComposerImage, ComposerSubmit } from './composer';

export type DraftSend = {
  clientMessageId: string;
  /** Uploaded files of this draft, by composer file id. */
  uploaded: Map<string, AgentAttachmentRef>;
};

type Draft = {
  content: ComposerSubmit['content'];
  images: ComposerImage[];
  files: ComposerFile[];
};

export type DraftSendTracker = {
  /** The send for this draft: the same one while the draft is unchanged. */
  begin(sessionId: string, draft: Draft): DraftSend;
  /** The draft was accepted: whatever is sent next is a new message. */
  settle(send: DraftSend): void;
};

export function createDraftSendTracker(): DraftSendTracker {
  let current: (DraftSend & { key: string }) | null = null;
  return {
    begin(sessionId, draft) {
      const key = JSON.stringify([
        sessionId,
        draft.content,
        draft.images,
        draft.files.map((file) => file.id),
      ]);
      if (current?.key !== key) {
        current = {
          key,
          clientMessageId: crypto.randomUUID(),
          uploaded: new Map(),
        };
      }
      return current;
    },
    settle(send) {
      if (current?.clientMessageId === send.clientMessageId) current = null;
    },
  };
}

/** Upload the draft's files that no earlier attempt uploaded. */
export async function uploadDraftFiles(
  sessionId: string,
  files: ComposerFile[],
  send: DraftSend,
): Promise<AgentAttachmentRef[]> {
  const missing = files.filter((file) => !send.uploaded.has(file.id));
  const uploaded = await uploadAgentFiles(sessionId, missing);
  uploaded.forEach((attachment, index) =>
    send.uploaded.set(missing[index].id, attachment),
  );
  return files.map((file) => send.uploaded.get(file.id)!);
}
