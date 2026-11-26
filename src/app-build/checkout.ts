/**
 * Check out the tree of one commit into an empty directory without touching
 * the repository's own index or work tree: a temporary index read from the
 * commit, then `checkout-index` into the target.
 *
 * This is a checkout, not `git archive`: `export-ignore` and `export-subst`
 * attributes do not apply, so the build sees every tracked file with its
 * committed contents, exactly as in a clone. The CLI's local build and the
 * Builder's source download both use it, so both build the same files.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class CommitCheckoutError extends Error {
  constructor(
    message: string,
    readonly missingCommit: boolean,
  ) {
    super(message);
    this.name = 'CommitCheckoutError';
  }
}

function git(
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export async function checkoutCommit(options: {
  /** The repository (`--git-dir` of a bare one, or a work tree root). */
  repo: { gitDir: string } | { cwd: string };
  /** Full commit id. */
  commit: string;
  /** Directory to create; it must not exist yet. */
  target: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(options.commit)) {
    throw new CommitCheckoutError('Commit must be a full commit id.', false);
  }
  const location =
    'gitDir' in options.repo
      ? ['--git-dir', options.repo.gitDir]
      : ['-C', options.repo.cwd];
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'hatch-checkout-'));
  const env = {
    ...(options.env ?? process.env),
    GIT_INDEX_FILE: path.join(scratch, 'index'),
  };
  try {
    const read = await git(
      [...location, 'read-tree', `${options.commit}^{tree}`],
      env,
      options.signal,
    );
    if (read.code !== 0) {
      throw new CommitCheckoutError(
        `Commit ${options.commit} is not in the repository: ${read.stderr.trim()}`,
        true,
      );
    }
    await mkdir(options.target);
    const checkedOut = await git(
      [
        ...location,
        '--work-tree',
        options.target,
        'checkout-index',
        '--all',
        '--force',
      ],
      env,
      options.signal,
    );
    if (checkedOut.code !== 0) {
      throw new CommitCheckoutError(
        `Could not check out ${options.commit}: ${checkedOut.stderr.trim()}`,
        false,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
