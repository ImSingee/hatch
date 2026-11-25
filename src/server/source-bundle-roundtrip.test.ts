/**
 * Platform source transfer over the deprecated bundle upload that DeployApp
 * still accepts:
 *
 *   client clones platform master and commits -> client bundles HEAD ->
 *   platform importBundleToMaster (fast-forward master) ->
 *   publishDeploymentSource (deploy tag).
 *
 * Everything runs against throwaway temp dirs.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitSource } from '~server/source-git';

const root = await mkdtemp(path.join(tmpdir(), 'hatch-bundle-rt-'));

const platform = createGitSource({
  noun: 'app',
  repoDir: (id) => path.join(root, 'repos', `${id}.git`),
  deployCheckoutDir: (id) => path.join(root, 'checkouts', id),
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

/** Bundle a worktree's HEAD the way a client uploads it. */
async function bundleHead(worktree: string): Promise<Buffer> {
  const file = path.join(
    root,
    `${path.basename(worktree)}-${Date.now()}.bundle`,
  );
  await git(['bundle', 'create', file, 'HEAD'], worktree);
  return readFile(file);
}

/** Push a worktree's HEAD to platform master and tag it as released. */
async function pushAndRelease(
  id: string,
  worktree: string,
  version: number,
): Promise<string> {
  const commit = await platform.importBundleToMaster(
    id,
    await bundleHead(worktree),
  );
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

describe('git bundle source transfer (platform)', () => {
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

    // -- Client -> platform: bundle HEAD, stage it, publish. ----------------
    const pushed = await platform.importBundleToMaster(
      APP_ID,
      await bundleHead(checkout),
    );
    expect(pushed).toBe(localCommit);
    await expect(platform.masterCommit(APP_ID)).resolves.toBe(localCommit);

    // The deploy pipeline builds the pushed commit from a fresh checkout.
    const release = await platform.resolveDeployCommit(APP_ID);
    expect(release).toBe(localCommit);
    const built = await platform.prepareDeployCheckout(APP_ID, release);
    await expect(readFile(path.join(built, 'README.md'), 'utf8')).resolves.toBe(
      'v2\n',
    );
    // A concurrent attempt gets its own checkout and disturbs neither.
    const concurrent = await platform.prepareDeployCheckout(APP_ID, seedCommit);
    expect(concurrent).not.toBe(built);
    await expect(
      readFile(path.join(concurrent, 'README.md'), 'utf8'),
    ).resolves.toBe('v1\n');
    await expect(readFile(path.join(built, 'README.md'), 'utf8')).resolves.toBe(
      'v2\n',
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
  }, 15_000);

  it('rejects a stale bundle that is not a fast-forward of master', async () => {
    // A second client clones, commits on top of v2… -------------------------
    const stale = await cloneMaster(APP_ID, 'stale');
    await writeFile(path.join(stale, 'README.md'), 'stale\n');
    await commitAll(stale, 'stale edit');
    const staleBundle = await bundleHead(stale);

    // …but master advances first (another deploy wins the race). ------------
    const winner = await cloneMaster(APP_ID, 'winner');
    await writeFile(path.join(winner, 'README.md'), 'winner\n');
    await commitAll(winner, 'winner edit');
    const winnerCommit = await platform.importBundleToMaster(
      APP_ID,
      await bundleHead(winner),
    );

    // The stale bundle is self-contained history, but it is not a
    // fast-forward of master, so the push is refused and master stays put.
    await expect(
      platform.importBundleToMaster(APP_ID, staleBundle),
    ).rejects.toThrow(/master advanced/);
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
    await expect(
      platform.importBundleToMaster(id, await bundleHead(oldCheckout)),
    ).resolves.toBe(restoredCommit);
    await expect(platform.masterCommit(id)).resolves.toBe(restoredCommit);
  }, 15_000);
});
