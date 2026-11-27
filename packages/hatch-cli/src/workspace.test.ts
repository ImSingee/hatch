import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  AppService,
  type CreateAppRequest,
} from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
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
  chmod,
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
import {
  pnpmFetchArgs,
  pnpmInstallArgs,
} from '../../../src/node-toolchain-commands';
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
/** The build mode each create request asked for. */
let requestedBuilds: string[];
let loseResponse: boolean;
/** The watch sends no line past this one, as a stalled log stream. */
let logLimit: number;
/** Lines the build appends after each watch response. */
let logGrowth: number;
/** getAppDeployment never answers. */
let stallGet: boolean;
/** Calls to associateAppSession, which writes an association. */
let associations: number;
/** Holds each listAppDeployments answer until it resolves. */
let listDelay: (() => Promise<void>) | undefined;
let currentSocket: IncomingMessage['socket'] | undefined;
type DeploymentRecord = {
  id: string;
  appId: string;
  seq: number;
  commit: string;
  message: string;
  build: string;
  trigger: string;
  status: string;
  finished: boolean;
  createdAt: string;
  logSeq: number;
  requestId?: string;
};
let deployments: DeploymentRecord[];
function deploymentMessage(record: DeploymentRecord) {
  return {
    ...record,
    ...(record.status === 'ready'
      ? {
          deployment: {
            deploymentId: record.id,
            version: record.seq,
            compatibilityVersion: 1,
            normalized: fromJson(ValueSchema, {
              id: 'immutable',
              name: 'Fixture',
              description: '',
            }),
          },
        }
      : {}),
  };
}
let sdkDelay: (() => Promise<void>) | undefined;
let sdkFailure: boolean;
let resourceSlug: string;
let createRequests: unknown[];
/** Extra scaffold files, layered over the default fixture. */
let scaffoldFiles: Record<string, string>;
let sdkTooling: Record<string, string | boolean> | undefined;
/** PATH entry holding a pnpm that matches the platform's major version. */
let tools: string;
const PNPM_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`;
const NODE_TOOLING = {
  bufVersion: '1.0.0',
  protocGenEsVersion: '2.0.0',
  typescriptVersion: '7.0.2',
  esbuildVersion: '0.28.2',
  pnpmVersion: '12.22.0',
};
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
    files: Object.entries({
      'package.json': '{"type":"module","dependencies":{}}',
      'manifest.json': JSON.stringify({
        id: 'immutable',
        name: 'Fixture',
        compatibilityVersion: 1,
        capabilities: {},
      }),
      'pnpm-lock.yaml': PNPM_LOCKFILE,
      ...scaffoldFiles,
    }).map(([path, content]) => ({ path, content: Buffer.from(content) })),
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
      associateAppSession: () => {
        associations++;
        return { appId: 'immutable', association: 'not-applicable' };
      },
      createAppDeployment: async (data) => {
        // A repeated create request answers with what it made.
        const repeated = deployments.find(
          (item) => data.requestId && item.requestId === data.requestId,
        );
        if (repeated) return { deployment: deploymentMessage(repeated) };
        requestedBuilds.push(data.build);
        deploys++;
        const id = `deployment-${deploys}`;
        const record = {
          id,
          appId: 'immutable',
          seq: deploys,
          commit: data.commit ?? '',
          message: data.message,
          build: 'builder',
          trigger: 'cli',
          // A lost response leaves the deployment the platform created
          // still running; otherwise the fixture Builder releases at once.
          status: loseResponse ? 'building' : 'ready',
          finished: !loseResponse,
          createdAt: new Date().toISOString(),
          logSeq: 0,
          requestId: data.requestId,
        };
        deployments.push(record);
        if (loseResponse) {
          currentSocket?.destroy();
          return new Promise<never>(() => {});
        }
        deployedCommits.push(data.commit);
        released = data.commit ?? null;
        return { deployment: deploymentMessage(record) };
      },
      getAppDeployment: (data) => {
        if (stallGet) return new Promise<never>(() => {});
        const record = deployments.find(
          (item) => item.id === data.deploymentId,
        );
        if (!record) throw new ConnectError('missing', Code.NotFound);
        return { deployment: deploymentMessage(record) };
      },
      // A long log arrives over several responses, as the platform caps
      // each at 2,000 lines; it then keeps the stream open for new output.
      async *watchAppDeploymentLogs(data) {
        const record = deployments.find(
          (item) => item.id === data.deploymentId,
        );
        if (!record) throw new ConnectError('missing', Code.NotFound);
        for (
          let from = (data.afterSeq ?? 0) + 1;
          from <= Math.min(record.logSeq, logLimit);
          from += 2000
        ) {
          const lines = [];
          const end = Math.min(from + 2000, record.logSeq + 1, logLimit + 1);
          for (let seq = from; seq < end; seq++)
            lines.push({
              seq,
              stream: 'build',
              text: `line ${seq}`,
              at: new Date().toISOString(),
            });
          yield { lines, deployment: deploymentMessage(record) };
          record.logSeq += logGrowth;
        }
        await new Promise(() => {});
      },
      listAppDeployments: async (data) => {
        await listDelay?.();
        return {
          deployments: [...deployments]
            .reverse()
            .filter(
              (item) => !data.requestId || item.requestId === data.requestId,
            )
            .map(deploymentMessage),
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
          tooling: sdkTooling,
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
  if (request.url?.startsWith('/api/git/app/immutable.git/')) {
    gitHttp(request, response);
    return;
  }
  currentSocket = request.socket;
  await rpc(request, response);
});

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env = {
    ...process.env,
    HATCH_CLI_URL: origin,
    HATCH_CLI_TOKEN: token,
    HATCH_CLI_API_KEY: undefined,
    FORCE_COLOR: undefined,
    PATH: `${tools}${delimiter}${process.env.PATH}`,
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
    // More than one JSON document on stdout fails the call that printed it.
    child.once('close', (code) => {
      try {
        resolve({ code, data: stdout ? JSON.parse(stdout) : null, stderr });
      } catch (error) {
        reject(error);
      }
    });
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
    'app',
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
    requestedBuilds = [];
    deployments = [];
    loseResponse = false;
    logLimit = Number.POSITIVE_INFINITY;
    logGrowth = 0;
    stallGet = false;
    associations = 0;
    listDelay = undefined;
    sdkDelay = undefined;
    sdkFailure = false;
    resourceSlug = 'fixture';
    createRequests = [];
    scaffoldFiles = {};
    sdkTooling = NODE_TOOLING;
    // App preparation installs with pnpm; this one only reports its version.
    tools = join(directory, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'pnpm.cjs'),
      `if (process.argv.includes('--version')) console.log(${JSON.stringify(NODE_TOOLING.pnpmVersion)});\n`,
    );
    if (process.platform === 'win32')
      await writeFile(
        join(tools, 'pnpm.cmd'),
        '@echo off\r\nnode "%~dp0pnpm.cjs" %*\r\n',
      );
    else
      await writeFile(
        join(tools, 'pnpm'),
        `#!/bin/sh\nexec "${process.execPath}" "${join(tools, 'pnpm.cjs')}" "$@"\n`,
        { mode: 0o755 },
      );
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
  it('creates an App with a digit-leading slug in the default directory and keeps it when preparation fails', async () => {
    const input = { slug: '123-test-app', name: 'Test resource', pin: false };
    const file = join(directory, 'input.json');
    await writeFile(file, JSON.stringify(input));
    // Without the platform's pnpm toolchain preparation fails. Registration
    // must succeed, then preparation must retain its checkout.
    sdkTooling = undefined;

    const result = await run([
      'app',
      'create',
      '--file',
      file,
      '--workdir',
      directory,
    ]).result;

    assert.equal(result.code, 6, JSON.stringify(result));
    expect(result.data.error.code).toBe('app_preparation_failed');
    expect(createRequests).toEqual([input]);
    const root = join(directory, input.slug);
    expect(result.data.error.message).toContain(await realpath(root));
    expect(
      JSON.parse(await readFile(join(root, '.git/hatch-cli.json'), 'utf8')),
    ).toMatchObject({ kind: 'app', id: 'immutable' });
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Initialize scaffold');
    expect(await readFile(join(root, '.hatch/import-map.json'), 'utf8')).toBe(
      '{"imports":{}}',
    );
  });
  it('rejects unsafe App slugs before creating remote or local state', async () => {
    const file = join(directory, 'input.json');
    await writeFile(
      file,
      JSON.stringify({ slug: '../123-test-resource', name: 'Test resource' }),
    );

    const result = await run([
      'app',
      'create',
      '--file',
      file,
      '--workdir',
      directory,
    ]).result;

    expect(result.data.error.code).toBe('invalid_input');
    expect(createRequests).toEqual([]);
    expect((await readdir(directory)).sort()).toEqual(['input.json', 'tools']);
  });
  it('rejects malformed create field types before a remote mutation', async () => {
    const file = join(directory, 'input.json');
    await writeFile(file, JSON.stringify({ slug: 'valid-slug', name: 42 }));
    const result = await run([
      'app',
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
      (await run(['app', 'clone', 'immutable', '--directory', root]).result)
        .code,
    ).toBe(6);
    await writeFile(join(root, 'local.txt'), 'local work');
    expect(
      (await run(['app', 'update', '--directory', root]).result).data.error
        .code,
    ).toBe('dirty_workspace');
    expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('local work');
    commit(root, 'Keep local work');
    generation = new Date(Date.now() + 1000).toISOString();
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('RESOURCE_GENERATION_CONFLICT');
    expect(deploys).toBe(0);
    const metadata = JSON.parse(
      await readFile(join(root, '.git/hatch-cli.json'), 'utf8'),
    );
    const bind = (value: Record<string, unknown>) =>
      writeFile(
        join(root, '.git/hatch-cli.json'),
        JSON.stringify({ ...metadata, ...value }),
      );
    await bind({ url: 'https://another.example.test' });
    expect(
      (await run(['app', 'update', '--directory', root]).result).data.error
        .code,
    ).toBe('workspace_instance_mismatch');
    // Only App checkouts exist; a checkout of any other kind is refused.
    await bind({ kind: 'workflow' });
    expect(
      (await run(['app', 'update', '--directory', root]).result).data.error
        .code,
    ).toBe('workspace_instance_mismatch');
  });
  it('fast-forwards clones and fetches divergence without resetting local commits', async () => {
    const root = await create();
    await publish(root);
    const clone = join(directory, 'clone');
    expect(
      (await run(['app', 'clone', 'immutable', '--directory', clone]).result)
        .code,
    ).toBe(0);
    await writeFile(join(root, 'remote.txt'), 'remote');
    commit(root, 'Remote');
    await publish(root);
    expect(
      (await run(['app', 'update', '--directory', clone]).result).code,
    ).toBe(0);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(master);
    await writeFile(join(clone, 'local.txt'), 'local');
    commit(clone, 'Local');
    const local = git(clone, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'other.txt'), 'other');
    commit(root, 'Other');
    await publish(root);
    expect(
      (await run(['app', 'update', '--directory', clone]).result).data.error
        .code,
    ).toBe('non_fast_forward');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(local);
    expect(git(clone, 'rev-parse', 'origin/master')).toBe(master);
    // A push from the diverged checkout is refused the same way.
    expect(
      (await run(['app', 'push', '--directory', clone]).result).data.error.code,
    ).toBe('non_fast_forward');
    expect(remoteMaster()).toBe(master);
  });
  it('pushes without deploying, and deploys by commit', async () => {
    const root = await create();
    const first = git(root, 'rev-parse', 'HEAD');
    // Uncommitted work neither blocks a push nor is sent.
    await writeFile(join(root, 'draft.txt'), 'uncommitted');
    const pushed = await run(['app', 'push', '--directory', root]).result;
    expect(pushed.data).toMatchObject({ commit: first, state: 'pushed' });
    expect(remoteMaster()).toBe(first);
    expect(
      (await run(['app', 'push', '--directory', root]).result).data.state,
    ).toBe('up-to-date');
    expect(deploys).toBe(0);

    commit(root, 'Second');
    const second = git(root, 'rev-parse', 'HEAD');
    const deployed = await run(['app', 'deploy', '--directory', root]).result;
    expect(deployed.data).toMatchObject({
      sourceCommit: second,
      pushState: 'pushed',
    });
    expect(remoteMaster()).toBe(second);

    // --commit releases an already pushed commit and pushes nothing.
    await writeFile(join(root, 'third.txt'), 'local only');
    commit(root, 'Third');
    const older = await run([
      'app',
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
        (await run(['app', 'deploy', '--directory', root, ...extra]).result)
          .data.error.code,
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

    const updated = await run(['app', 'update', '--directory', root]).result;
    expect(updated.data).toMatchObject({ state: 'ahead', headCommit: next });
    expect(git(root, 'rev-parse', 'origin/master')).toBe(first);
    expect(
      (await run(['app', 'push', '--directory', root]).result).data.state,
    ).toBe('pushed');
    expect(remoteMaster()).toBe(next);
  });
  it.skipIf(process.platform === 'win32')(
    'gives plain git a working origin without storing the credential',
    async () => {
      const root = await create();
      await publish(root);
      const url = `${origin}/api/git/app/immutable.git`;
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
          'app',
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
      (await run(['app', 'clone', 'immutable', '--force']).result).data.error
        .code,
    ).toBe('invalid_arguments');
    expect(
      (
        await run([
          'app',
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
        await run(['app', 'clone', 'immutable', '--directory', '/', '--force'])
          .result
      ).data.error.code,
    ).toBe('unsafe_target');
    const link = join(directory, 'linked');
    await symlink(target, link);
    expect(
      (
        await run(['app', 'clone', 'immutable', '--directory', link, '--force'])
          .result
      ).data.error.code,
    ).toBe('unsafe_target');
    sdkFailure = true;
    const failed = await run([
      'app',
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
      'app',
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
  it('settles a lost deploy response from the platform record and never deploys twice', async () => {
    const root = await create();
    loseResponse = true;
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(7);
    loseResponse = false;
    const pending = JSON.parse(
      await readFile(join(root, '.git/hatch-cli.json'), 'utf8'),
    ).pending;
    expect(pending.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(pending.deploymentId).toBeUndefined();
    // The platform created the deployment before the response was lost and
    // is still building it: no second deployment is requested.
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('deployment_in_progress');
    const reconciled = (
      await run(['app', 'deploy', '--directory', root, '--reconcile']).result
    ).data;
    expect(reconciled).toMatchObject({
      state: 'in-progress',
      deployment: { deploymentId: 'deployment-1', commit: pending.commit },
    });
    expect(deploys).toBe(1);
    // Once it finishes, the checkout settles it and deploys again.
    Object.assign(deployments[0], { status: 'failed', finished: true });
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(0);
    expect(deploys).toBe(2);
    expect(deployedCommits).toEqual([pending.commit]);
    expect(remoteMaster()).toBe(pending.commit);
    expect(
      JSON.parse(await readFile(join(root, '.git/hatch-cli.json'), 'utf8'))
        .pending,
    ).toBeUndefined();
  });
  it('prints a whole long log without --follow and stops at its end', async () => {
    const root = await create();
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(0);
    const last = deployments.at(-1)!;
    last.logSeq = 4_500;
    // The build keeps writing while the log is read: none of it is printed.
    logGrowth = 1;
    const logs = await run([
      'app',
      'deployments',
      'logs',
      'immutable',
      last.id,
      '--after',
      '10',
    ]).result;
    expect(logs.code).toBe(0);
    expect(logs.data.lines).toHaveLength(4_490);
    expect(logs.data.lines.at(-1)).toMatchObject({ seq: 4_500 });
    // The deployment printed is the snapshot those lines end at.
    expect(logs.data.deployment).toMatchObject({ logSeq: 4_500 });
  });
  it('never takes another deployment of the same commit for an unconfirmed create', async () => {
    const root = await create();
    const workspace = join(root, '.git/hatch-cli.json');
    // An earlier deployment of this commit finished just now.
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(0);
    const metadata = JSON.parse(await readFile(workspace, 'utf8'));
    const commit = git(root, 'rev-parse', 'HEAD');
    // A redeploy whose create never reached the platform, still within the
    // create request's deadline.
    const pending = {
      command: 'deploy',
      commit,
      startedAt: new Date().toISOString(),
      requestId: 'lost-request',
      createDeadline: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(workspace, JSON.stringify({ ...metadata, pending }));
    // Reconciling only reads the platform: local edits do not block it.
    await writeFile(join(root, 'draft.txt'), 'uncommitted');
    const unconfirmed = (
      await run(['app', 'deploy', '--directory', root, '--reconcile']).result
    ).data;
    expect(unconfirmed).toMatchObject({
      state: 'unconfirmed',
      deployment: null,
    });
    expect(JSON.parse(await readFile(workspace, 'utf8')).pending).toEqual(
      pending,
    );
    // Once the request can no longer land, it was not created.
    await writeFile(
      workspace,
      JSON.stringify({
        ...metadata,
        pending: {
          ...pending,
          createDeadline: new Date(Date.now() - 120_000).toISOString(),
        },
      }),
    );
    expect(
      (await run(['app', 'deploy', '--directory', root, '--reconcile']).result)
        .data,
    ).toMatchObject({ state: 'not-created', deployment: null });
    expect(
      JSON.parse(await readFile(workspace, 'utf8')).pending,
    ).toBeUndefined();
    await rm(join(root, 'draft.txt'));
    // A deployment id the platform no longer knows is missing: no wait
    // settles it, only an explicit confirmation, which then deploys.
    const lost = { ...pending, deploymentId: 'deployment-gone' };
    await writeFile(workspace, JSON.stringify({ ...metadata, pending: lost }));
    expect(
      (await run(['app', 'deploy', '--directory', root, '--reconcile']).result)
        .data,
    ).toMatchObject({ state: 'missing', deployment: null });
    const blocked = await run(['app', 'deploy', '--directory', root]).result;
    expect(blocked.code).toBe(6);
    expect(blocked.data.error.code).toBe('pending_deployment_missing');
    expect(blocked.data.error.message).toContain('--retry-after-confirming');
    expect(JSON.parse(await readFile(workspace, 'utf8')).pending).toEqual(lost);
    expect(deploys).toBe(1);
    const retried = await run([
      'app',
      'deploy',
      '--directory',
      root,
      '--retry-after-confirming',
      commit,
    ]).result;
    expect(retried.code).toBe(0);
    expect(deploys).toBe(2);
  });
  it('rejects --reconcile with --retry-after-confirming before reading any credential', async () => {
    const result = await run(
      [
        'app',
        'deploy',
        '--directory',
        directory,
        '--reconcile',
        '--retry-after-confirming',
        'a'.repeat(40),
      ],
      {
        HATCH_CLI_URL: undefined,
        HATCH_CLI_TOKEN: undefined,
        HOME: directory,
        XDG_CONFIG_HOME: undefined,
      },
    ).result;
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe('invalid_retry_confirmation');
  });
  /** A checkout whose pending deployment the platform finished. */
  async function finishedPending(root: string) {
    const workspace = join(root, '.git/hatch-cli.json');
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(0);
    const metadata = JSON.parse(await readFile(workspace, 'utf8'));
    const pending = {
      command: 'deploy',
      commit: git(root, 'rev-parse', 'HEAD'),
      startedAt: new Date().toISOString(),
      deploymentId: deployments[0].id,
    };
    await writeFile(workspace, JSON.stringify({ ...metadata, pending }));
    return {
      pending,
      saved: async () => JSON.parse(await readFile(workspace, 'utf8')).pending,
      reconcile: () =>
        run(['app', 'deploy', '--directory', root, '--reconcile']).result,
    };
  }
  it('reconciles without associating the App', async () => {
    const root = await create();
    const created = associations;
    // A failed reconcile associates nothing.
    expect(
      (await run(['app', 'deploy', '--directory', root, '--reconcile']).result)
        .data.error.code,
    ).toBe('no_pending_deployment');
    expect(associations).toBe(created);
    // A deploy does.
    const { reconcile, saved } = await finishedPending(root);
    expect(associations).toBe(created + 1);
    expect((await reconcile()).data).toMatchObject({
      state: 'finished',
      deployment: { deploymentId: deployments[0].id },
    });
    expect(await saved()).toBeUndefined();
    expect(associations).toBe(created + 1);
  });
  // Root writes a read-only directory anyway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a settled deployment only once the checkout has forgotten it',
    async () => {
      const root = await create();
      const { pending, reconcile, saved } = await finishedPending(root);
      await chmod(join(root, '.git'), 0o555);
      let unsaved;
      try {
        unsaved = await reconcile();
      } finally {
        await chmod(join(root, '.git'), 0o755);
      }
      expect(unsaved.code).not.toBe(0);
      expect(unsaved.data).toMatchObject({ ok: false });
      expect(await saved()).toEqual(pending);
    },
  );
  it('judges whether a create request can still land by when its lookup was sent', async () => {
    const root = await create();
    const workspace = join(root, '.git/hatch-cli.json');
    const metadata = JSON.parse(await readFile(workspace, 'utf8'));
    // Eight seconds from now the request's deadline and its minute of grace
    // have passed.
    const settles = Date.now() + 8_000;
    const pending = {
      command: 'deploy',
      commit: git(root, 'rev-parse', 'HEAD'),
      startedAt: new Date().toISOString(),
      requestId: 'slow-request',
      createDeadline: new Date(settles - 60_000).toISOString(),
    };
    await writeFile(workspace, JSON.stringify({ ...metadata, pending }));
    let received = Number.POSITIVE_INFINITY;
    // The lookup is answered only after that moment.
    listDelay = async () => {
      received = Date.now();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, settles + 1_000 - Date.now())),
      );
    };
    const result = await run([
      'app',
      'deploy',
      '--directory',
      root,
      '--reconcile',
    ]).result;
    // Sent before the request could no longer land, so it may still land.
    expect(received).toBeLessThan(settles);
    expect(result.data).toMatchObject({
      state: 'unconfirmed',
      deployment: null,
    });
    expect(JSON.parse(await readFile(workspace, 'utf8')).pending).toEqual(
      pending,
    );
  });
  it('follows a finished deployment to the end of its log and names where to resume when it stalls', async () => {
    const root = await create();
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(0);
    const last = deployments.at(-1)!;
    last.logSeq = 4_500;
    // A finished status before the rest of its log is not the end of it.
    logLimit = 2_000;
    const follow = (...extra: string[]) =>
      run([
        'app',
        'deployments',
        'logs',
        'immutable',
        last.id,
        '--follow',
        ...extra,
      ]).result;
    const stalled = await follow('--timeout', '3');
    expect(stalled.code).toBe(7);
    expect(stalled.data.error).toMatchObject({
      code: 'deployment_log_incomplete',
      details: { afterSeq: 2_000, deployment: { status: 'ready' } },
    });
    logLimit = Number.POSITIVE_INFINITY;
    // With the whole log it returns at its end, without waiting out the
    // timeout for the stream to close.
    const started = Date.now();
    const resumed = await follow('--after', '2000', '--timeout', '60');
    expect(resumed.code).toBe(0);
    expect(resumed.data).toMatchObject({
      deploymentId: last.id,
      logSeq: 4_500,
    });
    expect(resumed.stderr).toContain('line 4500');
    expect(resumed.stderr).not.toContain('line 2000\n');
    expect(Date.now() - started).toBeLessThan(15_000);
  });
  it('keeps the final state lookup of a follow within its timeout', async () => {
    const root = await create();
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(0);
    const last = deployments.at(-1)!;
    Object.assign(last, { status: 'building', finished: false, logSeq: 1 });
    stallGet = true;
    const result = await run([
      'app',
      'deployments',
      'logs',
      'immutable',
      last.id,
      '--follow',
      '--timeout',
      '4',
    ]).result;
    // An unbounded lookup would time out on its own (outcome_unknown).
    expect(result.code).toBe(7);
    expect(result.data.error).toMatchObject({
      code: 'deployment_in_progress',
      details: { afterSeq: 1, deployment: { status: 'building' } },
    });
  });
  it('refuses a commit it would build but does not have before creating a deployment', async () => {
    const root = await create();
    const workspace = join(root, '.git/hatch-cli.json');
    const absent = 'b'.repeat(40);
    const deploy = (...extra: string[]) =>
      run(['app', 'deploy', '--directory', root, '--commit', absent, ...extra])
        .result;
    const refused = await deploy('--local');
    expect(refused.code).toBe(6);
    expect(refused.data.error.code).toBe('source_unavailable');
    expect(deploys).toBe(0);
    expect(
      JSON.parse(await readFile(workspace, 'utf8')).pending,
    ).toBeUndefined();
    // The Builder (the default) fetches the commit itself.
    expect((await deploy()).code).toBe(0);
    expect(deployedCommits).toEqual([absent]);
    expect(requestedBuilds).toEqual(['builder']);
  });
  it('builds on the platform Builder unless --local, and rejects the removed --build before any request', async () => {
    const root = await create();
    await publish(root);
    for (const removed of [['--build', 'local'], ['--build=builder']]) {
      const result = await run([
        'app',
        'deploy',
        '--directory',
        root,
        ...removed,
      ]).result;
      expect(result.code).toBe(2);
      expect(result.data.error.code).toBe('invalid_arguments');
      // It names both ways forward.
      expect(result.data.error.message).toContain('--local');
      expect(result.data.error.message).toContain('Leave it out');
    }
    expect(deploys).toBe(0);
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).code,
    ).toBe(0);
    expect(requestedBuilds).toEqual(['builder']);
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
    const updating = run(['app', 'update', '--directory', root]);
    await startedPromise;
    expect(
      (await run(['app', 'deploy', '--directory', root]).result).data.error
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
  /** Put a `pnpm` first on PATH that records its arguments and environment. */
  async function recordingPnpm(version: string) {
    const bin = join(directory, 'bin');
    const calls = join(directory, 'pnpm-calls.jsonl');
    const script = join(bin, 'pnpm.cjs');
    await mkdir(bin);
    await writeFile(
      script,
      '#!/usr/bin/env node\n' +
        "const fs = require('node:fs');\n" +
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), configHome: process.env.XDG_CONFIG_HOME, configHomeEntries: process.env.XDG_CONFIG_HOME ? fs.readdirSync(process.env.XDG_CONFIG_HOME) : null }) + '\\n');\n` +
        `if (process.argv.includes('--version')) console.log(${JSON.stringify(version)});\n`,
      { mode: 0o755 },
    );
    if (process.platform === 'win32')
      await writeFile(
        join(bin, 'pnpm.cmd'),
        '@echo off\r\nnode "%~dp0pnpm.cjs" %*\r\n',
      );
    else await symlink(script, join(bin, 'pnpm'));
    return {
      env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
      calls: async () =>
        (await readFile(calls, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                args: string[];
                configHome?: string;
                configHomeEntries: string[] | null;
              },
          ),
    };
  }
  async function createApp(env: NodeJS.ProcessEnv) {
    const input = join(directory, 'input.json');
    await writeFile(input, '{"slug":"fixture","name":"Fixture"}');
    return run(
      [
        'app',
        'create',
        '--file',
        input,
        '--directory',
        join(directory, 'source'),
      ],
      env,
    ).result;
  }
  it('reproduces a pnpm-lockfile App with the install the platform runs at deploy', async () => {
    const pnpm = await recordingPnpm('12.4.0');

    const result = await createApp(pnpm.env);

    assert.equal(result.code, 0, JSON.stringify(result));
    const calls = await pnpm.calls();
    // Frozen and offline after the fetch, with the platform's own argument
    // lists. A manifest.json needs no TypeScript or esbuild run.
    expect(calls.map((call) => call.args)).toEqual([
      ['--pm-on-fail=ignore', '--version'],
      pnpmFetchArgs(),
      pnpmInstallArgs(),
    ]);
    // pnpm's global configuration directory is replaced by an empty one.
    for (const call of calls) {
      expect(call.configHomeEntries).toEqual([]);
      expect(call.configHome).not.toBe(process.env.XDG_CONFIG_HOME);
    }
  });
  it('refuses to prepare a pnpm-lockfile App with another pnpm major', async () => {
    const pnpm = await recordingPnpm('9.15.0');

    const result = await createApp(pnpm.env);

    expect(result.code).toBe(6);
    expect(result.data.error).toMatchObject({
      code: 'app_preparation_failed',
      message: expect.stringContaining(
        'pnpm 9.15.0 cannot reproduce this source. Install pnpm 12',
      ),
    });
    expect((await pnpm.calls()).map((call) => call.args)).toEqual([
      ['--pm-on-fail=ignore', '--version'],
    ]);
  });
  it.skipIf(process.platform === 'win32')(
    'reports a missing pnpm as a tool failure, not as a source conflict',
    async () => {
      // A PATH that holds git and nothing else.
      const bin = join(directory, 'bin');
      await mkdir(bin);
      await symlink(
        execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
        join(bin, 'git'),
      );

      const result = await createApp({ PATH: bin });

      expect(result.code).toBe(7);
      expect(result.data.error).toMatchObject({
        code: 'tool_unavailable',
        message: expect.stringContaining(
          'App preparation failed during dependency install',
        ),
      });
    },
  );
  it.each([
    [
      'mixes pnpm-lock.yaml with deno.lock',
      { 'pnpm-lock.yaml': PNPM_LOCKFILE, 'deno.lock': '{}' },
      'mixes two build toolchains',
    ],
    [
      'declares packageManager',
      {
        'pnpm-lock.yaml': PNPM_LOCKFILE,
        'package.json': '{"type":"module","packageManager":"pnpm@9.0.0"}',
      },
      'package.json must not declare packageManager',
    ],
    [
      'carries a pnpm hook',
      { 'pnpm-lock.yaml': PNPM_LOCKFILE, '.pnpmfile.cjs': 'module.exports={}' },
      'app sources cannot include .pnpmfile.cjs',
    ],
  ])(
    'rejects an App that %s before running pnpm',
    async (_label, files, message) => {
      scaffoldFiles = files;
      const pnpm = await recordingPnpm('12.22.0');

      const result = await createApp(pnpm.env);

      expect(result.code).toBe(6);
      expect(result.data.error).toMatchObject({
        code: 'app_preparation_failed',
        message: expect.stringContaining(message),
      });
      expect(await pnpm.calls()).toEqual([]);
    },
  );
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
        ', JSON.stringify(Object.keys(process.env).filter(key => /TOKEN|SECRET|API_KEY|DATABASE_URL/.test(key))));\n' +
        `if (process.argv.includes('--version')) console.log(${JSON.stringify(NODE_TOOLING.pnpmVersion)});\n`,
      { mode: 0o755 },
    );
    const input = join(directory, 'input.json');
    await writeFile(input, '{"slug":"fixture","name":"Fixture"}');
    const result = await run(
      [
        'app',
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
      await symlink('manifest.json', join(root, 'link'));
      commit(root, 'Symlink');
      const head = git(root, 'rev-parse', 'HEAD');
      expect(
        (await run(['app', 'deploy', '--directory', root]).result).data.error
          .code,
      ).toBe('unsafe_source');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(deploys).toBe(0);
    },
  );
});
