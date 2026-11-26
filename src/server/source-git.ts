/**
 * Server-only: shared Git-backed source storage engine.
 *
 * Apps store canonical source the same way: a bare repo per
 * entity, deploy tags owned by the Platform, and temporary deploy checkouts.
 * Clients push and fetch over Git smart HTTP (source-git-http.ts); the
 * deprecated Deploy bundle upload is the only other way in, and source never
 * leaves as a bundle. Pushing source and
 * deploying it are separate steps: a deploy releases a commit that is already
 * on master.
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { checkoutCommit } from '../app-build/checkout';
import { AppError } from './errors';

export const SOURCE_BRANCH = 'master';
export const DEPLOY_TAG_PREFIX = 'deploy/';
/** Largest pack a single push may send; matches the deploy RPC body cap. */
export const MAX_PUSH_BYTES = 256 * 1024 * 1024;
/** Stable code of a deploy whose commit is not (or no longer) on master. */
export const COMMIT_NOT_ON_MASTER_ERROR = 'deployments.commitNotOnMaster';

/**
 * Largest committed tree the platform writes out (a checkout to evaluate
 * the manifest, an archive for the Builder), checked against the commit's
 * blob sizes before anything is written. A push is capped as a compressed
 * pack only, so a small push can still name a huge tree. The byte budget is
 * the expanded size a build package may have (src/app-build/format.ts); the
 * file budget is far above any App's source and bounds inode use.
 */
export const SOURCE_TREE_BUDGET = {
  bytes: 512 * 1024 * 1024,
  files: 100_000,
};
export type SourceTreeBudget = typeof SOURCE_TREE_BUDGET;

/** Commit ids the build path accepts: SHA-1 only (see checkout.ts). */
const COMMIT_ID = /^[0-9a-f]{40}$/;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type PublishedSource = {
  commit: string;
  tag: string;
  repoPath: string;
};

export type GitSourceConfig = {
  /** Noun used in error messages ("app"). */
  noun: string;
  /** Bare canonical repo for an entity id. */
  repoDir: (id: string) => string;
  /** Overrides SOURCE_TREE_BUDGET. */
  treeBudget?: SourceTreeBudget;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ref policy for pushes: any branch may be pushed, master only fast-forwards
 * and cannot be deleted, and tags cannot be created or moved because the
 * Platform tags each deployment itself. Deleting a tag outside the deploy
 * namespace stays allowed so tags pushed under earlier policies can be cleaned
 * up. The Platform's own local fetch/update-ref/tag calls do not run hooks, so
 * deploy and rollback are unaffected.
 */
const PRE_RECEIVE_HOOK = `#!/bin/sh
# hatch-ref-policy v4
while read oldrev newrev refname; do
  case "$refname" in
    refs/tags/${DEPLOY_TAG_PREFIX.slice(0, -1)}|refs/tags/${DEPLOY_TAG_PREFIX}*)
      echo "Hatch owns ${DEPLOY_TAG_PREFIX}* tags; they are created by deploy." >&2
      exit 1
      ;;
    refs/heads/${SOURCE_BRANCH})
      case "$newrev" in
        *[!0]*) ;;
        *)
          echo "${SOURCE_BRANCH} cannot be deleted." >&2
          exit 1
          ;;
      esac
      case "$oldrev" in
        *[!0]*)
          if ! git merge-base --is-ancestor "$oldrev" "$newrev"; then
            echo "${SOURCE_BRANCH} only accepts fast-forward pushes; fetch and rebase first." >&2
            exit 1
          fi
          ;;
      esac
      ;;
    refs/tags/*)
      case "$newrev" in
        *[!0]*)
          echo "Tags cannot be pushed; Hatch creates ${DEPLOY_TAG_PREFIX}* tags when you deploy. Push a branch instead." >&2
          exit 1
          ;;
      esac
      ;;
    refs/heads/*) ;;
    *)
      echo "Unsupported ref update: $refname" >&2
      exit 1
      ;;
  esac
done
exit 0
`;

function git(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

async function runGit(
  args: string[],
  opts: { cwd?: string; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const result = await git(args, opts);
  if (!opts.allowFailure && result.exitCode !== 0) {
    const message = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
  return result;
}

/**
 * Fail unless the tree of `commit` fits `budget`, before it is written
 * anywhere. The listing is read as it streams and stopped once over budget.
 */
function assertTreeWithinBudget(
  repoDir: string,
  commit: string,
  budget: SourceTreeBudget,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['--git-dir', repoDir, 'ls-tree', '-r', '-l', '-z', commit],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], signal },
    );
    let bytes = 0;
    let files = 0;
    let over: AppError | null = null;
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (over) return;
      const records = (pending + chunk).split('\0');
      pending = records.pop() ?? '';
      for (const record of records) {
        // `<mode> <type> <object> <size>\t<path>`; a submodule's size is `-`.
        const [, type, , size] = record
          .slice(0, record.indexOf('\t'))
          .split(/ +/);
        files += 1;
        if (type === 'blob') bytes += Number(size) || 0;
        if (bytes > budget.bytes || files > budget.files) {
          over = new AppError(
            `The source of commit ${commit} is larger than the platform ` +
              `builds (at most ${budget.files} files and ` +
              `${Math.floor(budget.bytes / (1024 * 1024))} MiB).`,
            413,
          );
          child.kill('SIGKILL');
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('error', (error) => reject(over ?? error));
    child.once('close', (code) => {
      if (over) reject(over);
      else if (code === 0) resolve();
      else
        reject(
          new Error(`Could not list the tree of ${commit}: ${stderr.trim()}`),
        );
    });
  });
}

async function refCommit(repoDir: string, ref: string): Promise<string | null> {
  const result = await runGit(
    ['--git-dir', repoDir, 'rev-parse', '--verify', ref],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

export function createGitSource(cfg: GitSourceConfig) {
  /**
   * Install the push policy. Skipped when the current hook is already in
   * place, so repositories created before the policy changed are upgraded the
   * next time they are used.
   */
  async function installServerPolicy(repoDir: string): Promise<void> {
    const hook = path.join(repoDir, 'hooks', 'pre-receive');
    const current = await readFile(hook, 'utf8').catch(() => null);
    if (current === PRE_RECEIVE_HOOK) return;
    await runGit([
      '--git-dir',
      repoDir,
      'config',
      'receive.maxInputSize',
      String(MAX_PUSH_BYTES),
    ]);
    await runGit([
      '--git-dir',
      repoDir,
      'config',
      'receive.fsckObjects',
      'true',
    ]);
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, PRE_RECEIVE_HOOK, { mode: 0o755 });
    await chmod(hook, 0o755);
  }

  async function ensureRepo(id: string): Promise<string> {
    const repoDir = cfg.repoDir(id);
    if (!(await pathExists(repoDir))) {
      await mkdir(path.dirname(repoDir), { recursive: true });
      await runGit([
        'init',
        '--bare',
        '--initial-branch',
        SOURCE_BRANCH,
        repoDir,
      ]);
    }
    await installServerPolicy(repoDir);
    return repoDir;
  }

  async function masterCommit(id: string): Promise<string | null> {
    return refCommit(cfg.repoDir(id), `refs/heads/${SOURCE_BRANCH}`);
  }

  const treeBudget = cfg.treeBudget ?? SOURCE_TREE_BUDGET;

  function notOnMaster(id: string, commit: string): AppError {
    return new AppError(
      `Cannot deploy ${cfg.noun} "${id}": commit ${commit} is not on ` +
        `${SOURCE_BRANCH}. Push it to ${SOURCE_BRANCH} first.`,
      409,
      { code: COMMIT_NOT_ON_MASTER_ERROR },
    );
  }

  /**
   * Whether `commit` is still on master: a restore moves master back, so a
   * newer version's commit may no longer be deployable. Rejects when Git
   * cannot tell (an unreadable repository), which is not "not on master".
   */
  async function commitOnMaster(id: string, commit: string): Promise<boolean> {
    const repoDir = await ensureRepo(id);
    return isOnMaster(repoDir, commit);
  }

  /** Whether `ref` names a commit; rejects when Git cannot tell. */
  async function hasCommit(repoDir: string, ref: string): Promise<boolean> {
    const result = await runGit(
      ['--git-dir', repoDir, 'rev-parse', '--verify', '--quiet', ref],
      { allowFailure: true },
    );
    // --quiet --verify exits 1 for a name that is no object, 128 on errors.
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(
      `git rev-parse ${ref} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  /** True when `commit` is the master tip or one of its ancestors. */
  async function isOnMaster(repoDir: string, commit: string): Promise<boolean> {
    const master = `refs/heads/${SOURCE_BRANCH}`;
    if (!(await hasCommit(repoDir, `${master}^{commit}`))) return false;
    if (!(await hasCommit(repoDir, `${commit}^{commit}`))) return false;
    const result = await runGit(
      ['--git-dir', repoDir, 'merge-base', '--is-ancestor', commit, master],
      { allowFailure: true },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(
      `git merge-base ${commit} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  /**
   * Resolve the commit a deploy releases: the requested commit, or the master
   * tip when none is given. Only commits on master can be deployed.
   */
  async function resolveDeployCommit(
    id: string,
    requested?: string,
  ): Promise<string> {
    const repoDir = await ensureRepo(id);
    const master = await masterCommit(id);
    if (!master) {
      throw new AppError(
        `${capitalize(cfg.noun)} "${id}" has no committed source on ` +
          `${SOURCE_BRANCH} yet. Commit and push first.`,
        409,
      );
    }
    // Builds check out and package SHA-1 commit ids only, so a deployment
    // that could never be built is refused here, before it is created.
    const unsupported = () =>
      new AppError(
        `${capitalize(cfg.noun)} "${id}" uses SHA-256 commit ids, which ` +
          'deployments do not support yet.',
        400,
      );
    if (!requested) {
      if (!COMMIT_ID.test(master)) throw unsupported();
      return master;
    }
    if (/^[0-9a-f]{64}$/.test(requested)) throw unsupported();
    if (!COMMIT_ID.test(requested)) {
      throw new AppError(
        'Deploy commit must be a full 40-character commit id.',
        400,
      );
    }
    const commit = await refCommit(repoDir, `${requested}^{commit}`);
    if (!commit || !(await isOnMaster(repoDir, commit))) {
      throw notOnMaster(id, requested);
    }
    return commit;
  }

  /**
   * Tag the released commit. Master is not moved: the commit got there by a
   * push. Called under the deploy lock that rollback shares, so the commit is
   * re-checked against master in case a rollback rewound it meanwhile.
   */
  async function publishDeploymentSource(
    id: string,
    commit: string,
    version: number,
  ): Promise<PublishedSource> {
    const repoDir = await ensureRepo(id);
    if (!(await isOnMaster(repoDir, commit))) throw notOnMaster(id, commit);

    // Tags are named by release version (deploy/v1, deploy/v2, ...). The
    // version is assigned from successful-deployment history, so any
    // pre-existing tag for this version is a stale leftover from a failed
    // attempt whose cleanup didn't run (e.g. the process was killed).
    // Force-move it onto the new commit rather than failing the deploy.
    const tag = `${DEPLOY_TAG_PREFIX}v${version}`;
    await runGit(['--git-dir', repoDir, 'tag', '-f', tag, commit]);
    return { commit, tag, repoPath: repoDir };
  }

  /**
   * Delete a deployment tag. Used to roll back the tag created for a deploy
   * that failed after tagging, so a failed attempt leaves no Git history —
   * mirroring the database, which records no deployment row for failures.
   */
  async function deleteDeploymentTag(id: string, tag: string): Promise<void> {
    if (!tag.startsWith(DEPLOY_TAG_PREFIX)) return;
    await runGit(['--git-dir', cfg.repoDir(id), 'tag', '-d', tag], {
      allowFailure: true,
    });
  }

  async function moveMasterToDeploymentTag(
    id: string,
    tag: string,
  ): Promise<string> {
    const repoDir = await ensureRepo(id);
    if (!tag.startsWith(DEPLOY_TAG_PREFIX)) {
      throw new Error(`Invalid deployment tag: ${tag}`);
    }
    const commit = await refCommit(repoDir, `refs/tags/${tag}`);
    if (!commit) throw new Error(`Deployment tag not found: ${tag}`);
    await runGit([
      '--git-dir',
      repoDir,
      'update-ref',
      `refs/heads/${SOURCE_BRANCH}`,
      commit,
    ]);
    return commit;
  }

  /**
   * Check `commit` out into `target`, a directory that does not exist yet.
   * A tree over the source budget is refused before anything is written.
   */
  async function checkoutCommitInto(
    id: string,
    commit: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const repoDir = await ensureRepo(id);
    if (!COMMIT_ID.test(commit)) {
      throw new AppError('Commit must be a full commit id.', 400);
    }
    await assertTreeWithinBudget(repoDir, commit, treeBudget, signal);
    await checkoutCommit({
      repo: { gitDir: repoDir },
      commit,
      target,
      signal,
    });
  }

  /**
   * The tree of `commit` as a gzipped tar stream, for a build elsewhere: a
   * checkout (src/app-build/checkout.ts), so archive-only attributes such as
   * `export-ignore` leave the source intact.
   *
   * Resolves once the checkout is written, so a commit over the source
   * budget or one that cannot be checked out rejects before any byte is
   * sent. The stream ends only after tar succeeded; a failed tar destroys it
   * with an error instead. Destroying the stream (or aborting `signal`)
   * stops tar. Either way the checkout is removed once tar has exited.
   */
  async function archiveCommit(
    id: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<Readable> {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'hatch-source-'));
    const tree = path.join(scratch, 'tree');
    try {
      await checkoutCommitInto(id, commit, tree, signal);
      signal?.throwIfAborted();
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
    const child = spawn('tar', ['-czf', '-', '-C', tree, '.'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = new PassThrough();
    let stderr = '';
    let exited = false;
    const stop = () => {
      if (!exited) child.kill('SIGKILL');
    };
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.stdout.pipe(output, { end: false });
    output.once('close', stop);
    signal?.addEventListener('abort', () => output.destroy(), { once: true });
    const finish = (error: Error | null) => {
      if (exited) return;
      exited = true;
      if (error) output.destroy(error);
      else output.end();
      void rm(scratch, { recursive: true, force: true }).catch((cleanup) => {
        console.error(`[source] could not remove ${scratch}:`, cleanup);
      });
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code) =>
      finish(
        code === 0
          ? null
          : new Error(`Could not archive the source: ${stderr.trim()}`),
      ),
    );
    return output;
  }

  return {
    ensureRepo,
    masterCommit,
    archiveCommit,
    checkoutCommitInto,
    commitOnMaster,
    resolveDeployCommit,
    publishDeploymentSource,
    deleteDeploymentTag,
    moveMasterToDeploymentTag,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
