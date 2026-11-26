/**
 * Server-only: the internal API the dedicated Builder calls (see
 * src/builder/protocol.ts). internal-server.ts has already checked the
 * shared HATCH_BUILDER_TOKEN; every per-build call is also bound to the
 * lease by its build token.
 */
import type http from 'node:http';
import { z } from 'zod';
import {
  BUILD_TOKEN_HEADER,
  BUILDER_PROTOCOL_VERSION,
  LEASE_WAIT_MS,
  type LeasedBuild,
} from '../../builder/protocol';
import { BUILD_PACKAGE_MAX_COMPRESSED_BYTES } from '../../app-build/format';
import { AppError } from '../errors';
import { platformSdkDigest } from '../platform-api/sdk';
import { buildLeaseToken, readBuildLeaseToken } from './build-tokens';
import {
  acceptArtifact,
  appendBuildLog,
  BUILD_QUEUE_CHANNEL,
  failBuild,
  leaseBuild,
  leasedBuild,
  renewBuildLease,
  waitForBuildChange,
} from './builds';
import { archiveAppCommit } from './git';

const MAX_JSON_BYTES = 1024 * 1024;

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
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

/** The leased build a request's token names, while it is still leased. */
async function leasedFor(req: http.IncomingMessage, buildId: string) {
  const lease = readBuildLeaseToken(
    req.headers[BUILD_TOKEN_HEADER] as string | undefined,
  );
  if (!lease || lease.buildId !== buildId) {
    throw new AppError('Invalid build token.', 401);
  }
  const build = await leasedBuild(buildId, lease.builderId);
  if (!build || build.attempts !== lease.attempt) return null;
  return { build, builderId: lease.builderId };
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
    const abort = new AbortController();
    req.once('close', () => abort.abort());
    const deadline = Date.now() + LEASE_WAIT_MS;
    let build = await leaseBuild(body.builderId);
    while (!build && !abort.signal.aborted && Date.now() < deadline) {
      await waitForBuildChange(
        BUILD_QUEUE_CHANNEL,
        Math.min(5_000, deadline - Date.now()),
        abort.signal,
      );
      build = await leaseBuild(body.builderId);
    }
    if (abort.signal.aborted && build) {
      // The Builder left; its lease simply expires and the build is queued
      // again by the sweeper.
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
    // Canceled, superseded or no longer this Builder's: stop building.
    json(res, 409, { error: 'build_not_leased', continue: false });
    return;
  }
  const { build, builderId } = leased;

  if (action === 'source' && method === 'GET') {
    const archive = await archiveAppCommit(build.appId, build.commit);
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': String(archive.length),
      'cache-control': 'no-store',
    });
    res.end(archive);
    return;
  }
  if (action === 'heartbeat' && method === 'POST') {
    json(res, 200, { continue: await renewBuildLease(build.id, builderId) });
    return;
  }
  if (action === 'logs' && method === 'POST') {
    const body = await readJson(
      req,
      z.object({ lines: z.array(z.string()).max(5_000) }),
    );
    await appendBuildLog(build.id, 'build', body.lines);
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
    await failBuild(build.id, builderId, body.message, body.code);
    json(res, 200, { ok: true });
    return;
  }
  if (action === 'artifact' && method === 'PUT') {
    const archive = await readBody(req, BUILD_PACKAGE_MAX_COMPRESSED_BYTES);
    const final = await acceptArtifact({
      appId: build.appId,
      buildId: build.id,
      archive,
      builderId,
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
