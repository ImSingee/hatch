/**
 * A build must see every tracked file of its commit with the committed
 * bytes, on any host: archive-only attributes, line-ending settings and
 * filters must not change the source, the caller's own index and work tree
 * stay as they were, and no tree can make the checkout write outside its
 * target.
 */
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CommitCheckoutError, checkoutCommit } from './checkout';

const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-checkout-test-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const repo = path.join(root, 'repo');
const run = (args: string[], input?: Buffer) =>
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgSign=false', ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
const git = (...args: string[]) => run(args);

/** The committed bytes, whatever attributes and settings say. */
const committed: Record<string, string> = {
  '.gitattributes': [
    'manifest.ts export-ignore',
    'version.txt export-subst',
    '*.txt text eol=crlf',
    'id.txt ident',
    '*.dat filter=upper',
    '',
  ].join('\n'),
  'manifest.ts': 'export default {};\n',
  'version.txt': '$Format:%H$\n',
  'lf.txt': 'one\ntwo\n',
  'mixed.js': 'one\r\ntwo\n',
  'id.txt': '$Id$\n',
  'data.dat': 'lower case\n',
  'bin/run.sh': '#!/bin/sh\n',
};

execFileSync('git', ['init', '-q', '-b', 'master', repo]);
git('config', 'core.autocrlf', 'false');
for (const [name, body] of Object.entries(committed)) {
  await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
  await writeFile(path.join(repo, name), body);
}
git('add', '-A');
git('update-index', '--chmod=+x', 'bin/run.sh');
const linkBlob = run(['hash-object', '-w', '--stdin'], Buffer.from('lf.txt'));
git('update-index', '--add', '--cacheinfo', `120000,${linkBlob},link`);
// A submodule: its commit is not in this repository.
git('update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},sub`);
git('commit', '-q', '-m', 'App');
const commit = git('rev-parse', 'HEAD');
// What the author's checkout would apply on checkout, from here on.
git('config', 'core.autocrlf', 'true');
git('config', 'core.symlinks', 'false');
git('config', 'filter.upper.smudge', 'tr a-z A-Z');
git('config', 'filter.upper.clean', 'cat');

const bare = path.join(root, 'bare.git');
execFileSync('git', ['clone', '-q', '--bare', repo, bare]);

/** A commit of a hand-made root tree, which Git itself would not write. */
function craftedCommit(
  entries: [mode: string, name: string, object: string][],
): string {
  const tree = Buffer.concat(
    entries.map(([mode, name, object]) =>
      Buffer.concat([
        Buffer.from(`${mode} ${name}\0`),
        Buffer.from(object, 'hex'),
      ]),
    ),
  );
  const id = run(
    ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'],
    tree,
  );
  return git('commit-tree', id, '-m', 'crafted');
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, name);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) files[name] = `-> ${await readlink(file)}`;
    else if (stat.isFile()) {
      files[name] =
        `${stat.mode & 0o100 ? 'x' : '-'} ${await readFile(file, 'latin1')}`;
    } else files[name] = 'dir';
  }
  return files;
}

describe('checking out a commit for a build', () => {
  it('writes the committed bytes, whatever the attributes and settings', async () => {
    // Uncommitted work in the caller's checkout stays where it is.
    await writeFile(
      path.join(repo, 'manifest.ts'),
      'export const draft = 1;\n',
    );
    git('add', 'manifest.ts');
    const target = path.join(root, 'tree');
    await checkoutCommit({ repo: { cwd: repo }, commit, target });

    const expected: Record<string, string> = { bin: 'dir', link: '-> lf.txt' };
    for (const [name, body] of Object.entries(committed)) {
      expected[name] = `${name === 'bin/run.sh' ? 'x' : '-'} ${body}`;
    }
    expect(await snapshot(target)).toEqual(expected);
    expect(git('diff', '--cached', '--name-only')).toBe('manifest.ts');
    expect(await readFile(path.join(repo, 'manifest.ts'), 'utf8')).toBe(
      'export const draft = 1;\n',
    );

    // The Builder's bare copy, without any of those settings, matches.
    const fromBare = path.join(root, 'bare-tree');
    await checkoutCommit({ repo: { gitDir: bare }, commit, target: fromBare });
    expect(await snapshot(fromBare)).toEqual(expected);
  });

  it('reports a commit the repository does not have', async () => {
    const target = path.join(root, 'missing');
    await expect(
      checkoutCommit({ repo: { cwd: repo }, commit: 'f'.repeat(40), target }),
    ).rejects.toSatisfy(
      (error) => error instanceof CommitCheckoutError && error.missingCommit,
    );
    await expect(lstat(target)).rejects.toThrow(/ENOENT/);
  });

  it('keeps a repository Git cannot read apart from a missing commit', async () => {
    await expect(
      checkoutCommit({
        repo: { gitDir: path.join(root, 'no-such-repo.git') },
        commit,
        target: path.join(root, 'unreadable'),
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof CommitCheckoutError &&
        !error.missingCommit &&
        /not a git repository/.test(error.message),
    );
  });

  it('never writes outside the target, whatever the tree holds', async () => {
    const blob = run(['hash-object', '-w', '--stdin'], Buffer.from('x'));
    const escapeName = 'escape-target';
    // A directory a link in the tree points to.
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    const subtree = (name: string) =>
      run(
        ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'],
        Buffer.concat([
          Buffer.from(`100644 ${name}\0`),
          Buffer.from(blob, 'hex'),
        ]),
      );
    const linkToOutside = run(
      ['hash-object', '-w', '--stdin'],
      Buffer.from(outside),
    );
    const cases: [string, string, RegExp][] = [
      [
        'a parent path',
        craftedCommit([['40000', '..', subtree(escapeName)]]),
        /unsafe path/,
      ],
      [
        'a repository directory',
        craftedCommit([['40000', '.GIT', subtree('config')]]),
        /unsafe path/,
      ],
      [
        // The link comes first in the tree; writing below it would land in
        // the directory it points to.
        'a path below a link of the same name',
        craftedCommit([
          ['120000', 'dir', linkToOutside],
          ['40000', 'dir', subtree('file')],
        ]),
        /conflicting paths/,
      ],
    ];
    const work = path.join(root, 'work');
    await mkdir(work);
    // Each case fails with its own message, which names the failing one.
    for (const [, crafted, message] of cases) {
      const target = path.join(work, 'tree');
      await expect(
        checkoutCommit({ repo: { cwd: repo }, commit: crafted, target }),
      ).rejects.toThrow(message);
      // Nothing next to the target, in the linked directory, or left over.
      expect(await readdir(work)).toEqual([]);
      expect(await readdir(outside)).toEqual([]);
    }
  });
});
