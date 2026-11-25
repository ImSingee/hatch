import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setReleaseVersion, VERSION_FILES } from './release-version.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hatch-release-'));
  for (const { path } of VERSION_FILES) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repo, path), join(root, path));
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (path: string) => readFile(join(root, path), 'utf8');

describe('setReleaseVersion', () => {
  it('sets every product version and only those', async () => {
    const before = new Map(
      await Promise.all(
        VERSION_FILES.map(
          async ({ path }) => [path, await read(path)] as const,
        ),
      ),
    );
    const result = await setReleaseVersion(root, 'v2.3.4-rc.1');

    const paths = VERSION_FILES.map(({ path }) => path);
    // Each file changes exactly one line, and that line holds the version.
    const changedLines: Record<string, string[]> = {};
    const expectedLines: Record<string, unknown> = {};
    for (const path of paths) {
      const old = before.get(path)!.split('\n');
      changedLines[path] = (await read(path))
        .split('\n')
        .filter((line, index) => line !== old[index]);
      // iOS takes the core version; everything else takes the full one.
      const version = path === 'mobile/app.config.ts' ? '2.3.4' : '2.3.4-rc.1';
      const quoted = new RegExp(`['"]${version.replaceAll('.', '\\.')}['"]`);
      expectedLines[path] = [expect.stringMatching(quoted)];
    }

    expect(result).toEqual({ version: '2.3.4-rc.1', changed: paths });
    expect(changedLines).toEqual(expectedLines);
    // Dependencies that share a version string stay untouched.
    const lock = await read('desktop/src-tauri/Cargo.lock');
    expect(lock.match(/version = "2\.3\.4-rc\.1"/g)).toHaveLength(1);
  });

  it('rejects versions that are not semver', async () => {
    for (const input of ['1.2', '01.2.3', 'v1.2.3 && echo', 'latest', ''])
      await expect(setReleaseVersion(root, input)).rejects.toThrow(
        'not a semantic version',
      );
  });

  it('writes nothing when a file no longer matches', async () => {
    const config = join(root, 'mobile/app.config.ts');
    await writeFile(config, 'export default {};\n');
    const cli = await read('packages/hatch-cli/package.json');

    await expect(setReleaseVersion(root, '3.0.0')).rejects.toThrow(
      'mobile/app.config.ts: expected exactly one version match, found 0.',
    );
    expect(await read('packages/hatch-cli/package.json')).toBe(cli);
  });
});
