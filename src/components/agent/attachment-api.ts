import type { AgentAttachmentRef } from '~agent/attachments';
import type { ComposerFile } from './composer';

/** The upload's id is taken: in this session, a message already holds it. */
export class AttachmentInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInUseError';
  }
}

export async function uploadAgentFiles(
  sessionId: string,
  files: ComposerFile[],
): Promise<AgentAttachmentRef[]> {
  return Promise.all(
    files.map(async (attachment) => {
      const res = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sessionId)}/attachments/` +
          encodeURIComponent(attachment.id),
        {
          method: 'PUT',
          headers: {
            'content-type': attachment.mimeType,
            'x-attachment-name': encodeURIComponent(attachment.name),
          },
          body: attachment.file,
        },
      );
      if (!res.ok) {
        const message =
          (await res.text()) || `Attachment upload failed (${res.status})`;
        if (res.status === 409) throw new AttachmentInUseError(message);
        throw new Error(message);
      }
      const payload = (await res.json()) as {
        attachment: AgentAttachmentRef;
      };
      return payload.attachment;
    }),
  );
}
