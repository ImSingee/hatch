/** Standalone source workspaces. Locks survive crashes; no authored work is reset. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  join,
  resolve,
  basename,
  parse,
  relative,
  isAbsolute,
} from 'node:path';
import { CliError } from './error';
import type { Profile } from './config';
import { platformClient } from './client';
import { prepareApp } from './preparation';

export type Workspace = {
  version: 1;
  /** Metadata with any other kind is rejected as a mismatched workspace. */
  kind: 'app';
  url: string;
  id: string;
  generation: string;
  masterCommit: string | null;
  /**
   * A deploy this checkout started and has not seen finish. `deploymentId`
   * is set once the platform created the deployment.
   */
  pending?: {
    command: string;
    commit: string;
    startedAt: string;
    deploymentId?: string;
  };
  lastDeployment?: { version: number; deploymentId: string };
};
import { childEnvironment, git } from './process';
export { command, git, childEnvironment } from './process';

export async function canonicalTarget(target: string) {
  const absolute = resolve(target);
  if (
    absolute
      .split(/[\\/]/)
      .some((part) =>
        ['.git', '.hatch', 'node_modules'].includes(part.toLowerCase()),
      )
  )
    throw new CliError(
      'unsafe_target',
      'Checkout target overlaps a managed directory.',
      6,
    );
  if (absolute === parse(absolute).root)
    throw new CliError(
      'unsafe_target',
      'Filesystem root cannot be a checkout.',
      6,
    );
  let ancestor = absolute;
  while (ancestor !== dirname(ancestor)) {
    const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new CliError(
        'unsafe_target',
        'Checkout paths must not traverse symlinks.',
        6,
      );
    ancestor = dirname(ancestor);
  }
  const existing = await lstat(absolute).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (existing?.isSymbolicLink())
    throw new CliError(
      'invalid_workspace',
      'Workspace root must not be a symlink.',
      6,
    );
  if (existing) return realpath(absolute);
  const parent = await realpath(dirname(absolute)).catch(() => {
    throw new CliError(
      'directory_parent_missing',
      'Create the destination parent directory first.',
    );
  });
  return join(parent, basename(absolute));
}
export async function assertReplacementSafe(root: string, workdir: string) {
  const relativeWorkdir = relative(root, await realpath(workdir));
  if (
    relativeWorkdir === '' ||
    (!isAbsolute(relativeWorkdir) &&
      relativeWorkdir !== '..' &&
      !relativeWorkdir.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`,
      )) ||
    dirname(root) === parse(root).root ||
    root === process.env.HOME
  )
    throw new CliError(
      'unsafe_target',
      'Workspace root cannot be replaced.',
      6,
    );
  const info = await lstat(root).catch(() => null);
  if (info && !info.isDirectory())
    throw new CliError(
      'unsafe_target',
      'Replace only an explicitly identified directory.',
      6,
    );
  async function inspect(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (await lstat(join(child, '.git')).catch(() => null))
        throw new CliError(
          'unsafe_target',
          'Target contains a nested Git checkout; identify that checkout explicitly.',
          6,
        );
      await inspect(child);
    }
  }
  if (info) await inspect(root);
}
export async function checkoutView(
  root: string,
  metadata: Workspace,
  signal: AbortSignal,
  extra: Record<string, unknown> = {},
) {
  const status = (await git(root, signal, ['status', '--short'])).stdout;
  const head = await git(root, signal, ['rev-parse', '--verify', 'HEAD'], true);
  return {
    id: metadata.id,
    directory: root,
    path: root,
    absolutePath: root,
    generation: metadata.generation,
    headCommit: head.code === 0 ? head.stdout : null,
    masterCommit: metadata.masterCommit,
    remoteCommit: metadata.masterCommit,
    dirty: status.length > 0,
    status,
    replacedExisting: false,
    synchronizedExisting: false,
    preparation: 'ready',
    ...extra,
  };
}
export async function withWorkspaceLock<T>(
  target: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await canonicalTarget(target);
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 20);
  const lock = join(dirname(root), `.hatch-cli-${hash}.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new CliError(
      'workspace_locked',
      'Workspace is locked by another process. After a crash, inspect the lock owner and remove the stale lock only when no writer remains.',
      6,
    );
  }
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        root,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return await action(root);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
export async function assertAbsent(root: string) {
  const entry = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry)
    throw new CliError(
      'directory_exists',
      'Destination already exists; choose another directory. Existing files were preserved.',
      6,
    );
}
export async function workspace(
  root: string,
  credential: Profile,
): Promise<Workspace> {
  for (const path of [root, join(root, '.git')]) {
    const entry = await lstat(path).catch(() => null);
    if (!entry?.isDirectory() || entry.isSymbolicLink())
      throw new CliError(
        'invalid_workspace',
        'Use a standalone CLI checkout with a real .git directory.',
      );
  }
  const file = await open(
    join(root, '.git', 'hatch-cli.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new CliError(
      'invalid_workspace',
      'Missing CLI workspace metadata. Clone/create with hatch first.',
    );
  });
  let value: Workspace;
  try {
    value = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  if (
    value.version !== 1 ||
    value.kind !== 'app' ||
    value.url !== credential.url ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.generation !== 'string' ||
    !value.generation
  )
    throw new CliError(
      'workspace_instance_mismatch',
      'Workspace belongs to a different instance, is not an App checkout or has invalid metadata.',
      6,
    );
  return value;
}
export async function saveWorkspace(root: string, value: Workspace) {
  const destination = join(root, '.git', 'hatch-cli.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
}
export async function clean(root: string, signal: AbortSignal) {
  if (
    (
      await git(root, signal, [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ])
    ).stdout
  )
    throw new CliError(
      'dirty_workspace',
      'Commit or save local changes before update/deploy. No files were discarded.',
      6,
    );
}
export async function safeTree(
  root: string,
  signal: AbortSignal,
  ref = 'HEAD',
) {
  const entries = (
    await git(root, signal, ['ls-tree', '-r', '-z', ref])
  ).stdout.split('\0');
  for (const entry of entries) {
    const separator = entry.indexOf('\t');
    const info = entry.slice(0, separator);
    const name = entry.slice(separator + 1);
    if (!name) continue;
    if (
      info.startsWith('120000') ||
      info.startsWith('160000') ||
      name
        .split('/')
        .some((part) =>
          ['.git', '.hatch', 'node_modules'].includes(part.toLowerCase()),
        )
    )
      throw new CliError(
        'unsafe_source',
        'Source contains symlinks, submodules or tracked platform-managed paths. Remove them before using this workspace.',
        6,
      );
  }
}
export async function writeFiles(
  root: string,
  files: { path: string; contentBase64: string }[],
) {
  const seen = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    if (
      !file.path ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          ['.git', '.hatch', 'node_modules'].includes(part.toLowerCase()) ||
          /[\\:]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32),
      ) ||
      seen.has(file.path)
    )
      throw new CliError(
        'unsafe_payload',
        'Platform returned an unsafe file path.',
        7,
      );
    seen.add(file.path);
    const target = join(root, ...parts);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, 'base64'), {
      flag: 'wx',
      mode: 0o644,
    });
  }
}
export async function installSdk(
  root: string,
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
) {
  const payload = await platformClient(credential, timeout, signal).sdk.get();
  const stage = await mkdtemp(join(root, '.hatch-stage-'));
  const destination = join(root, '.hatch');
  const backup = join(root, `.hatch-backup-${randomUUID()}`);
  let moved = false;
  try {
    await writeFiles(stage, payload.files);
    const existing = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink())
        throw new CliError(
          'unsafe_sdk',
          '.hatch must be a real generated directory.',
          6,
        );
      await rename(destination, backup);
      moved = true;
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (moved) await rename(backup, destination);
      throw error;
    }
    if (moved) await rm(backup, { recursive: true, force: true });
    const exclude = join(root, '.git', 'info', 'exclude');
    await mkdir(dirname(exclude), { recursive: true });
    const info = await lstat(dirname(exclude));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CliError(
        'invalid_workspace',
        '.git/info must be a real directory.',
        6,
      );
    const handle = await open(
      exclude,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      if (!(await handle.stat()).isFile())
        throw new CliError(
          'invalid_workspace',
          '.git/info/exclude must be a regular file.',
          6,
        );
      await handle.writeFile(
        '\n.hatch/\n.hatch-stage-*/\n.hatch-backup-*/\nnode_modules/\ngen/\npnpm-workspace.yaml\n',
      );
    } finally {
      await handle.close();
    }
    await prepareApp(root, signal, payload.tooling);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
/** Git smart HTTP remote of an App; IDs are stable, slugs are not. */
export function remoteUrl(credential: Profile, id: string) {
  return `${credential.url}/api/git/app/${id}.git`;
}
/**
 * Run git against the platform remote. The credential travels in the child
 * environment, scoped to this instance, so it never appears in argv or in the
 * checkout's config. Credential helpers and prompts are disabled.
 */
async function remoteGit(
  root: string,
  credential: Profile,
  timeoutMs: number,
  signal: AbortSignal,
  args: string[],
) {
  const header = credential.apiKey
    ? `X-API-Key: ${credential.apiKey}`
    : `Authorization: Bearer ${credential.token}`;
  const config = [
    [`http.${credential.url}/.extraHeader`, header],
    ['http.followRedirects', 'false'],
    ['credential.helper', ''],
  ];
  const env = childEnvironment();
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const result = await git(root, signal, args, true, { env, timeoutMs }).catch(
    (error) => {
      // A transfer that runs out of time is a remote failure like any other.
      throw error instanceof CliError && error.code === 'local_command_timeout'
        ? remoteFailure('')
        : error;
    },
  );
  if (result.code === 0 || args[0] === 'push') return result;
  throw remoteFailure(result.stderr);
}
function remoteFailure(stderr: string) {
  if (/\b401\b|Authentication failed/i.test(stderr))
    return new CliError(
      'UNAUTHORIZED',
      'The platform rejected the credential for Git access. Run hatch auth login.',
      3,
    );
  if (/\b404\b|not found/i.test(stderr))
    return new CliError(
      'git_remote_not_found',
      'The platform has no Git remote for this resource. The resource was deleted, or the platform predates Git transport and must be upgraded.',
      5,
    );
  return new CliError(
    'git_remote_failed',
    'Git could not reach the platform remote. Local source was preserved; retry.',
    7,
  );
}
/**
 * Give a CLI checkout an `origin` that plain git can use: the platform remote,
 * with this CLI as the only credential helper for it. A checkout whose origin
 * points elsewhere (an adopted Agent checkout) is left alone.
 */
export async function configureOrigin(
  root: string,
  credential: Profile & { profile?: string },
  id: string,
  signal: AbortSignal,
  /** Absolute path of an explicitly selected config file, if any. */
  config?: string,
) {
  if (
    (await git(root, signal, ['remote', 'get-url', 'origin'], true)).code === 0
  )
    return;
  const url = remoteUrl(credential, id);
  const helper = `credential.${credential.url}.helper`;
  // Git runs the helper through a shell; plain git must resolve the same
  // credential source this checkout was created with.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const selection =
    (config ? `--config ${quote(config)} ` : '') +
    (credential.profile ? `--profile ${quote(credential.profile)} ` : '');
  await git(root, signal, ['remote', 'add', 'origin', url]);
  // The empty entry drops helpers inherited from user config, so a keychain
  // cannot store a short-lived token and replay it after it expires.
  await git(root, signal, ['config', '--replace-all', helper, '']);
  await git(root, signal, [
    'config',
    '--add',
    helper,
    `!hatch ${selection}git-credential`,
  ]);
  await git(root, signal, ['config', 'branch.master.remote', 'origin']);
  await git(root, signal, [
    'config',
    'branch.master.merge',
    'refs/heads/master',
  ]);
}
/**
 * Fetch platform master and the platform's deploy tags. Returns the master
 * commit, now also at `origin/master`, or null while the remote is empty.
 */
export async function fetchRemote(
  root: string,
  credential: Profile,
  id: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const url = remoteUrl(credential, id);
  const listed = await remoteGit(root, credential, timeoutMs, signal, [
    'ls-remote',
    url,
    'refs/heads/master',
  ]);
  if (!listed.stdout) return null;
  // Forced: a rollback moves platform master backwards.
  await remoteGit(root, credential, timeoutMs, signal, [
    'fetch',
    '--no-tags',
    url,
    '+refs/heads/master:refs/remotes/origin/master',
    '+refs/tags/deploy/*:refs/tags/deploy/*',
  ]);
  const commit = (
    await git(root, signal, ['rev-parse', 'refs/remotes/origin/master'])
  ).stdout;
  await safeTree(root, signal, commit);
  return commit;
}
/** Push HEAD to platform master; the platform accepts fast-forwards only. */
export async function pushHead(
  root: string,
  credential: Profile,
  id: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<'pushed' | 'up-to-date'> {
  const result = await remoteGit(root, credential, timeoutMs, signal, [
    'push',
    '--porcelain',
    remoteUrl(credential, id),
    'HEAD:refs/heads/master',
  ]);
  const status = result.stdout
    .split('\n')
    .find((line) => line.includes('\tHEAD:refs/heads/master\t'));
  if (result.code === 0 && status)
    return status.startsWith('=') ? 'up-to-date' : 'pushed';
  if (status?.startsWith('!'))
    throw new CliError(
      'non_fast_forward',
      'Platform master has commits this checkout lacks, so the push was rejected. Run update, merge or rebase onto origin/master, then retry. No source was reset.',
      6,
    );
  throw remoteFailure(result.stderr);
}
