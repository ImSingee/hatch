import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  AppService,
  type CreateAppRequest,
} from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { WorkflowService } from '../../hatch-platform-api/gen/hatch/platform/v1/workflow_pb';
import { SdkService } from '../../hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
/** Durable CLI source/data boundaries through real child processes and Git. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createGunzip } from 'node:zlib';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
let directory: string;
let origin: string;
let generation: string;
/** Bare repository behind the fixture's Git endpoint. */
let remote: string;
let master: string | null;
let released: string | null;
let deployedCommits: (string | undefined)[];
let deploys: number;
let loseResponse: boolean;
let sdkDelay: (() => Promise<void>) | undefined;
let sdkFailure: boolean;
let resourceSlug: string;
let createRequests: unknown[];
const token = 'private-workspace-test-secret';
const getResource = () => ({
  id: 'immutable',
  slug: resourceSlug,
  name: 'Fixture',
  status: 'draft',
  createdAt: generation,
  updatedAt: generation,
  view: fromJson(ValueSchema, { currentSourceCommit: released }),
});
function createResource(
  data: Pick<CreateAppRequest, 'slug' | 'name' | 'pin' | 'description'>,
) {
  createRequests.push({
    slug: data.slug,
    name: data.name,
    ...(data.pin === undefined ? {} : { pin: data.pin }),
    ...(data.description === undefined
      ? {}
      : { description: data.description }),
  });
  resourceSlug = data.slug;
  return {
    id: 'immutable',
    slug: resourceSlug,
    name: 'Fixture',
    files: [
      {
        path: 'package.json',
        content: Buffer.from('{"type":"module","dependencies":{}}'),
      },
      {
        path: 'manifest.ts',
        content: Buffer.from(
          'export default {id:"immutable", compatibilityVersion:1};',
        ),
      },
    ],
  };
}
const rpc = connectNodeAdapter({
  requestPathPrefix: '/api/rpc',
  requestGate: (context) => {
    if (context.requestHeader.get('authorization') !== `Bearer ${token}`)
      throw new ConnectError('Unauthorized', Code.Unauthenticated);
  },
  routes: (router) => {
    router.service(AppService, {
      createApp: createResource,
      getApp: () => ({ resource: getResource() }),
      associateAppSession: () => ({
        appId: 'immutable',
        association: 'not-applicable',
      }),
    });
    router.service(WorkflowService, {
      createWorkflow: createResource,
      getWorkflow: () => ({ resource: getResource() }),
      deployWorkflow: async (data) => {
        deploys++;
        deployedCommits.push(data.commit);
        released = data.commit ?? null;
        return {
          deployment: {
            deploymentId: 'release-1',
            version: 1,
            compatibilityVersion: 1,
            normalized: fromJson(ValueSchema, {
              id: 'immutable',
              name: 'Fixture',
              description: '',
              entry: 'workflow.ts',
              triggers: { cron: [], webhook: { enabled: false, url: null } },
            }),
          },
        };
      },
    });
    router.service(SdkService, {
      getSdk: async () => {
        if (sdkFailure)
          throw new ConnectError('SDK unavailable', Code.Unavailable);
        await sdkDelay?.();
        return {
          files: [
            { path: 'import-map.json', content: Buffer.from('{"imports":{}}') },
          ],
        };
      },
    });
  },
});
/** Minimal Git smart HTTP over the fixture's bare repository. */
function gitHttp(request: IncomingMessage, response: ServerResponse) {
  const basic = /^Basic (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
  const secret = basic
    ? Buffer.from(basic, 'base64').toString().split(':')[1]
    : /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (secret !== token) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' });
    response.end();
    return;
  }
  const url = new URL(request.url ?? '', origin);
  const advertise = url.pathname.endsWith('/info/refs');
  const service = advertise
    ? String(url.searchParams.get('service'))
    : String(url.pathname.split('/').pop());
  const protocol = String(request.headers['git-protocol'] ?? '');
  const child = spawn(
    'git',
    [
      service.replace('git-', ''),
      '--stateless-rpc',
      ...(advertise ? ['--advertise-refs'] : []),
      remote,
    ],
    { env: { ...process.env, GIT_PROTOCOL: protocol } },
  );
  response.writeHead(200, {
    'content-type': `application/x-${service}-${advertise ? 'advertisement' : 'result'}`,
  });
  if (advertise && !protocol.includes('version=2')) {
    const line = `# service=${service}\n`;
    response.write(
      `${(line.length + 4).toString(16).padStart(4, '0')}${line}0000`,
    );
  }
  (request.headers['content-encoding'] === 'gzip'
    ? request.pipe(createGunzip())
    : request
  ).pipe(child.stdin);
  child.stdout.pipe(response);
}
const server = createServer(async (request, response) => {
  if (request.url?.startsWith('/api/git/workflow/immutable.git/')) {
    gitHttp(request, response);
    return;
  }
  if (loseResponse && request.url?.endsWith('/DeployWorkflow')) {
    deploys++;
    request.socket.destroy();
    return;
  }
  await rpc(request, response);
});

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env = {
    ...process.env,
    HATCH_CLI_URL: origin,
    HATCH_CLI_TOKEN: token,
    HATCH_CLI_API_KEY: undefined,
    FORCE_COLOR: undefined,
    ...extra,
  };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', entry, ...args, '--json'],
    { env, stdio: 'pipe' },
  );
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<{
    code: number | null;
    data: Record<string, any>;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ code, data: stdout ? JSON.parse(stdout) : null, stderr }),
    );
  });
  return { child, result };
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function create() {
  const file = join(directory, 'input.json');
  await writeFile(file, '{"slug":"fixture","name":"Fixture","pin":false}');
  const result = await run([
    'workflow',
    'create',
    '--file',
    file,
    '--directory',
    join(directory, 'source'),
  ]).result;
  assert.equal(result.code, 0, JSON.stringify(result));
  return join(directory, 'source');
}
/** Another client pushes `root`'s HEAD to platform master. */
async function publish(root: string) {
  git(root, 'push', '--quiet', remote, 'HEAD:refs/heads/master');
  master = git(root, 'rev-parse', 'HEAD');
}
const remoteMaster = () => git(remote, 'rev-parse', 'refs/heads/master');
/**
 * `git push origin master` as a person would run it, with this CLI on PATH as
 * `hatch`. Asynchronous: the fixture server runs in this process.
 */
async function nativePush(root: string, extra: NodeJS.ProcessEnv) {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'hatch'),
    `#!/bin/sh\nexec "${process.execPath}" --import "${import.meta.resolve('tsx')}" "${entry}" "$@"\n`,
    { mode: 0o755 },
  );
  const push = spawn('git', ['push', '--quiet', 'origin', 'master'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HATCH_CLI_API_KEY: undefined,
      ...extra,
    } as NodeJS.ProcessEnv,
  });
  return new Promise((resolve) => push.once('close', resolve));
}
function commit(root: string, message: string) {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    message,
  );
}
// These tests launch real Git and package-manager processes, including on CI.
describe('CLI workspace safety', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), 'hatch-cli-boundary-')),
    );
    generation = new Date().toISOString();
    remote = `${directory}-remote.git`;
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'master', remote]);
    git(remote, 'config', 'receive.denyNonFastForwards', 'true');
    master = null;
    released = null;
    deployedCommits = [];
    deploys = 0;
    loseResponse = false;
    sdkDelay = undefined;
    sdkFailure = false;
    resourceSlug = 'fixture';
    createRequests = [];
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  it.each(['app', 'workflow'])(
    'creates a %s with a digit-leading slug in the default directory',
    async (kind) => {
      const input = {
        slug: `123-test-${kind}`,
        name: 'Test resource',
        pin: false,
      };
      const file = join(directory, 'input.json');
      await writeFile(file, JSON.stringify(input));

      const result = await run([
        kind,
        'create',
        '--file',
        file,
        '--workdir',
        directory,
      ]).result;

      // This fixture intentionally has no authored Deno configuration. App
      // registration must succeed, then preparation must retain its checkout.
      assert.equal(result.code, kind === 'app' ? 6 : 0, JSON.stringify(result));
      expect(createRequests).toEqual([input]);
      const root = join(directory, input.slug);
      expect(
        kind === 'app' ? result.data.error.message : result.data.directory,
      ).toContain(await realpath(root));
      expect(
        JSON.parse(await readFile(join(root, '.git/hatch-cli.json'), 'utf8')),
      ).toMatchObject({ kind, id: 'immutable' });
      expect(git(root, 'log', '-1', '--format=%s')).toBe('Initialize scaffold');
      expect(await readFile(join(root, '.hatch/import-map.json'), 'utf8')).toBe(
        '{"imports":{}}',
      );
    },
  );
  it.each(['app', 'workflow'])(
    'rejects unsafe %s slugs before creating remote or local state',
    async (kind) => {
      const file = join(directory, 'input.json');
      await writeFile(
        file,
        JSON.stringify({ slug: '../123-test-resource', name: 'Test resource' }),
      );

      const result = await run([
        kind,
        'create',
        '--file',
        file,
        '--workdir',
        directory,
      ]).result;

      expect(result.data.error.code).toBe('invalid_input');
      expect(createRequests).toEqual([]);
      expect(await readdir(directory)).toEqual(['input.json']);
    },
  );
  it('rejects malformed create field types before a remote mutation', async () => {
    const file = join(directory, 'input.json');
    await writeFile(file, JSON.stringify({ slug: 'valid-slug', name: 42 }));
    const result = await run([
      'workflow',
      'create',
      '--file',
      file,
      '--workdir',
      directory,
    ]).result;
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe('invalid_input');
    expect(createRequests).toEqual([]);
  });
  it('protects existing directories, dirty trees, generation and instance bindings', async () => {
    const root = await create();
    await publish(root);
    expect(
      (
        await run(['workflow', 'clone', 'immutable', '--directory', root])
          .result
      ).code,
    ).toBe(6);
    await writeFile(join(root, 'local.txt'), 'local work');
    expect(
      (await run(['workflow', 'update', '--directory', root]).result).data.error
        .code,
    ).toBe('dirty_workspace');
    expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('local work');
    commit(root, 'Keep local work');
    generation = new Date(Date.now() + 1000).toISOString();
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('RESOURCE_GENERATION_CONFLICT');
    expect(deploys).toBe(0);
    const metadata = JSON.parse(
      await readFile(join(root, '.git/hatch-cli.json'), 'utf8'),
    );
    metadata.url = 'https://another.example.test';
    await writeFile(
      join(root, '.git/hatch-cli.json'),
      JSON.stringify(metadata),
    );
    expect(
      (await run(['workflow', 'update', '--directory', root]).result).data.error
        .code,
    ).toBe('workspace_instance_mismatch');
  });
  it('fast-forwards clones and fetches divergence without resetting local commits', async () => {
    const root = await create();
    await publish(root);
    const clone = join(directory, 'clone');
    expect(
      (
        await run(['workflow', 'clone', 'immutable', '--directory', clone])
          .result
      ).code,
    ).toBe(0);
    await writeFile(join(root, 'remote.txt'), 'remote');
    commit(root, 'Remote');
    await publish(root);
    expect(
      (await run(['workflow', 'update', '--directory', clone]).result).code,
    ).toBe(0);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(master);
    await writeFile(join(clone, 'local.txt'), 'local');
    commit(clone, 'Local');
    const local = git(clone, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'other.txt'), 'other');
    commit(root, 'Other');
    await publish(root);
    expect(
      (await run(['workflow', 'update', '--directory', clone]).result).data
        .error.code,
    ).toBe('non_fast_forward');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(local);
    expect(git(clone, 'rev-parse', 'origin/master')).toBe(master);
    // A push from the diverged checkout is refused the same way.
    expect(
      (await run(['workflow', 'push', '--directory', clone]).result).data.error
        .code,
    ).toBe('non_fast_forward');
    expect(remoteMaster()).toBe(master);
  });
  it('pushes without deploying, and deploys by commit', async () => {
    const root = await create();
    const first = git(root, 'rev-parse', 'HEAD');
    // Uncommitted work neither blocks a push nor is sent.
    await writeFile(join(root, 'draft.txt'), 'uncommitted');
    const pushed = await run(['workflow', 'push', '--directory', root]).result;
    expect(pushed.data).toMatchObject({ commit: first, state: 'pushed' });
    expect(remoteMaster()).toBe(first);
    expect(
      (await run(['workflow', 'push', '--directory', root]).result).data.state,
    ).toBe('up-to-date');
    expect(deploys).toBe(0);

    commit(root, 'Second');
    const second = git(root, 'rev-parse', 'HEAD');
    const deployed = await run(['workflow', 'deploy', '--directory', root])
      .result;
    expect(deployed.data).toMatchObject({
      sourceCommit: second,
      pushState: 'pushed',
    });
    expect(remoteMaster()).toBe(second);

    // --commit releases an already pushed commit and pushes nothing.
    await writeFile(join(root, 'third.txt'), 'local only');
    commit(root, 'Third');
    const older = await run([
      'workflow',
      'deploy',
      '--directory',
      root,
      '--commit',
      first,
    ]).result;
    expect(older.data.sourceCommit).toBe(first);
    expect(older.data.pushState).toBeUndefined();
    expect(remoteMaster()).toBe(second);
    expect(deployedCommits).toEqual([second, first]);

    for (const extra of [
      ['--commit', 'master'],
      ['--commit', first.slice(0, 12)],
      ['--commit', first, '--reconcile'],
    ])
      expect(
        (
          await run(['workflow', 'deploy', '--directory', root, ...extra])
            .result
        ).data.error.code,
      ).toBe('invalid_arguments');
    expect(deploys).toBe(2);
  });
  it('keeps local commits when platform master moves back, then pushes them again', async () => {
    const root = await create();
    const first = git(root, 'rev-parse', 'HEAD');
    await publish(root);
    await writeFile(join(root, 'next.txt'), 'next');
    commit(root, 'Next');
    const next = git(root, 'rev-parse', 'HEAD');
    await publish(root);
    // A rollback rewinds platform master to the restored release.
    git(remote, 'update-ref', 'refs/heads/master', first);

    const updated = await run(['workflow', 'update', '--directory', root])
      .result;
    expect(updated.data).toMatchObject({ state: 'ahead', headCommit: next });
    expect(git(root, 'rev-parse', 'origin/master')).toBe(first);
    expect(
      (await run(['workflow', 'push', '--directory', root]).result).data.state,
    ).toBe('pushed');
    expect(remoteMaster()).toBe(next);
  });
  it.skipIf(process.platform === 'win32')(
    'gives plain git a working origin without storing the credential',
    async () => {
      const root = await create();
      await publish(root);
      const url = `${origin}/api/git/workflow/immutable.git`;
      expect(git(root, 'remote', 'get-url', 'origin')).toBe(url);
      expect(await readFile(join(root, '.git/config'), 'utf8')).not.toContain(
        token,
      );

      // The helper answers only for the instance the credential belongs to.
      const helper = (host: string) =>
        execFileSync(
          process.execPath,
          ['--import', 'tsx', entry, 'git-credential', 'get'],
          {
            input: `protocol=http\nhost=${host}\n\n`,
            encoding: 'utf8',
            env: {
              ...process.env,
              HATCH_CLI_URL: origin,
              HATCH_CLI_TOKEN: token,
              HATCH_CLI_API_KEY: undefined,
            },
          },
        );
      expect(helper(new URL(origin).host)).toBe(
        `username=hatch\npassword=${token}\n`,
      );
      expect(helper('other.example.test')).toBe('');

      await writeFile(join(root, 'native.txt'), 'native');
      commit(root, 'Native');
      expect(
        await nativePush(root, {
          HATCH_CLI_URL: origin,
          HATCH_CLI_TOKEN: token,
        }),
      ).toBe(0);
      expect(remoteMaster()).toBe(git(root, 'rev-parse', 'HEAD'));
    },
  );
  it.skipIf(process.platform === 'win32')(
    'lets plain git use the config file and profile the checkout was cloned with',
    async () => {
      await publish(await create());
      // Neither the default config nor the active profile holds this login.
      const config = join(directory, "team's config.json");
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          activeProfile: 'other',
          profiles: {
            staging: { url: origin, token },
            other: { url: 'https://other.example.test', token: 'other-login' },
          },
        }),
        { mode: 0o600 },
      );
      const fileOnly = {
        HATCH_CLI_URL: undefined,
        HATCH_CLI_TOKEN: undefined,
        HOME: directory,
        XDG_CONFIG_HOME: undefined,
      };
      const clone = join(directory, 'clone');
      const cloned = await run(
        [
          'workflow',
          'clone',
          'immutable',
          '--directory',
          clone,
          '--config',
          config,
          '--profile',
          'staging',
        ],
        fileOnly,
      ).result;
      assert.equal(cloned.code, 0, JSON.stringify(cloned));
      await writeFile(join(clone, 'native.txt'), 'native');
      commit(clone, 'Native');
      expect(await nativePush(clone, fileOnly)).toBe(0);
      expect(remoteMaster()).toBe(git(clone, 'rev-parse', 'HEAD'));
    },
  );
  it('replaces only explicit safe targets after preparation and restores existing work on failure', async () => {
    const source = await create();
    await publish(source);
    const target = join(directory, 'replace');
    await mkdir(target);
    await writeFile(join(target, 'local.txt'), 'valuable work');
    expect(
      (await run(['workflow', 'clone', 'immutable', '--force']).result).data
        .error.code,
    ).toBe('invalid_arguments');
    expect(
      (
        await run([
          'workflow',
          'clone',
          'immutable',
          '--directory',
          directory,
          '--workdir',
          directory,
          '--force',
        ]).result
      ).data.error.code,
    ).toBe('unsafe_target');
    expect(
      (
        await run([
          'workflow',
          'clone',
          'immutable',
          '--directory',
          '/',
          '--force',
        ]).result
      ).data.error.code,
    ).toBe('unsafe_target');
    const link = join(directory, 'linked');
    await symlink(target, link);
    expect(
      (
        await run([
          'workflow',
          'clone',
          'immutable',
          '--directory',
          link,
          '--force',
        ]).result
      ).data.error.code,
    ).toBe('unsafe_target');
    sdkFailure = true;
    const failed = await run([
      'workflow',
      'clone',
      'immutable',
      '--directory',
      target,
      '--force',
    ]).result;
    expect(failed.code).not.toBe(0);
    expect(await readFile(join(target, 'local.txt'), 'utf8')).toBe(
      'valuable work',
    );
    sdkFailure = false;
    const replaced = await run([
      'workflow',
      'clone',
      'immutable',
      '--directory',
      target,
      '--force',
    ]).result;
    expect(replaced.code).toBe(0);
    expect(replaced.data.replacedExisting).toBe(true);
    expect(git(target, 'rev-parse', 'HEAD')).toBe(master);
    expect(await readdir(target)).not.toContain('local.txt');
  });
  it('records uncertain deploy outcomes and never blindly retries', async () => {
    const root = await create();
    loseResponse = true;
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).code,
    ).toBe(7);
    const pending = JSON.parse(
      await readFile(join(root, '.git/hatch-cli.json'), 'utf8'),
    ).pending;
    expect(pending.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('deployment_outcome_unknown');
    expect(
      (
        await run(['workflow', 'deploy', '--directory', root, '--reconcile'])
          .result
      ).data.state,
    ).toBe('outcome-unresolved');
    expect(deploys).toBe(1);
    loseResponse = false;
    expect(
      (
        await run([
          'workflow',
          'deploy',
          '--directory',
          root,
          '--retry-after-confirming',
          pending.commit,
        ]).result
      ).code,
    ).toBe(0);
    expect(deploys).toBe(2);
    expect(deployedCommits).toEqual([pending.commit]);
    expect(remoteMaster()).toBe(pending.commit);
    expect(
      JSON.parse(await readFile(join(root, '.git/hatch-cli.json'), 'utf8'))
        .pending,
    ).toBeUndefined();
  });
  it('uses a cross-process lock and releases it after completion or POSIX cancellation', async () => {
    const root = await create();
    await publish(root);
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    sdkDelay = () => {
      started();
      return waiting;
    };
    const updating = run(['workflow', 'update', '--directory', root]);
    await startedPromise;
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('workspace_locked');
    if (process.platform !== 'win32') updating.child.kill('SIGINT');
    release();
    expect((await updating.result).code).toBe(
      process.platform === 'win32' ? 0 : 130,
    );
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.lock')),
    ).toEqual([]);
  });
  it('keeps CLI, fleet, database and provider credentials out of dependency processes', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const captured = join(directory, 'child-env.json');
    const executable =
      process.platform === 'win32'
        ? join(bin, '.tools', 'pnpm 12 & literal', 'pnpm.cjs')
        : join(bin, 'pnpm');
    await mkdir(join(bin, '.tools', 'pnpm 12 & literal'), { recursive: true });
    if (process.platform === 'win32')
      await writeFile(
        join(bin, 'pnpm.cmd'),
        '@echo off\r\nnode "%~dp0.tools\\pnpm 12 & literal\\pnpm.cjs" %*\r\nexit /b 99\r\n',
      );
    await writeFile(
      executable,
      '#!/usr/bin/env node\n' +
        "require('node:fs').writeFileSync(" +
        JSON.stringify(captured) +
        ', JSON.stringify(Object.keys(process.env).filter(key => /TOKEN|SECRET|API_KEY|DATABASE_URL/.test(key))));\n',
      { mode: 0o755 },
    );
    const input = join(directory, 'input.json');
    await writeFile(input, '{"slug":"fixture","name":"Fixture"}');
    const result = await run(
      [
        'workflow',
        'create',
        '--file',
        input,
        '--directory',
        join(directory, 'source'),
      ],
      {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        AGENT_RUNNER_TOKEN: 'fixture-fleet',
        DATABASE_URL: 'fixture-database',
        ANTHROPIC_API_KEY: 'fixture-provider',
      },
    ).result;
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(captured, 'utf8'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects tracked symlinks and leaves source unchanged',
    async () => {
      const root = await create();
      await symlink('manifest.ts', join(root, 'link'));
      commit(root, 'Symlink');
      const head = git(root, 'rev-parse', 'HEAD');
      expect(
        (await run(['workflow', 'deploy', '--directory', root]).result).data
          .error.code,
      ).toBe('unsafe_source');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(deploys).toBe(0);
    },
  );
});
