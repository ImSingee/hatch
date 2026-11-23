/**
 * Sending a chat draft again after a lost response, without delivering it
 * twice. Every send of one unchanged draft carries the same
 * `clientMessageId`, so the server returns the first send's outcome instead
 * of a second message or run.
 */
import type { AgentAttachmentRef } from '~agent/attachments';
import { AttachmentInUseError, uploadAgentFiles } from './attachment-api';
import type { ComposerFile, ComposerImage, ComposerSubmit } from './composer';

export type DraftSend = { clientMessageId: string };

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
        current = { key, clientMessageId: crypto.randomUUID() };
      }
      return current;
    },
    settle(send) {
      if (current?.clientMessageId === send.clientMessageId) current = null;
    },
  };
}

/**
 * Upload the draft's files on every attempt, so an upload the server pruned
 * meanwhile comes back. Composer file ids are unique, so an id a message in
 * this session already holds was attached by an earlier send of this draft,
 * whose resend the server recognizes.
 */
export async function uploadDraftFiles(
  sessionId: string,
  files: ComposerFile[],
): Promise<AgentAttachmentRef[]> {
  return Promise.all(
    files.map(async (file) => {
      try {
        const [attachment] = await uploadAgentFiles(sessionId, [file]);
        return attachment;
      } catch (error) {
        if (!(error instanceof AttachmentInUseError)) throw error;
        return {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
        };
      }
    }),
  );
}
