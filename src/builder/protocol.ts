/**
 * The Platform/Builder protocol: HTTP calls from the Builder to the
 * platform's internal server, authenticated by HATCH_BUILDER_TOKEN. The
 * Builder pulls work, so the platform keeps no connection to it and may run
 * as several instances.
 *
 *   POST /internal/api/builds/lease          {builderId, protocolVersion,
 *                                             concurrency?}
 *        -> {build: {id, appId, commit, token, sdkDigest} | null}
 *        Waits up to LEASE_WAIT_MS for a queued build. Lease requests and
 *        heartbeats are how the platform knows a Builder is online
 *        (src/server/apps/builders.ts); `concurrency` is shown there.
 *   GET  /internal/api/builds/:id/source     -> the commit as .tar.gz
 *        Streamed without a length; a failure while streaming resets the
 *        connection. A source over the platform's budget is refused first
 *        (413 {error}, see SOURCE_TREE_BUDGET in src/server/source-git.ts).
 *   POST /internal/api/builds/:id/heartbeat  -> {continue: boolean}
 *   POST /internal/api/builds/:id/logs       {lines: string[]}
 *        At most LOG_BATCH_MAX_LINES lines and LOG_BATCH_MAX_BYTES of JSON.
 *   PUT  /internal/api/builds/:id/artifact   the build package (.tar.gz)
 *        -> {status, errorCode, errorMessage}
 *   POST /internal/api/builds/:id/fail       {message, code?}
 *        code: `app_build_failed` (default) or `APP_MANIFEST_INVALID`.
 *        message: at most FAILURE_MESSAGE_MAX_CHARS characters.
 *
 * A call made under a lease that has since moved on (canceled, superseded,
 * expired and leased again) gets 409 {error: 'build_not_leased'}.
 *
 * Every call after the lease sends the lease token as `x-hatch-build-token`.
 */
export const BUILDER_PROTOCOL_VERSION = 1;
export const BUILDER_API_PREFIX = '/internal/api/builds';
export const BUILD_TOKEN_HEADER = 'x-hatch-build-token';
/** How long a lease request waits for queued work. */
export const LEASE_WAIT_MS = 25_000;
/** How often a Builder renews the lease of a running build. */
export const HEARTBEAT_MS = 15_000;
/** How often a Builder flushes build output. */
export const LOG_FLUSH_MS = 1_000;
/** Limits of one logs call, shared by the Builder and the platform. */
export const LOG_BATCH_MAX_LINES = 5_000;
export const LOG_BATCH_MAX_BYTES = 1024 * 1024;
/** Longest build log line kept; longer lines are cut (both sides). */
export const LOG_LINE_MAX_CHARS = 16_000;
/** Longest failure message the platform takes (UTF-16 code units). */
export const FAILURE_MESSAGE_MAX_CHARS = 64_000;

/**
 * `message` as a failure report can carry it: unchanged when it fits,
 * otherwise its start and its end (where tools tend to put the error), with
 * a line between them saying how much was left out of the report.
 */
export function boundFailureMessage(message: string): string {
  if (message.length <= FAILURE_MESSAGE_MAX_CHARS) return message;
  const gap = (omitted: number) =>
    `\n[builder] … ${omitted} characters left out here; see the build ` +
    'log for the whole message …\n';
  // No gap is longer than one that leaves out the whole message.
  const room = FAILURE_MESSAGE_MAX_CHARS - gap(message.length).length;
  let head = Math.ceil(room / 2);
  let tail = message.length - (room - head);
  // Never split a surrogate pair.
  if (/[\ud800-\udbff]/.test(message[head - 1]!)) head -= 1;
  if (/[\udc00-\udfff]/.test(message[tail]!)) tail += 1;
  return message.slice(0, head) + gap(tail - head) + message.slice(tail);
}

export type LeasedBuild = {
  id: string;
  appId: string;
  commit: string;
  token: string;
  /** The SDK digest a package for this platform must record. */
  sdkDigest: string;
};
