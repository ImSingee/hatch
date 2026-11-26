/**
 * A build must see every tracked file of its commit with the committed
 * contents, as a clone would: archive-only attributes must not change the
 * source, and the caller's own index and work tree stay as they were.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CommitCheckoutError, checkoutCommit } from './checkout';

const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-checkout-test-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const repo = path.join(root, 'repo');
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();

execFileSync('git', ['init', '-q', '-b', 'master', repo]);
await writeFile(
  path.join(repo, '.gitattributes'),
  'manifest.ts export-ignore\nversion.txt export-subst\n',
);
await writeFile(path.join(repo, 'manifest.ts'), 'export default {};\n');
await writeFile(path.join(repo, 'version.txt'), '$Format:%H$\n');
git('add', '-A');
git('commit', '-q', '-m', 'App');
const commit = git('rev-parse', 'HEAD');

describe('checking out a commit for a build', () => {
  it('keeps files and contents that archive attributes would change', async () => {
    // Uncommitted work in the caller's checkout stays where it is.
    await writeFile(
      path.join(repo, 'manifest.ts'),
      'export const draft = 1;\n',
    );
    git('add', 'manifest.ts');
    const target = path.join(root, 'tree');
    await checkoutCommit({ repo: { cwd: repo }, commit, target });
    expect((await readdir(target)).sort()).toEqual([
      '.gitattributes',
      'manifest.ts',
      'version.txt',
    ]);
    expect(await readFile(path.join(target, 'manifest.ts'), 'utf8')).toBe(
      'export default {};\n',
    );
    expect(await readFile(path.join(target, 'version.txt'), 'utf8')).toBe(
      '$Format:%H$\n',
    );
    expect(git('diff', '--cached', '--name-only')).toBe('manifest.ts');
    expect(await readFile(path.join(repo, 'manifest.ts'), 'utf8')).toBe(
      'export const draft = 1;\n',
    );
  });

  it('reads a bare repository the same way', async () => {
    const bare = path.join(root, 'bare.git');
    execFileSync('git', ['clone', '-q', '--bare', repo, bare]);
    const target = path.join(root, 'bare-tree');
    await checkoutCommit({ repo: { gitDir: bare }, commit, target });
    expect(await readFile(path.join(target, 'manifest.ts'), 'utf8')).toBe(
      'export default {};\n',
    );
  });

  it('reports a commit the repository does not have', async () => {
    await expect(
      checkoutCommit({
        repo: { cwd: repo },
        commit: 'f'.repeat(40),
        target: path.join(root, 'missing'),
      }),
    ).rejects.toSatisfy(
      (error) => error instanceof CommitCheckoutError && error.missingCommit,
    );
  });
});
