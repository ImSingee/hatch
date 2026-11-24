/** The pnpm install of the Node toolchain acts on the lockfile and nothing else. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { subprocessSandboxEnv } from '../server/sandbox-env';
import { run } from '../server/subprocess';
import { createNodeToolchain } from './node';

const tempDirs: string[] = [];
const DEAD_REGISTRY = 'http://127.0.0.1:1/';

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-node-install-'));
  tempDirs.push(dir);
  return dir;
}

async function symlinks(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(full);
    else if (entry.isDirectory()) found.push(...(await symlinks(full)));
  }
  return found;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

// One small scoped package: a scoped registry in any configuration pnpm
// reads would redirect its download.
const PACKAGE_JSON = {
  name: 'install-fixture',
  version: '0.0.0',
  private: true,
  type: 'module',
  dependencies: { '@sindresorhus/is': '7.0.2' },
};
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

packages:

  '@sindresorhus/is@7.0.2':
    resolution: {integrity: sha512-d9xRovfKNz1SKieM0qJdO+PQonjnnIfSNWfHYnBSJ9hkjm0ZPw6HlxscDXYstp3z+7V2GOFHc+J0CYrYTjqCJw==}
    engines: {node: '>=18'}

snapshots:

  '@sindresorhus/is@7.0.2': {}
`;

describe('Node toolchain install', { timeout: 120_000 }, () => {
  it('ignores pnpm configuration, hooks and scripts supplied by the source or the user', async () => {
    const root = await fs.realpath(await tempDir());
    const home = await tempDir();
    const marker = path.join(home, 'executed');
    const touch = `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replaceAll('"', '\\"')}, 'x')"`;
    // Each file below changes the install in a way only one protection stops.
    // --ignore-workspace
    const workspaceFile =
      'modulesDir: workspace_modules\ndangerouslyAllowAllBuilds: true\n';
    const hook = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nmodule.exports = {};\n`;
    await Promise.all([
      fs.writeFile(path.join(root, 'pnpm-lock.yaml'), LOCKFILE),
      fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          ...PACKAGE_JSON,
          scripts: { preinstall: touch, postinstall: touch, prepare: touch },
        }),
      ),
      fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), workspaceFile),
      // --ignore-pnpmfile
      fs.writeFile(path.join(root, '.pnpmfile.cjs'), hook),
      // --npmrc-auth-file: the user npmrc adds scoped registries and tokens.
      fs.writeFile(
        path.join(home, '.npmrc'),
        `@sindresorhus:registry=${DEAD_REGISTRY}\n`,
      ),
      // XDG_CONFIG_HOME: the global pnpm config and auth file add scoped
      // registries that no command-line argument overrides.
      ...[
        path.join(home, '.config', 'pnpm'),
        path.join(home, 'Library', 'Preferences', 'pnpm'),
      ].map(async (dir) => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'config.yaml'),
          `registries:\n  '@sindresorhus': ${DEAD_REGISTRY}\n`,
        );
        await fs.writeFile(
          path.join(dir, 'auth.ini'),
          `@sindresorhus:registry=${DEAD_REGISTRY}\n`,
        );
      }),
    ]);

    const toolchain = createNodeToolchain({
      root,
      // An empty store forces the package to be downloaded, so a redirected
      // registry cannot go unnoticed.
      pnpmStoreDir: await tempDir(),
      run: ({ tool, args, env }) =>
        run(tool, args, {
          cwd: root,
          env: subprocessSandboxEnv({
            HOME: home,
            XDG_CACHE_HOME: path.join(home, '.cache'),
            XDG_CONFIG_HOME: path.join(home, '.config'),
            ...env,
          }),
        }),
    });
    await toolchain.install();

    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).sort()).toEqual([
      '.pnpmfile.cjs',
      'node_modules',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]);
    const installed = path.join(
      root,
      'node_modules',
      '@sindresorhus',
      'is',
      'package.json',
    );
    expect(JSON.parse(await fs.readFile(installed, 'utf8')).version).toBe(
      '7.0.2',
    );
    // Files are copied, never shared with the store by inode.
    expect((await fs.stat(installed)).nlink).toBe(1);
    // The isolated layout keeps every link inside the source root.
    const links = await symlinks(path.join(root, 'node_modules'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(
        path.relative(root, await fs.realpath(link)).startsWith('..'),
      ).toBe(false);
    }
    await expect(
      fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
    ).resolves.toBe(workspaceFile);
  });
});
