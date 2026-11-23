/**
 * Sending a chat draft again after a lost response, without delivering it
 * twice. Every send of one unchanged draft carries the same
 * `clientMessageId`, so the server returns the first send's outcome instead
 * of a second message or run.
 */
import type { AgentAttachmentRef } from '~agent/attachments';
import { AttachmentInUseError, uploadAgentFiles } from './attachment-api';
import type { ComposerFile, ComposerImage, ComposerSubmit } from './composer';

export type DraftSend = {
  clientMessageId: string;
  /** Attachment id each file was uploaded under by this send, by file id. */
  uploads: Map<string, string>;
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
          uploads: new Map(),
        };
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
 * meanwhile comes back. An upload id already in use was attached by an
 * earlier send: by this one (the same message, which the server recognizes),
 * it is reused; by an earlier version of an edited draft, the file is
 * uploaded again under a new id, since one upload belongs to one message.
 */
export async function uploadDraftFiles(
  sessionId: string,
  files: ComposerFile[],
  send: DraftSend,
): Promise<AgentAttachmentRef[]> {
  const upload = async (file: ComposerFile, id: string) => {
    const [attachment] = await uploadAgentFiles(sessionId, [{ ...file, id }]);
    send.uploads.set(file.id, id);
    return attachment;
  };
  return Promise.all(
    files.map(async (file) => {
      const id = send.uploads.get(file.id) ?? file.id;
      try {
        return await upload(file, id);
      } catch (error) {
        if (!(error instanceof AttachmentInUseError)) throw error;
        if (send.uploads.get(file.id) === id) {
          return {
            id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
          };
        }
        return upload(file, crypto.randomUUID());
      }
    }),
  );
}
