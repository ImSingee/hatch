/**
 * The Platform/Builder protocol: HTTP calls from the Builder to the
 * platform's internal server, authenticated by HATCH_BUILDER_TOKEN. The
 * Builder pulls work, so the platform keeps no connection to it and may run
 * as several instances.
 *
 *   POST /internal/api/builds/lease          {builderId, protocolVersion}
 *        -> {build: {id, appId, commit, token, sdkDigest} | null}
 *        Waits up to LEASE_WAIT_MS for a queued build.
 *   GET  /internal/api/builds/:id/source     -> the commit as .tar.gz
 *   POST /internal/api/builds/:id/heartbeat  -> {continue: boolean}
 *   POST /internal/api/builds/:id/logs       {lines: string[]}
 *        At most LOG_BATCH_MAX_LINES lines and LOG_BATCH_MAX_BYTES of JSON.
 *   PUT  /internal/api/builds/:id/artifact   the build package (.tar.gz)
 *        -> {status, errorCode, errorMessage}
 *   POST /internal/api/builds/:id/fail       {message, code?}
 *        code: `app_build_failed` (default) or `APP_MANIFEST_INVALID`.
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

export type LeasedBuild = {
  id: string;
  appId: string;
  commit: string;
  token: string;
  /** The SDK digest a package for this platform must record. */
  sdkDigest: string;
};
