/**
 * Server-only: Git smart HTTP for App and Workflow source.
 *
 * Serves `git clone`, `fetch` and `push` against the canonical bare repos by
 * running `git upload-pack` / `git receive-pack --stateless-rpc`. Git owns the
 * wire protocol; this module only authenticates, resolves the repository and
 * pipes bytes. Ref policy lives in the repository's pre-receive hook
 * (source-git.ts).
 */
import { spawn } from 'node:child_process';
import { devNull } from 'node:os';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { db } from '~/db';
import { RunTokenError } from './agent-runner/run-auth';
import { associateAgentSessionApp } from './agent-session-apps';
import { ensureAppRepo } from './apps/git';
import {
  authenticateCredential,
  CredentialError,
  type CredentialContext,
} from './auth/credentials';
import { ensureWorkflowRepo } from './workflows/git';

type Service = 'git-upload-pack' | 'git-receive-pack';
type Kind = 'app' | 'workflow';

const ROUTE =
  /^\/api\/git\/(app|workflow)\/([a-z0-9][a-z0-9-]{0,190})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** `Git-Protocol` is client-controlled and becomes an environment variable. */
const GIT_PROTOCOL = /^[a-z0-9=:.-]{1,128}$/;

const NO_CACHE = {
  'cache-control': 'no-cache, max-age=0, must-revalidate',
  pragma: 'no-cache',
  expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
};

function plain(status: number, message: string, headers?: HeadersInit) {
  return new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

function isService(value: string | null): value is Service {
  return value === 'git-upload-pack' || value === 'git-receive-pack';
}

/**
 * Every credential type is accepted, as on the public RPC. Git clients send
 * HTTP Basic, so the Basic secret may be an API key, a session token or a Run
 * token. Cookies are ignored: a browser must not be able to drive Git.
 */
async function authenticate(
  request: Request,
): Promise<CredentialContext | null> {
  const candidates: Record<string, string>[] = [];
  const apiKey = request.headers.get('x-api-key');
  const authorization = request.headers.get('authorization') ?? '';
  const basic = /^Basic\s+(\S+)$/i.exec(authorization)?.[1];
  if (apiKey !== null) {
    candidates.push({ 'x-api-key': apiKey });
  } else if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const username = separator < 0 ? decoded : decoded.slice(0, separator);
    const password = separator < 0 ? '' : decoded.slice(separator + 1);
    // `https://<token>@host/...` puts the secret in the username.
    const secret = password || username;
    if (!/^\S+$/.test(secret)) return null;
    if (secret.split('.').length !== 3)
      candidates.push({ 'x-api-key': secret });
    candidates.push({ authorization: `Bearer ${secret}` });
  } else if (/^Bearer\s/i.test(authorization)) {
    candidates.push({ authorization });
  }
  for (const headers of candidates) {
    try {
      return await authenticateCredential(
        new Request(request.url, { headers }),
      );
    } catch (error) {
      if (error instanceof CredentialError || error instanceof RunTokenError)
        continue;
      throw error;
    }
  }
  return null;
}

async function resolveRepository(
  kind: Kind,
  idOrSlug: string,
): Promise<{ id: string; repoDir: string } | null> {
  const columns = { id: true } as const;
  const lookup = (where: { id: string } | { slug: string }) =>
    kind === 'app'
      ? db.query.apps.findFirst({ where, columns })
      : db.query.workflows.findFirst({ where, columns });
  // The repository path is derived from the stored row, never from the URL.
  const row =
    (await lookup({ id: idOrSlug })) ?? (await lookup({ slug: idOrSlug }));
  if (!row) return null;
  const repoDir =
    kind === 'app'
      ? await ensureAppRepo(row.id)
      : await ensureWorkflowRepo(row.id);
  return { id: row.id, repoDir };
}

function gitEnvironment(request: Request): NodeJS.ProcessEnv {
  // Hooks inherit this environment, so it carries no Platform secrets.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
  };
  const protocol = request.headers.get('git-protocol');
  if (protocol && GIT_PROTOCOL.test(protocol)) env.GIT_PROTOCOL = protocol;
  return env;
}

/** Mirrors git's own rule: the highest `version=N` entry wins. */
function negotiatesProtocolV2(env: NodeJS.ProcessEnv): boolean {
  const versions = (env.GIT_PROTOCOL ?? '')
    .split(':')
    .map((entry) => /^version=(\d+)$/.exec(entry)?.[1])
    .filter((value) => value !== undefined)
    .map(Number);
  return versions.length > 0 && Math.max(...versions) === 2;
}

function pktLine(text: string): Buffer {
  const length = (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0');
  return Buffer.from(`${length}${text}`);
}

function advertiseRefs(
  service: Service,
  repoDir: string,
  request: Request,
): Promise<Response> {
  const env = gitEnvironment(request);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        service.slice('git-'.length),
        '--stateless-rpc',
        '--advertise-refs',
        repoDir,
      ],
      { env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(plain(500, 'Git could not read the repository.'));
        return;
      }
      // Protocol v2 replaces the service announcement with its own preamble.
      const preamble = negotiatesProtocolV2(env)
        ? []
        : [pktLine(`# service=${service}\n`), Buffer.from('0000')];
      resolve(
        new Response(Buffer.concat([...preamble, ...chunks]), {
          headers: {
            ...NO_CACHE,
            'content-type': `application/x-${service}-advertisement`,
          },
        }),
      );
    });
  });
}

function serveRpc(
  service: Service,
  repoDir: string,
  request: Request,
): Response {
  const child = spawn(
    'git',
    [service.slice('git-'.length), '--stateless-rpc', repoDir],
    { env: gitEnvironment(request), stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  request.signal.addEventListener('abort', stop, { once: true });
  child.on('close', () => request.signal.removeEventListener('abort', stop));
  // A spawn failure or early exit surfaces to the client as a truncated
  // response; nothing useful can be done with the error here.
  child.on('error', stop);
  child.stdin.on('error', () => {});

  if (request.body) {
    const body = Readable.fromWeb(
      request.body as Parameters<typeof Readable.fromWeb>[0],
    );
    const gzip = /^(x-)?gzip$/i.test(
      request.headers.get('content-encoding') ?? '',
    );
    const input = gzip ? body.pipe(createGunzip()) : body;
    body.on('error', stop);
    input.on('error', stop);
    input.pipe(child.stdin);
  } else {
    child.stdin.end();
  }

  return new Response(Readable.toWeb(child.stdout) as ReadableStream, {
    headers: {
      ...NO_CACHE,
      'content-type': `application/x-${service}-result`,
    },
  });
}

export async function handleGitHttpRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return plain(404, 'Not found.');
  const kind = match[1] as Kind;
  const idOrSlug = match[2];
  const endpoint = match[3];

  const advertisement = endpoint === 'info/refs';
  const service = advertisement ? url.searchParams.get('service') : endpoint;
  if (request.method !== (advertisement ? 'GET' : 'POST'))
    return plain(405, 'Method not allowed.', {
      allow: advertisement ? 'GET' : 'POST',
    });
  // Without a service the client is asking for the dumb protocol.
  if (!isService(service))
    return plain(403, 'Only the Git smart HTTP protocol is supported.');
  if (
    !advertisement &&
    request.headers.get('content-type') !== `application/x-${service}-request`
  )
    return plain(415, 'Unsupported media type.');

  const credential = await authenticate(request);
  if (!credential)
    return plain(401, 'Authentication required.', {
      'www-authenticate': 'Basic realm="Hatch", charset="UTF-8"',
    });

  const repository = await resolveRepository(kind, idOrSlug);
  if (!repository) return plain(404, 'Repository not found.');

  if (advertisement) return advertiseRefs(service, repository.repoDir, request);
  if (kind === 'app' && service === 'git-receive-pack' && credential.run)
    await associateAgentSessionApp(credential.run.sessionId, repository.id);
  return serveRpc(service, repository.repoDir, request);
}
