/**
 * Server-only: the internal API the dedicated Builder calls (see
 * src/builder/protocol.ts). internal-server.ts has already checked the
 * shared HATCH_BUILDER_TOKEN; every per-build call is also bound to the
 * lease by its build token.
 */
import type http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  BUILD_TOKEN_HEADER,
  BUILDER_PROTOCOL_VERSION,
  LEASE_WAIT_MS,
  LOG_BATCH_MAX_BYTES,
  LOG_BATCH_MAX_LINES,
  type LeasedBuild,
} from '../../builder/protocol';
import { BUILD_PACKAGE_MAX_COMPRESSED_BYTES } from '../../app-build/format';
import { AppError } from '../errors';
import { platformSdkDigest } from '../platform-api/sdk';
import { buildLeaseToken, readBuildLeaseToken } from './build-tokens';
import {
  acceptArtifact,
  appendLeasedBuildLog,
  BUILD_QUEUE_CHANNEL,
  type BuildLease,
  failBuild,
  leaseBuild,
  leasedBuild,
  renewBuildLease,
  followBuildChanges,
} from './builds';
import { archiveAppCommit } from './git';

const MAX_JSON_BYTES = LOG_BATCH_MAX_BYTES;

/**
 * Buffer a body of at most `limit` bytes actually read. Past the limit it
 * stops buffering (the rest is drained) and rejects with 413, which the
 * internal API answers before closing the connection, so the Builder reads
 * the 413 instead of a dropped connection.
 */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > limit) {
        over = true;
        chunks.length = 0;
        reject(new AppError('Payload too large.', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('aborted', () =>
      reject(new AppError('Request body was aborted.', 400)),
    );
    req.once('error', reject);
  });
}

async function readJson<T>(
  req: http.IncomingMessage,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = await readBody(req, MAX_JSON_BYTES);
  let value: unknown;
  try {
    value = body.length ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    throw new AppError('Invalid JSON body.', 400);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('Unexpected request body.', 400);
  return parsed.data;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * The leased build a request's token names, while it is still leased. Every
 * write the request makes is checked against the same lease (builder and
 * attempt) again, atomically, so a request whose attempt expires meanwhile
 * changes nothing of the next attempt.
 */
async function leasedFor(req: http.IncomingMessage, buildId: string) {
  const token = readBuildLeaseToken(
    req.headers[BUILD_TOKEN_HEADER] as string | undefined,
  );
  if (!token || token.buildId !== buildId) {
    throw new AppError('Invalid build token.', 401);
  }
  const build = await leasedBuild(buildId, token.builderId);
  if (!build || build.attempts !== token.attempt) return null;
  const lease: BuildLease = {
    builderId: token.builderId,
    attempt: token.attempt,
  };
  return { build, lease };
}

function notLeased(res: http.ServerResponse): void {
  // Canceled, superseded or no longer this Builder's: stop building.
  json(res, 409, { error: 'build_not_leased', continue: false });
}

export async function handleBuilderApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rest: string[],
): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest.length === 1 && rest[0] === 'lease' && method === 'POST') {
    const body = await readJson(
      req,
      z.object({
        builderId: z.string().min(1).max(191),
        protocolVersion: z.number().int(),
      }),
    );
    if (body.protocolVersion !== BUILDER_PROTOCOL_VERSION) {
      json(res, 409, {
        error: 'builder_protocol_mismatch',
        protocolVersion: BUILDER_PROTOCOL_VERSION,
      });
      return;
    }
    // The Builder left when the response closes before it was sent (the
    // request's own `close` fires as soon as its body has been read).
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const deadline = Date.now() + LEASE_WAIT_MS;
    // Follow the queue before the first claim: a build queued while a claim
    // is running ends the next wait at once.
    const queue = await followBuildChanges(BUILD_QUEUE_CHANNEL);
    let build: Awaited<ReturnType<typeof leaseBuild>>;
    try {
      build = await leaseBuild(body.builderId);
      while (!build && Date.now() < deadline) {
        await queue.wait(Math.min(5_000, deadline - Date.now()), abort.signal);
        if (abort.signal.aborted) return;
        build = await leaseBuild(body.builderId);
      }
    } finally {
      queue.close();
    }
    if (abort.signal.aborted) {
      // The Builder left after the claim; its lease expires and the
      // sweeper queues the build again.
      return;
    }
    const leased: LeasedBuild | null = build
      ? {
          id: build.id,
          appId: build.appId,
          commit: build.commit,
          token: buildLeaseToken({
            buildId: build.id,
            builderId: body.builderId,
            attempt: build.attempts,
          }),
          sdkDigest: await platformSdkDigest(),
        }
      : null;
    json(res, 200, { build: leased });
    return;
  }

  const [buildId, action] = rest;
  if (!buildId || rest.length !== 2) throw new AppError('Not found.', 404);
  const leased = await leasedFor(req, buildId);
  if (!leased) {
    notLeased(res);
    return;
  }
  const { build, lease } = leased;

  if (action === 'source' && method === 'GET') {
    // The Builder left (or gave up) when the response closes unfinished:
    // stop checking out or archiving for it.
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    // Rejects before any byte is sent: a source over the budget or one that
    // cannot be checked out is answered with an error status.
    const archive = await archiveAppCommit(
      build.appId,
      build.commit,
      abort.signal,
    ).catch((error) => {
      // Nobody to answer once the Builder left.
      if (abort.signal.aborted) return null;
      throw error;
    });
    if (!archive) return;
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'cache-control': 'no-store',
    });
    // Streamed without a length: a failure past this point resets the
    // connection, so the Builder never reads a cut archive as complete.
    await pipeline(archive, res).catch((error) => {
      if (!abort.signal.aborted) {
        console.error(`[builder-api] source of ${build.id} failed:`, error);
      }
      res.destroy();
    });
    return;
  }
  if (action === 'heartbeat' && method === 'POST') {
    json(res, 200, { continue: await renewBuildLease(build.id, lease) });
    return;
  }
  if (action === 'logs' && method === 'POST') {
    const body = await readJson(
      req,
      z.object({ lines: z.array(z.string()).max(LOG_BATCH_MAX_LINES) }),
    );
    if (!(await appendLeasedBuildLog(build.id, lease, body.lines))) {
      notLeased(res);
      return;
    }
    json(res, 200, { ok: true });
    return;
  }
  if (action === 'fail' && method === 'POST') {
    const body = await readJson(
      req,
      z.object({
        message: z.string().max(64_000),
        code: z.enum(['app_build_failed', 'APP_MANIFEST_INVALID']).optional(),
      }),
    );
    if (!(await failBuild(build.id, lease, body.message, body.code))) {
      notLeased(res);
      return;
    }
    json(res, 200, { ok: true });
    return;
  }
  if (action === 'artifact' && method === 'PUT') {
    const archive = await readBody(req, BUILD_PACKAGE_MAX_COMPRESSED_BYTES);
    const final = await acceptArtifact({
      appId: build.appId,
      buildId: build.id,
      archive,
      lease,
    });
    json(res, 200, {
      status: final.status,
      errorCode: final.errorCode,
      errorMessage: final.errorMessage,
    });
    return;
  }
  throw new AppError('Not found.', 404);
}
