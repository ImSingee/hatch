/**
 * Source release over the App repository:
 *
 *   client clones platform master and commits -> client pushes HEAD to
 *   master (fast-forward only) -> a deployment resolves the commit -> its
 *   build reads the commit archive -> publishDeploymentSource (deploy tag).
 *
 * Everything runs against throwaway temp dirs.
 */
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createGitSource } from '~server/source-git';

const root = await mkdtemp(path.join(tmpdir(), 'hatch-bundle-rt-'));

const platform = createGitSource({
  noun: 'app',
  repoDir: (id) => path.join(root, 'repos', `${id}.git`),
});

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(' ')} failed: ${err || out}`));
    });
  });
}

async function commitAll(worktree: string, message: string): Promise<string> {
  await git(['add', '-A'], worktree);
  await git(['commit', '-m', message], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

async function configureIdentity(worktree: string): Promise<void> {
  await git(['config', 'user.email', 't@t'], worktree);
  await git(['config', 'user.name', 't'], worktree);
}

/** Push a worktree's HEAD to platform master, as `hatch app push` does. */
async function pushHead(id: string, worktree: string): Promise<string> {
  const repoDir = await platform.ensureRepo(id);
  await git(['push', repoDir, 'HEAD:refs/heads/master'], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

/** Read one file of a commit archive, as a build of that commit does. */
async function archivedFile(
  id: string,
  commit: string,
  file: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(root, 'archive-'));
  const archive = path.join(dir, 'source.tar.gz');
  await writeFile(archive, await platform.archiveCommit(id, commit));
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', dir]);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)),
    );
  });
  return readFile(path.join(dir, file), 'utf8');
}

/** Push a worktree's HEAD to platform master and tag it as released. */
async function pushAndRelease(
  id: string,
  worktree: string,
  version: number,
): Promise<string> {
  const commit = await pushHead(id, worktree);
  await platform.publishDeploymentSource(id, commit, version);
  return commit;
}

async function seedPlatformSource(
  id: string,
  contents = 'v1\n',
): Promise<string> {
  const seed = path.join(root, `seed-${id}`);
  await mkdir(seed, { recursive: true });
  await git(['init', '--initial-branch', 'master'], seed);
  await configureIdentity(seed);
  await writeFile(path.join(seed, 'README.md'), contents);
  const commit = await commitAll(seed, `seed ${id}`);
  await pushAndRelease(id, seed, 1);
  return commit;
}

/** Clone platform master into a fresh client checkout, as Git fetch does. */
async function cloneMaster(id: string, name: string): Promise<string> {
  const checkout = path.join(root, 'clients', `${id}-${name}`);
  await mkdir(path.dirname(checkout), { recursive: true });
  await git(
    [
      'clone',
      '--branch',
      'master',
      path.join(root, 'repos', `${id}.git`),
      checkout,
    ],
    root,
  );
  await configureIdentity(checkout);
  return checkout;
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('source release (platform)', () => {
  const APP_ID = 'rt-app';

  it('transfers source both ways and fast-forwards canonical master', async () => {
    // -- Seed the canonical repo with an initial commit (platform side). ----
    const seed = path.join(root, 'seed');
    await mkdir(seed, { recursive: true });
    await git(['init', '--initial-branch', 'master'], seed);
    await configureIdentity(seed);
    await writeFile(path.join(seed, 'README.md'), 'v1\n');
    const seedCommit = await commitAll(seed, 'seed v1');
    await pushAndRelease(APP_ID, seed, 1);
    await expect(platform.masterCommit(APP_ID)).resolves.toBe(seedCommit);

    // -- Platform -> client: export master as a bundle and clone it. -------
    const checkout = await cloneMaster(APP_ID, 'client');
    await expect(git(['rev-parse', 'HEAD'], checkout)).resolves.toBe(
      seedCommit,
    );
    await expect(git(['rev-parse', 'deploy/v1'], checkout)).resolves.toBe(
      seedCommit,
    );
    await expect(
      readFile(path.join(checkout, 'README.md'), 'utf8'),
    ).resolves.toBe('v1\n');

    // -- Client work: edit + commit. ----------------------------------------
    await writeFile(path.join(checkout, 'README.md'), 'v2\n');
    const localCommit = await commitAll(checkout, 'client edit');

    // -- Client -> platform: push HEAD, then release it. --------------------
    const pushed = await pushHead(APP_ID, checkout);
    expect(pushed).toBe(localCommit);
    await expect(platform.masterCommit(APP_ID)).resolves.toBe(localCommit);

    // A deployment resolves the pushed commit; its build reads that
    // commit's tree, and an earlier commit's tree stays as it was.
    const release = await platform.resolveDeployCommit(APP_ID);
    expect(release).toBe(localCommit);
    await expect(archivedFile(APP_ID, release, 'README.md')).resolves.toBe(
      'v2\n',
    );
    await expect(archivedFile(APP_ID, seedCommit, 'README.md')).resolves.toBe(
      'v1\n',
    );
    const published = await platform.publishDeploymentSource(
      APP_ID,
      release,
      2,
    );
    expect(published).toMatchObject({ commit: localCommit, tag: 'deploy/v2' });

    // An earlier commit on master can be released again; one that never
    // reached master cannot, and neither moves master.
    await expect(
      platform.resolveDeployCommit(APP_ID, seedCommit),
    ).resolves.toBe(seedCommit);
    await writeFile(path.join(seed, 'README.md'), 'never pushed\n');
    const unpushed = await commitAll(seed, 'never pushed');
    await expect(
      platform.resolveDeployCommit(APP_ID, unpushed),
    ).rejects.toThrow(/is not on master/);
    await expect(
      platform.publishDeploymentSource(APP_ID, unpushed, 9),
    ).rejects.toThrow(/is not on master/);
    await expect(platform.masterCommit(APP_ID)).resolves.toBe(localCommit);

    // Restoring v1 moves master back: v2's commit is then not on master, so
    // it is not offered for (or accepted by) a rebuild until pushed again.
    await expect(platform.commitOnMaster(APP_ID, localCommit)).resolves.toBe(
      true,
    );
    await platform.moveMasterToDeploymentTag(APP_ID, 'deploy/v1');
    await expect(platform.commitOnMaster(APP_ID, localCommit)).resolves.toBe(
      false,
    );
    await expect(platform.commitOnMaster(APP_ID, seedCommit)).resolves.toBe(
      true,
    );
    await expect(
      platform.resolveDeployCommit(APP_ID, localCommit),
    ).rejects.toMatchObject({ code: 'deployments.commitNotOnMaster' });
  }, 15_000);

  it('rejects a stale push that is not a fast-forward of master', async () => {
    // A second client clones, commits on top of v2… -------------------------
    const stale = await cloneMaster(APP_ID, 'stale');
    await writeFile(path.join(stale, 'README.md'), 'stale\n');
    await commitAll(stale, 'stale edit');

    // …but master advances first (another deploy wins the race). ------------
    const winner = await cloneMaster(APP_ID, 'winner');
    await writeFile(path.join(winner, 'README.md'), 'winner\n');
    await commitAll(winner, 'winner edit');
    const winnerCommit = await pushHead(APP_ID, winner);

    // The stale push is not a fast-forward of master, so it is refused and
    // master stays put. (Git's wording depends on its advice settings.)
    await expect(pushHead(APP_ID, stale)).rejects.toThrow(/git push .* failed/);
    await expect(platform.masterCommit(APP_ID)).resolves.toBe(winnerCommit);
  }, 15_000);

  it('deploys an explicit old checkout after the same id is recreated', async () => {
    const id = 'rt-recreated-deploy';
    await seedPlatformSource(id, 'old source\n');
    const oldCheckout = await cloneMaster(id, 'old-checkout');
    await writeFile(path.join(oldCheckout, 'README.md'), 'restored source\n');
    const restoredCommit = await commitAll(oldCheckout, 'restore old checkout');

    // Entity deletion removes only Platform-owned source. A client checkout
    // remains, and a same-id recreation starts with an empty repo.
    await rm(path.join(root, 'repos', `${id}.git`), {
      recursive: true,
      force: true,
    });
    await expect(pushHead(id, oldCheckout)).resolves.toBe(restoredCommit);
    await expect(platform.masterCommit(id)).resolves.toBe(restoredCommit);
  }, 15_000);
});

describe('source the platform writes out', () => {
  it('refuses a tree over the source budget before writing any of it', async () => {
    const small = createGitSource({
      noun: 'app',
      repoDir: (id) => path.join(root, 'repos', `${id}.git`),
      treeBudget: { bytes: 1000, files: 3 },
    });
    const id = 'rt-budget';
    const seed = path.join(root, `seed-${id}`);
    await mkdir(seed, { recursive: true });
    await git(['init', '--initial-branch', 'master'], seed);
    await configureIdentity(seed);
    await writeFile(path.join(seed, 'README.md'), 'fits\n');
    const fits = await commitAll(seed, 'fits');
    await writeFile(path.join(seed, 'big.txt'), 'x'.repeat(2000));
    const tooLarge = await commitAll(seed, 'too large');
    await rm(path.join(seed, 'big.txt'));
    for (const name of ['a', 'b', 'c']) {
      await writeFile(path.join(seed, name), name);
    }
    const tooMany = await commitAll(seed, 'too many files');
    await pushHead(id, seed);

    const target = path.join(root, 'budget-checkout');
    for (const commit of [tooLarge, tooMany]) {
      await expect(small.archiveCommit(id, commit)).rejects.toMatchObject({
        status: 413,
        message: expect.stringMatching(/larger than the platform builds/),
      });
      await expect(
        small.checkoutCommitInto(id, commit, target),
      ).rejects.toMatchObject({ status: 413 });
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await small.checkoutCommitInto(id, fits, target);
    await expect(
      readFile(path.join(target, 'README.md'), 'utf8'),
    ).resolves.toBe('fits\n');
  }, 15_000);

  it('deploys SHA-1 commit ids only', async () => {
    const id = 'rt-commit-format';
    await seedPlatformSource(id);
    await expect(
      platform.resolveDeployCommit(id, 'a'.repeat(64)),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/SHA-256/),
    });
    await expect(
      platform.resolveDeployCommit(id, 'a'.repeat(39)),
    ).rejects.toMatchObject({ status: 400 });
  }, 15_000);

  it('tells a commit that is not on master from a lookup that failed', async () => {
    const id = 'rt-on-master';
    await seedPlatformSource(id);
    await expect(platform.commitOnMaster(id, 'e'.repeat(40))).resolves.toBe(
      false,
    );
    if (process.getuid?.() === 0) return; // root reads it regardless
    const objects = path.join(root, 'repos', `${id}.git`, 'objects');
    await chmod(objects, 0o000);
    try {
      await expect(platform.commitOnMaster(id, 'e'.repeat(40))).rejects.toThrow(
        /failed/,
      );
    } finally {
      await chmod(objects, 0o755);
    }
  }, 15_000);

  it('rejects instead of answering "not on master" when a pack cannot be read', async () => {
    // Git answers an object in an unreadable pack as absent, silently.
    if (process.getuid?.() === 0) return; // root reads it regardless
    const id = 'rt-unreadable-pack';
    const commit = await seedPlatformSource(id);
    const repoDir = path.join(root, 'repos', `${id}.git`);
    await git(['--git-dir', repoDir, 'repack', '-a', '-d', '-q'], root);
    const pack = path.join(repoDir, 'objects', 'pack');
    const packs = (await readdir(pack)).filter((name) =>
      name.endsWith('.pack'),
    );
    expect(packs).toHaveLength(1);
    await chmod(path.join(pack, packs[0]), 0o000);
    try {
      await expect(platform.commitOnMaster(id, commit)).rejects.toThrow(
        /failed/,
      );
      await expect(platform.resolveDeployCommit(id, commit)).rejects.toThrow(
        /failed/,
      );
    } finally {
      await chmod(path.join(pack, packs[0]), 0o444);
    }
    await expect(platform.commitOnMaster(id, commit)).resolves.toBe(true);
  }, 15_000);

  it('never takes a Git stopped by a signal for an answer', async () => {
    const id = 'rt-git-signal';
    await seedPlatformSource(id);
    // A commit the repository has, on a branch other than master.
    const seed = path.join(root, `seed-${id}`);
    await writeFile(path.join(seed, 'README.md'), 'side\n');
    const commit = await commitAll(seed, 'side');
    await git(
      ['push', await platform.ensureRepo(id), 'HEAD:refs/heads/side'],
      seed,
    );
    await expect(platform.commitOnMaster(id, commit)).resolves.toBe(false);
    // A `git` whose ancestry check is killed before it can answer.
    const realGit = (
      await new Promise<string>((resolve, reject) => {
        const child = spawn('sh', ['-c', 'command -v git']);
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.on('error', reject);
        child.on('close', () => resolve(out));
      })
    ).trim();
    const bin = await mkdtemp(path.join(root, 'fake-git-'));
    await writeFile(
      path.join(bin, 'git'),
      `#!/bin/sh\nfor arg in "$@"; do\n  [ "$arg" = merge-base ] && kill -KILL $$\ndone\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    try {
      await expect(platform.commitOnMaster(id, commit)).rejects.toThrow(
        /SIGKILL/,
      );
      await expect(platform.resolveDeployCommit(id, commit)).rejects.toThrow(
        /SIGKILL/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it('refuses an explicit commit of a SHA-256 repository', async () => {
    const id = 'rt-sha256';
    const repoDir = path.join(root, 'repos', `${id}.git`);
    await mkdir(path.dirname(repoDir), { recursive: true });
    await git(
      [
        'init',
        '--bare',
        '--object-format=sha256',
        '--initial-branch',
        'master',
        repoDir,
      ],
      root,
    );
    const seed = path.join(root, `seed-${id}`);
    await mkdir(seed, { recursive: true });
    await git(
      ['init', '--object-format=sha256', '--initial-branch', 'master'],
      seed,
    );
    await configureIdentity(seed);
    await writeFile(path.join(seed, 'README.md'), 'sha256\n');
    const commit = await commitAll(seed, 'seed sha256');
    expect(commit).toMatch(/^[0-9a-f]{64}$/);
    await pushHead(id, seed);
    const unsupported = {
      status: 400,
      message: expect.stringMatching(/SHA-256/),
    };
    await expect(platform.resolveDeployCommit(id)).rejects.toMatchObject(
      unsupported,
    );
    // Forty digits of a SHA-256 id would otherwise resolve as an abbreviation.
    await expect(
      platform.resolveDeployCommit(id, commit.slice(0, 40)),
    ).rejects.toMatchObject(unsupported);
  }, 15_000);
});
