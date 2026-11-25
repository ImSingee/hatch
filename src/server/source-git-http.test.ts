/**
 * Git smart HTTP endpoint, exercised by a real `git` client over a real
 * socket. The database and credential verification are stubbed; repositories,
 * hooks and the wire protocol are real.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = await mkdtemp(path.join(tmpdir(), 'hatch-git-http-'));
process.env.HATCH_DATA_DIR = path.join(root, 'data');

const rows = {
  apps: [
    { id: 'app-1', slug: 'demo' },
    { id: 'app-2', slug: 'nightly' },
    { id: 'app-3', slug: 'legacy' },
  ],
};
const associate = vi.fn<
  (sessionId: string, appId: string) => Promise<{ appId: string }>
>(async () => ({ appId: 'app-1' }));

vi.mock('~/db', () => {
  const table = (list: { id: string; slug: string }[]) => ({
    findFirst: async ({ where }: { where: { id?: string; slug?: string } }) =>
      list.find((row) =>
        where.id === undefined ? row.slug === where.slug : row.id === where.id,
      ),
  });
  return {
    db: { query: { apps: table(rows.apps) } },
  };
});
vi.mock('./agent-runner/run-auth', () => ({
  RunTokenError: class RunTokenError extends Error {},
}));
vi.mock('./agent-session-apps', () => ({
  associateAgentSessionApp: associate,
}));
vi.mock('./auth/credentials', () => {
  class CredentialError extends Error {}
  return {
    CredentialError,
    authenticateCredential: async (request: Request) => {
      const key = request.headers.get('x-api-key');
      const bearer = request.headers.get('authorization');
      if (key === 'api-key-ok') return { run: null };
      if (bearer === 'Bearer session-ok') return { run: null };
      if (bearer === 'Bearer run.token.ok')
        return { run: { runId: 'r1', sessionId: 's1', runnerId: 'n1' } };
      throw new CredentialError();
    },
  };
});

const { handleGitHttpRequest } = await import('./source-git-http');
const { appRepoDir } = await import('~agent/paths');

/** The hook every repository had before tag pushes were rejected. */
const V3_HOOK = `#!/bin/sh
# hatch-ref-policy v3
while read oldrev newrev refname; do
  case "$refname" in
    refs/tags/deploy|refs/tags/deploy/*)
      echo "Hatch owns deploy/* tags; they are created by deploy." >&2
      exit 1
      ;;
    refs/heads/master)
      case "$newrev" in
        *[!0]*) ;;
        *)
          echo "master cannot be deleted." >&2
          exit 1
          ;;
      esac
      case "$oldrev" in
        *[!0]*)
          if ! git merge-base --is-ancestor "$oldrev" "$newrev"; then
            echo "master only accepts fast-forward pushes; fetch and rebase first." >&2
            exit 1
          fi
          ;;
      esac
      ;;
    refs/heads/*|refs/tags/*) ;;
    *)
      echo "Unsupported ref update: $refname" >&2
      exit 1
      ;;
  esac
done
exit 0
`;

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      duplex: 'half',
    } as RequestInit);
    void handleGitHttpRequest(request).then((response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return res.end();
      Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      ).pipe(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

type GitResult = { code: number; stdout: string; stderr: string };

function git(args: string[], cwd = root): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@hatch.local',
        '-c',
        'init.defaultBranch=master',
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: devNull,
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr }),
    );
  });
}

async function ok(args: string[], cwd?: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const remote = (repo: string, secret = 'api-key-ok') =>
  `http://hatch:${secret}@${origin}/api/git/${repo}.git`;

let checkouts = 0;
async function clone(repo: string, secret?: string): Promise<string> {
  const dir = path.join(root, `checkout-${++checkouts}`);
  await ok(['clone', remote(repo, secret), dir]);
  return dir;
}

async function commit(dir: string, file: string, content: string | Buffer) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), content);
  await ok(['add', '-A'], dir);
  await ok(['commit', '-m', `add ${file}`], dir);
  return ok(['rev-parse', 'HEAD'], dir);
}

const remoteMaster = async (repo: string) =>
  (await ok(['ls-remote', remote(repo), 'refs/heads/master'])).split(/\s/)[0];

describe('git smart HTTP', () => {
  it('requires a credential and ignores cookies', async () => {
    const url = `http://${origin}/api/git/app/app-1.git/info/refs?service=git-upload-pack`;
    const anonymous = await fetch(url);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Basic /);
    const cookie = await fetch(url, { headers: { cookie: 'session=ok' } });
    expect(cookie.status).toBe(401);

    const rejected = await git(['ls-remote', remote('app/app-1', 'wrong')]);
    expect(rejected.code).not.toBe(0);
  });

  it('refuses the dumb protocol and unknown repositories', async () => {
    const headers = { 'x-api-key': 'api-key-ok' };
    const base = `http://${origin}/api/git`;
    expect(
      (await fetch(`${base}/app/app-1.git/info/refs`, { headers })).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${base}/app/missing.git/info/refs?service=git-upload-pack`,
          { headers },
        )
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/app/app-1.git/HEAD`, { headers })).status,
    ).toBe(404);
  });

  it('clones, pushes and fetches with every credential form', async () => {
    const first = await clone('app/app-1');
    const pushed = await commit(first, 'a.txt', 'one');
    await ok(['push', 'origin', 'master'], first);
    expect(await remoteMaster('app/app-1')).toBe(pushed);

    // Session token as the Basic secret, addressed by slug.
    const second = await clone('app/demo', 'session-ok');
    expect(await ok(['rev-parse', 'HEAD'], second)).toBe(pushed);

    // Bearer header, the form the CLI sends; protocol v0 and v2.
    const bare = `http://${origin}/api/git/app/app-1.git`;
    for (const version of ['0', '2']) {
      const listed = await ok([
        '-c',
        'http.extraHeader=Authorization: Bearer session-ok',
        '-c',
        `protocol.version=${version}`,
        'ls-remote',
        bare,
        'refs/heads/master',
      ]);
      expect(listed.split(/\s/)[0]).toBe(pushed);
    }

    const next = await commit(second, 'b.txt', 'two');
    await ok(['push', 'origin', 'master'], second);
    await ok(['pull', '--ff-only', 'origin', 'master'], first);
    expect(await ok(['rev-parse', 'HEAD'], first)).toBe(next);
    expect(associate).not.toHaveBeenCalled();
  });

  it('enforces the ref policy on push', async () => {
    const dir = await clone('app/app-1');
    const master = await ok(['rev-parse', 'HEAD'], dir);

    await ok(['commit', '--amend', '-m', 'rewritten'], dir);
    const forced = await git(['push', '--force', 'origin', 'master'], dir);
    expect(forced.code).not.toBe(0);
    expect(forced.stderr).toContain('only accepts fast-forward pushes');

    const deleted = await git(['push', 'origin', ':master'], dir);
    expect(deleted.code).not.toBe(0);

    const tagged = await git(
      ['push', 'origin', 'HEAD:refs/tags/deploy/v9'],
      dir,
    );
    expect(tagged.code).not.toBe(0);
    expect(tagged.stderr).toContain('Hatch owns deploy/* tags');

    // A tag named like the namespace itself would block every deploy tag.
    const parent = await git(['push', 'origin', 'HEAD:refs/tags/deploy'], dir);
    expect(parent.code).not.toBe(0);

    const other = await git(['push', 'origin', 'HEAD:refs/notes/x'], dir);
    expect(other.code).not.toBe(0);
    expect(await remoteMaster('app/app-1')).toBe(master);

    // Tags come only from deploy; neither lightweight nor annotated tags land.
    const light = await git(['push', 'origin', 'HEAD:refs/tags/v1.0.0'], dir);
    expect(light.code).not.toBe(0);
    expect(light.stderr).toContain('Tags cannot be pushed');
    await ok(['tag', '-a', 'v2.0.0', '-m', 'release'], dir);
    const annotated = await git(['push', 'origin', 'v2.0.0'], dir);
    expect(annotated.code).not.toBe(0);
    expect(annotated.stderr).toContain('Tags cannot be pushed');
    expect(await ok(['ls-remote', '--tags', 'origin'], dir)).toBe('');

    // Any other branch is an ordinary Git ref.
    await ok(['push', 'origin', 'HEAD:refs/heads/topic'], dir);
    await ok(['push', '--force', 'origin', `${master}:refs/heads/topic`], dir);
    await ok(['push', 'origin', ':topic'], dir);
  });

  it('upgrades an older hook and lets earlier tags be deleted', async () => {
    const dir = await clone('app/legacy');
    const head = await commit(dir, 'a.txt', 'one');
    await ok(['push', 'origin', 'master'], dir);

    // A repository from before v4: the old hook, a tag pushed under it and a
    // deploy tag the platform wrote.
    const repo = appRepoDir('app-3');
    const hook = path.join(repo, 'hooks', 'pre-receive');
    await writeFile(hook, V3_HOOK, { mode: 0o755 });
    await ok(['--git-dir', repo, 'tag', 'v0.9', head]);
    await ok(['--git-dir', repo, 'tag', 'deploy/v1', head]);

    const tagged = await git(['push', 'origin', 'HEAD:refs/tags/v1.0.0'], dir);
    expect(tagged.code).not.toBe(0);
    expect(tagged.stderr).toContain('Tags cannot be pushed');
    expect(await readFile(hook, 'utf8')).toContain('hatch-ref-policy v4');

    await ok(['push', 'origin', ':refs/tags/v0.9'], dir);
    const deploy = await git(['push', 'origin', ':refs/tags/deploy/v1'], dir);
    expect(deploy.code).not.toBe(0);
    expect(deploy.stderr).toContain('Hatch owns deploy/* tags');
    expect(await ok(['ls-remote', '--tags', 'origin'], dir)).toBe(
      `${head}\trefs/tags/deploy/v1`,
    );

    await ok(['push', 'origin', 'HEAD:refs/heads/topic'], dir);
  });

  it('streams packs larger than the client post buffer', async () => {
    const dir = await clone('app/nightly');
    const blob = randomBytes(3 * 1024 * 1024);
    const pushed = await commit(dir, 'blob.bin', blob);
    await ok(['push', 'origin', 'master'], dir);

    const copy = await clone('app/app-2');
    expect(await ok(['rev-parse', 'HEAD'], copy)).toBe(pushed);
    expect(await ok(['cat-file', '-s', 'HEAD:blob.bin'], copy)).toBe(
      String(blob.length),
    );
  });

  it('associates a Run with the App it pushes to', async () => {
    const dir = await clone('app/app-1', 'run.token.ok');
    expect(associate).not.toHaveBeenCalled();
    await commit(dir, 'run.txt', 'from a run');
    await ok(['push', 'origin', 'master'], dir);
    expect(associate).toHaveBeenCalledWith('s1', 'app-1');
  });
});
