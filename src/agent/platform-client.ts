/**
 * The Agent Runner's view of the platform for tool operations that are not
 * public business RPCs. Platform capabilities go through the `hatch` CLI with
 * the Run credential instead. The runner implements this interface with
 * authenticated REST calls to the platform's internal API; tests can stub it.
 *
 * Only `import type` from server modules here — the runner bundle must never
 * pull in platform code (database client, deploy pipeline, …).
 */

export type DownloadedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  body: Uint8Array;
};

export type PlatformClient = {
  downloadAttachment(
    sessionId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<DownloadedAttachment>;
};
