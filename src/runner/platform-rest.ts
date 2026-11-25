/**
 * PlatformClient implementation: authenticated REST calls to the platform's
 * internal API (see src/server/agent-runner/internal-api.ts for the routes).
 */
import type {
  DownloadedAttachment,
  PlatformClient,
} from '~agent/platform-client';

export function createPlatformRestClient(opts: {
  baseUrl: string;
  token: string;
}): PlatformClient {
  const enc = encodeURIComponent;

  return {
    downloadAttachment: async (sessionId, attachmentId, signal) => {
      const res = await fetch(
        `${opts.baseUrl}/internal/api/agent-sessions/${enc(sessionId)}/` +
          `attachments/${enc(attachmentId)}`,
        {
          headers: { authorization: `Bearer ${opts.token}` },
          ...(signal ? { signal } : {}),
        },
      );
      if (!res.ok) {
        let message = `Attachment download failed (${res.status}).`;
        try {
          const payload = (await res.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // Keep the status-based message for a non-JSON response.
        }
        throw new Error(message);
      }
      const encodedName = res.headers.get('x-attachment-name') ?? '';
      let name = 'attachment';
      try {
        name = decodeURIComponent(encodedName) || name;
      } catch {
        // Invalid metadata cannot make the binary response unusable.
      }
      const body = new Uint8Array(await res.arrayBuffer());
      return {
        id: attachmentId,
        name,
        mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
        size: body.byteLength,
        body,
      } satisfies DownloadedAttachment;
    },
  };
}
