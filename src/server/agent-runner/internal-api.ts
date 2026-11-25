/**
 * Server-only: the internal REST API the Agent Runner calls
 * (bearer-authenticated by internal-server.ts before requests reach here).
 * Platform capabilities are public RPCs that the Agent reaches through the
 * `hatch` CLI with its Run credential; only Runner plumbing lives here.
 *
 * Routes:
 *   POST /internal/api/runs/:runId/token {runnerId}
 *                                                → a fresh Run credential
 *   GET  /internal/api/agent-sessions/:sessionId/attachments/:attachmentId
 *                                                → the attachment bytes
 */
import type http from 'node:http';
import { z } from 'zod';
import { AppError } from '~server/errors';
import { mintRunToken, RunTokenError } from './run-auth';
import { getAgentAttachment } from '~server/agent-attachments';

/** JSON body cap: the only body is a small Run token request. */
const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        fail(new AppError('Payload too large.', 413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (chunks.length === 0) {
        succeed(undefined);
        return;
      }
      try {
        succeed(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail(new AppError('Invalid JSON body.', 400));
      }
    };
    const onAborted = () => {
      fail(new AppError('Request body was aborted.', 400));
    };
    const onError = (error: Error) => fail(error);

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    if (req.destroyed && !req.complete) onAborted();
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleInternalApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://internal');
    const segments = url.pathname.split('/').filter(Boolean);
    // Expect ['internal', 'api', resource, ...rest].
    if (segments[0] !== 'internal' || segments[1] !== 'api') {
      throw new AppError('Not found.', 404);
    }
    const [, , resource, ...rest] = segments;
    const method = req.method ?? 'GET';

    // POST /internal/api/runs/:runId/token {runnerId}: a fresh short-lived
    // Agent Run credential, used by the public platform API. Renewal uses this call.
    if (
      resource === 'runs' &&
      rest.length === 2 &&
      rest[1] === 'token' &&
      method === 'POST'
    ) {
      const body = z
        .object({ runnerId: z.string().min(1).max(191) })
        .strict()
        .safeParse(await readJsonBody(req));
      if (!body.success)
        throw new AppError('Expected a body of exactly { runnerId }.', 400);
      res.setHeader('cache-control', 'no-store');
      json(
        res,
        200,
        await mintRunToken(decodeURIComponent(rest[0]), body.data.runnerId),
      );
      return;
    }
    if (resource === 'agent-sessions') {
      await handleAgentSessions(res, method, rest);
      return;
    }
    throw new AppError('Not found.', 404);
  } catch (error) {
    if (error instanceof RunTokenError) {
      json(res, error.code === 'runner_not_connected' ? 403 : 401, {
        error: error.code,
      });
      return;
    }
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) console.error('[agent-internal] request failed:', error);
    json(res, status, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleAgentSessions(
  res: http.ServerResponse,
  method: string,
  rest: string[],
): Promise<void> {
  if (method !== 'GET' || rest.length !== 3 || rest[1] !== 'attachments') {
    throw new AppError('Not found.', 404);
  }
  const sessionId = decodeURIComponent(rest[0]);
  const attachmentId = decodeURIComponent(rest[2]);
  const got = await getAgentAttachment(attachmentId, sessionId);
  if (!got) throw new AppError('Attachment not found.', 404);
  res.writeHead(200, {
    'content-type': got.attachment.mimeType,
    'content-length': String(got.attachment.size),
    'x-attachment-name': encodeURIComponent(got.attachment.name),
    'cache-control': 'private, no-store',
  });
  res.end(got.body);
}
