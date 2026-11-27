/**
 * The platform evaluates a deployment's manifest itself, from the commit. A
 * manifest that needs packages is evaluated after installing the committed
 * lockfile, frozen and without any package's scripts, into a tree used for
 * that evaluation only.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { platformBuildHost } from '../server/apps/build-host';
import { evaluateAppSourceManifest } from './produce';

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-evaluate-manifest-')),
);
afterAll(() => fs.rm(root, { recursive: true, force: true }));

// `@sindresorhus/is` is imported by the manifest; `core-js` declares a
// postinstall script, which must not run.
const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@sindresorhus/is':
        specifier: 7.0.2
        version: 7.0.2
      core-js:
        specifier: 3.39.0
        version: 3.39.0

packages:

  '@sindresorhus/is@7.0.2':
    resolution: {integrity: sha512-d9xRovfKNz1SKieM0qJdO+PQonjnnIfSNWfHYnBSJ9hkjm0ZPw6HlxscDXYstp3z+7V2GOFHc+J0CYrYTjqCJw==}
    engines: {node: '>=18'}

  core-js@3.39.0:
    resolution: {integrity: sha512-raM0ew0/jJUqkJ0E6e8UDtl+y/7ktFivgWvqw8dNSQeNWoSDLvQ1H/RN3aPXB9tBd4/FhyR4RDPGhsNIMsAn7g==}

snapshots:

  '@sindresorhus/is@7.0.2': {}

  core-js@3.39.0: {}
`;

async function source(manifest: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(root, 'source-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { '@sindresorhus/is': '7.0.2', 'core-js': '3.39.0' },
    }),
  );
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), LOCKFILE);
  await fs.writeFile(path.join(dir, 'manifest.ts'), manifest);
  return dir;
}

describe('evaluating the manifest of a commit', { timeout: 180_000 }, () => {
  it('installs the lockfile without scripts when the manifest imports a package', async () => {
    const sourceDir = await source(
      [
        "import { defineAppManifest } from '@hatch/app';",
        "import is from '@sindresorhus/is';",
        'export default defineAppManifest({',
        "  id: 'evaluated',",
        "  name: is.string('x') ? 'From a package' : 'No',",
        '  compatibilityVersion: 2,',
        '  capabilities: {},',
        '});',
        '',
      ].join('\n'),
    );
    const home = await fs.mkdtemp(path.join(root, 'home-'));
    const store = await fs.mkdtemp(path.join(root, 'store-'));
    const workDir = await fs.mkdtemp(path.join(root, 'work-'));
    const host = platformBuildHost({
      sdkDigest: '0'.repeat(64),
      workDir,
      sandbox: { home, pnpmStoreDir: store },
    });
    // Look at the tree right after the install, before it is removed.
    let modules: { pendingBuilds?: string[]; storeDir?: string } | undefined;
    const context = host.toolchainContext;
    host.toolchainContext = (src, logs) => {
      const inner = context(src, logs);
      return {
        ...inner,
        run: async (input) => {
          const result = await inner.run(input);
          if (input.tool === 'pnpm' && input.args[0] === 'install') {
            modules = JSON.parse(
              await fs.readFile(
                path.join(src, 'node_modules', '.modules.yaml'),
                'utf8',
              ),
            );
          }
          return result;
        },
      };
    };

    const result = await evaluateAppSourceManifest(host, {
      appId: 'evaluated',
      sourceDir,
    });
    expect(result.installed).toBe(true);
    expect(result.manifest.name).toBe('From a package');
    // pnpm left core-js's postinstall unrun, and used the evaluation's
    // own store.
    expect(modules?.pendingBuilds).toContain('core-js@3.39.0');
    expect(modules?.storeDir?.startsWith(await fs.realpath(store))).toBe(true);
    // Nothing of the install outlives the evaluation.
    expect(await fs.readdir(workDir)).toEqual(['evaluated']);
    expect(await fs.readdir(path.join(workDir, 'evaluated'))).toEqual([]);
  });

  it('evaluates a manifest that imports only the SDK without installing', async () => {
    const sourceDir = await source(
      [
        "import { defineAppManifest } from '@hatch/app';",
        "export default defineAppManifest({ id: 'plain', name: 'Plain', compatibilityVersion: 2, capabilities: {} });",
        '',
      ].join('\n'),
    );
    const result = await evaluateAppSourceManifest(
      platformBuildHost({
        sdkDigest: '0'.repeat(64),
        workDir: await fs.mkdtemp(path.join(root, 'work-')),
      }),
      { appId: 'plain', sourceDir },
    );
    expect(result).toMatchObject({
      installed: false,
      manifest: { id: 'plain', name: 'Plain' },
    });
  });
});
