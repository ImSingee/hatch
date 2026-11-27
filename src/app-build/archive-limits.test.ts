/**
 * The packer applies the unpacker's limits, so a package that packs is one
 * the platform accepts: files and directories count toward one entry limit.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { packBuildDirectory, unpackBuildArchive } from './archive';

vi.mock('./format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./format')>()),
  BUILD_PACKAGE_MAX_FILES: 10,
  BUILD_PACKAGE_MAX_ENTRIES: 4,
}));

const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-build-limits-'));
afterAll(() => rm(root, { recursive: true, force: true }));

describe('build package entry limit', () => {
  it('counts a file after the directories that sort before it', async () => {
    const source = path.join(root, 'source');
    // Three directories, then files: the entries are a, b, c, d.
    for (const dir of ['a', 'b', 'c'])
      await mkdir(path.join(source, dir), { recursive: true });
    await writeFile(path.join(source, 'd.json'), '{}');
    // Exactly the limit packs, and the platform unpacks it.
    expect(
      await unpackBuildArchive(
        await packBuildDirectory(source),
        path.join(root, 'out'),
      ),
    ).toBe(1);
    await writeFile(path.join(source, 'e.json'), '{}');
    await expect(packBuildDirectory(source)).rejects.toThrow(/too large/);
  });
});
