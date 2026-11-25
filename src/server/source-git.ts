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
import { AppError } from './errors';

export const SOURCE_BRANCH = 'master';
export const DEPLOY_TAG_PREFIX = 'deploy/';
/** Largest pack a single push may send; matches the deploy RPC body cap. */
export const MAX_PUSH_BYTES = 256 * 1024 * 1024;

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
  repoDir: (id: string) => string;
  deployCheckoutDir: (id: string) => string;
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
 * Ref policy for pushes. The Platform's own local fetch/update-ref/tag calls
 * do not run hooks, so deploy and rollback are unaffected.
 */
const PRE_RECEIVE_HOOK = `#!/bin/sh
# hatch-ref-policy v3
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
    refs/heads/*|refs/tags/*) ;;
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

async function setLocalGitIdentity(worktree: string): Promise<void> {
  await runGit(['config', 'user.name', 'Hatch Agent'], { cwd: worktree });
  await runGit(['config', 'user.email', 'agent@hatch.local'], {
    cwd: worktree,
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

  function notOnMaster(id: string, commit: string): AppError {
    return new AppError(
      `Cannot deploy ${cfg.noun} "${id}": commit ${commit} is not on ` +
        `${SOURCE_BRANCH}. Push it to ${SOURCE_BRANCH} first.`,
      409,
    );
  }

  /** True when `commit` is the master tip or one of its ancestors. */
  async function isOnMaster(repoDir: string, commit: string): Promise<boolean> {
    const result = await runGit(
      [
        '--git-dir',
        repoDir,
        'merge-base',
        '--is-ancestor',
        commit,
        `refs/heads/${SOURCE_BRANCH}`,
      ],
      { allowFailure: true },
    );
    return result.exitCode === 0;
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
    if (!requested) return master;
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(requested)) {
      throw new AppError('Deploy commit must be a full commit id.', 400);
    }
    const commit = await refCommit(repoDir, `${requested}^{commit}`);
    if (!commit || !(await isOnMaster(repoDir, commit))) {
      throw notOnMaster(id, requested);
    }
    return commit;
  }

  /**
   * Check out `commit` from the canonical repo into a checkout of its own.
   * Each deploy attempt gets a fresh directory, so concurrent attempts, also
   * from other processes, never build each other's source. The caller removes
   * it when the attempt ends.
   */
  async function prepareDeployCheckout(
    id: string,
    commit: string,
  ): Promise<string> {
    const repoDir = await ensureRepo(id);
    const base = cfg.deployCheckoutDir(id);
    await mkdir(path.dirname(base), { recursive: true });
    const checkout = await mkdtemp(`${base}-`);
    try {
      await runGit(['clone', '--no-checkout', repoDir, checkout]);
      await runGit(['checkout', '--detach', commit], { cwd: checkout });
      await setLocalGitIdentity(checkout);
      return checkout;
    } catch (error) {
      await rm(checkout, { recursive: true, force: true });
      throw error;
    }
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

  /**
   * Push an uploaded bundle's HEAD to master, as a fast-forward only. This is
   * the bundle transport's equivalent of `git push`, used by Agent Tool
   * deploys and by CLI versions that predate the Git endpoint. Returns the
   * pushed commit.
   */
  async function importBundleToMaster(
    id: string,
    bundle: Buffer,
  ): Promise<string> {
    const repoDir = await ensureRepo(id);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'hatch-push-'));
    try {
      const bundleFile = path.join(tmp, 'incoming.bundle');
      await writeFile(bundleFile, bundle);
      const verify = await runGit(
        ['--git-dir', repoDir, 'bundle', 'verify', bundleFile],
        { allowFailure: true },
      );
      // A bundle with prerequisites missing from the canonical repo fails
      // verify: the checkout is based on history this repo doesn't have.
      if (verify.exitCode !== 0) {
        throw new AppError(
          `Cannot deploy ${cfg.noun} "${id}": the uploaded source bundle ` +
            `does not apply to the canonical repository. Run checkout again ` +
            `to sync with ${SOURCE_BRANCH}, rebase your work, then retry.`,
          409,
        );
      }
      // A worktree bundle names HEAD; a bundle exported from this repository
      // names only the branch.
      const heads = new Map(
        (await runGit(['bundle', 'list-heads', bundleFile])).stdout
          .trim()
          .split('\n')
          .map((line) => line.split(' '))
          .map(([sha, ref]) => [ref, sha] as const),
      );
      const ref = heads.has('HEAD') ? 'HEAD' : `refs/heads/${SOURCE_BRANCH}`;
      const commit = heads.get(ref);
      if (!commit) {
        throw new AppError(
          `Cannot deploy ${cfg.noun} "${id}": the uploaded source bundle ` +
            `has neither HEAD nor ${SOURCE_BRANCH}.`,
          400,
        );
      }
      // Without a leading "+", fetch refuses anything but a fast-forward. A
      // concurrent upload of the same commit can win the ref lock instead; that
      // push has then already happened, so retry once and accept master
      // sitting exactly on this commit.
      for (let attempt = 0; attempt < 2; attempt++) {
        const pushed = await runGit(
          [
            '--git-dir',
            repoDir,
            'fetch',
            '--no-tags',
            bundleFile,
            `${ref}:refs/heads/${SOURCE_BRANCH}`,
          ],
          { allowFailure: true },
        );
        if (pushed.exitCode === 0 || (await masterCommit(id)) === commit)
          return commit;
      }
      throw new AppError(
        `Cannot deploy ${cfg.noun} "${id}" because ${SOURCE_BRANCH} ` +
          `advanced. Run "git fetch origin ${SOURCE_BRANCH}" and rebase ` +
          'your work before deploying.',
        409,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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

  return {
    ensureRepo,
    masterCommit,
    resolveDeployCommit,
    prepareDeployCheckout,
    publishDeploymentSource,
    deleteDeploymentTag,
    moveMasterToDeploymentTag,
    importBundleToMaster,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
