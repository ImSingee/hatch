/**
 * Files the platform sends (SDK files into `.hatch`, scaffold files into a
 * checkout) are written only below their root: no traversal, no repository
 * or install directory, no duplicate.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFiles } from './workspace';

const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-write-files-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const body = Buffer.from('x').toString('base64');

describe('writing platform files', () => {
  it.each([
    '../escape.js',
    'a/../../escape.js',
    '',
    'a//b.js',
    '.git/config',
    'node_modules/x.js',
    'a\\b.js',
    'c:/x.js',
    '.hatch/x.js',
    'a/\u0007.js',
  ])('refuses %j and writes nothing', async (unsafe) => {
    const target = await mkdtemp(path.join(root, 'target-'));
    await expect(
      writeFiles(target, [{ path: unsafe, contentBase64: body }]),
    ).rejects.toMatchObject({ code: 'unsafe_payload' });
    expect(await readdir(target)).toEqual([]);
    expect(await readdir(root)).not.toContain('escape.js');
  });

  it('refuses a repeated path', async () => {
    const target = await mkdtemp(path.join(root, 'target-'));
    await expect(
      writeFiles(target, [
        { path: 'a.js', contentBase64: body },
        { path: 'a.js', contentBase64: body },
      ]),
    ).rejects.toMatchObject({ code: 'unsafe_payload' });
    // Nothing of a refused payload is written, not even its safe files.
    expect(await readdir(target)).toEqual([]);
  });

  it('writes none of a payload whose last path is unsafe', async () => {
    const target = await mkdtemp(path.join(root, 'target-'));
    await expect(
      writeFiles(target, [
        { path: 'ok/first.js', contentBase64: body },
        { path: '../escape.js', contentBase64: body },
      ]),
    ).rejects.toMatchObject({ code: 'unsafe_payload' });
    expect(await readdir(target)).toEqual([]);
  });
});
