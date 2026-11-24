import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { validateNodeDependencySource } from './node-dependencies';

const INTEGRITY =
  'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';
const tempDirs: string[] = [];

function packageJson(extra: Record<string, unknown> = {}) {
  return {
    name: 'sample',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { zod: '4.6.7' },
    ...extra,
  };
}

function lockfile(change: (lock: any) => void = () => {}): string {
  const lock = {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: {
      '.': { dependencies: { zod: { specifier: '4.6.7', version: '4.6.7' } } },
    },
    packages: { 'zod@4.6.7': { resolution: { integrity: INTEGRITY } } },
    snapshots: { 'zod@4.6.7': {} },
  };
  change(lock);
  return stringify(lock, { lineWidth: 0 });
}

async function source(files: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-node-deps-'));
  tempDirs.push(dir);
  await Promise.all(
    Object.entries({
      'package.json': packageJson(),
      'pnpm-lock.yaml': lockfile(),
      ...files,
    }).map(([name, value]) =>
      value === undefined
        ? Promise.resolve()
        : fs.writeFile(
            path.join(dir, name),
            typeof value === 'string' ? value : JSON.stringify(value),
            'utf8',
          ),
    ),
  );
  return dir;
}

async function validate(files: Record<string, unknown> = {}) {
  return validateNodeDependencySource(await source(files));
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('validateNodeDependencySource', () => {
  it('accepts an allow-listed manifest with an integrity-only lockfile', async () => {
    await expect(
      validate({
        'package.json': packageJson({
          description: 'Sample',
          license: 'MIT',
          devDependencies: { '@types/react': '^19.3.0' },
        }),
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.importers['.'].devDependencies = {
            '@types/react': { specifier: '^19.3.0', version: '19.3.0' },
          };
          lock.packages['@types/react@19.3.0'] = {
            resolution: { integrity: INTEGRITY },
            engines: { node: '>=18' },
            peerDependencies: { csstype: '^3.0.0' },
          };
          lock.snapshots['@types/react@19.3.0(csstype@3.2.4)'] = {
            dependencies: { csstype: '3.2.4', 'wrap-cjs': 'wrap@7.0.0' },
            optional: true,
          };
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    '.npmrc',
    'package.json5',
    'package.yaml',
    '.pnpmfile.cjs',
    '.pnpmfile.mjs',
    'pnpm-workspace.yml',
    'pnpm-workspaces.yaml',
    'tsconfig.json',
    'jsconfig.json',
    'deno.jsonc',
  ])('rejects the root file %s', async (name) => {
    await expect(validate({ [name]: '' })).rejects.toThrow(
      `app sources cannot include ${name}`,
    );
  });

  it('rejects a case variant of a root file at every site, however contents are read', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify(packageJson()),
      'pnpm-lock.yaml': lockfile(),
    };
    const root = await source({ ...files, '.PNPMFILE.CJS': '' });
    await expect(validateNodeDependencySource(root)).rejects.toThrow(
      'app sources cannot include .PNPMFILE.CJS',
    );
    // The Runner reads contents through an Agent-scoped reader.
    await expect(
      validateNodeDependencySource(root, async (file) => files[file] ?? null),
    ).rejects.toThrow('app sources cannot include .PNPMFILE.CJS');
  });

  it('ignores a pnpm-workspace.yaml that pnpm wrote into the root', async () => {
    await expect(
      validate({ 'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n' }),
    ).resolves.toBeUndefined();
  });

  it('requires both dependency files', async () => {
    await expect(validate({ 'package.json': undefined })).rejects.toThrow(
      /Missing package\.json.*building-apps/s,
    );
    await expect(validate({ 'pnpm-lock.yaml': undefined })).rejects.toThrow(
      /Missing source-controlled pnpm-lock\.yaml/,
    );
  });

  it.each([
    ['packageManager', 'pnpm@12.0.0'],
    ['devEngines', { runtime: { name: 'node', onFail: 'download' } }],
    ['engines', { runtime: { name: 'node', onFail: 'download' } }],
    ['scripts', { postinstall: 'node evil.js' }],
    ['pnpm', { onlyBuiltDependencies: ['esbuild'] }],
    ['workspaces', ['packages/*']],
    ['overrides', { zod: '3.0.0' }],
    ['peerDependencies', { react: '^19' }],
    ['dependenciesMeta', { zod: { injected: true } }],
  ])('rejects the package.json field %s', async (key, value) => {
    await expect(
      validate({ 'package.json': packageJson({ [key]: value }) }),
    ).rejects.toThrow(`package.json must not declare ${key}`);
  });

  it('requires an ESM package', async () => {
    await expect(
      validate({ 'package.json': packageJson({ type: 'commonjs' }) }),
    ).rejects.toThrow('"type": "module"');
  });

  it.each([
    'file:../shared',
    'link:../shared',
    'workspace:*',
    'catalog:',
    'npm:other@1.0.0',
    'jsr:^1.0.0',
    'github:user/repo',
    'user/repo',
    'git+https://example.com/repo.git',
    'https://example.com/pkg.tgz',
    './local',
  ])('rejects the dependency specifier %s', async (specifier) => {
    await expect(
      validate({
        'package.json': packageJson({ dependencies: { shared: specifier } }),
      }),
    ).rejects.toThrow(/uses unsupported specifier/);
  });

  it('rejects platform-provided and JSR packages', async () => {
    await expect(
      validate({
        'package.json': packageJson({
          dependencies: { '@hatch/app': '1.0.0' },
        }),
      }),
    ).rejects.toThrow('@hatch/app is provided by Hatch');
    await expect(
      validate({
        'package.json': packageJson({
          dependencies: { '@jsr/std__fs': '1.0.0' },
        }),
      }),
    ).rejects.toThrow(/JSR registry/);
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.packages['@hatch/app@1.0.0'] = {
            resolution: { integrity: INTEGRITY },
          };
        }),
      }),
    ).rejects.toThrow('@hatch/app is provided by Hatch');
  });

  it.each([
    [
      'a tarball URL',
      { tarball: 'https://example.com/zod-4.6.7.tgz', integrity: INTEGRITY },
    ],
    ['a tarball without integrity', { tarball: 'https://example.com/z.tgz' }],
    [
      'a git source',
      {
        type: 'git',
        repo: 'https://example.com/z.git',
        commit: 'a'.repeat(40),
      },
    ],
    ['a directory', { type: 'directory', directory: '../z' }],
    ['a malformed integrity', { integrity: 'md5-AAAA' }],
  ])(
    'rejects a lockfile package resolved by %s',
    async (_label, resolution) => {
      await expect(
        validate({
          'pnpm-lock.yaml': lockfile((lock) => {
            lock.packages['zod@4.6.7'].resolution = resolution;
          }),
        }),
      ).rejects.toThrow(/must resolve by registry integrity only/);
    },
  );

  it.each([
    'zod@https://example.com/zod-4.6.7.tgz',
    'zod@file:../zod',
    'zod@git+https://example.com/zod.git#abc',
    'node@runtime:20.11.0',
  ])('rejects the lockfile package key %s', async (key) => {
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.packages[key] = { resolution: { integrity: INTEGRITY } };
        }),
      }),
    ).rejects.toThrow(/is not an npm registry package/);
  });

  it('rejects linked importer and snapshot dependencies', async () => {
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.importers['.'].dependencies.zod.version = 'link:../zod';
        }),
      }),
    ).rejects.toThrow(/locks "zod" to something other than an npm registry/);
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.snapshots['zod@4.6.7'] = {
            dependencies: { helper: 'https://example.com/helper.tgz' },
          };
        }),
      }),
    ).rejects.toThrow(/links "helper" to something other than an npm registry/);
  });

  it('rejects the extra document pnpm writes for packageManager and config dependencies', async () => {
    const environment = stringify({
      lockfileVersion: '9.0',
      importers: { '.': { configDependencies: {} } },
      packageManagerDependencies: { pnpm: { version: '12.22.0' } },
    });
    await expect(
      validate({ 'pnpm-lock.yaml': `---\n${environment}---\n${lockfile()}` }),
    ).rejects.toThrow(/contains 2 YAML documents.*packageManager/s);
  });

  it.each([
    'overrides',
    'patchedDependencies',
    'pnpmfileChecksum',
    'packageExtensionsChecksum',
    'catalogs',
    'configDependencies',
    'packageManagerDependencies',
  ])('rejects the lockfile root field %s', async (key) => {
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock[key] = {};
        }),
      }),
    ).rejects.toThrow(`root has unsupported field "${key}"`);
  });

  it('rejects workspace importers, non-default settings and other lockfile versions', async () => {
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.importers['packages/a'] = {};
        }),
      }),
    ).rejects.toThrow(/exactly one project/);
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.settings.autoInstallPeers = false;
        }),
      }),
    ).rejects.toThrow(/non-default pnpm setting "autoInstallPeers"/);
    await expect(
      validate({
        'pnpm-lock.yaml': lockfile((lock) => {
          lock.lockfileVersion = '6.0';
        }),
      }),
    ).rejects.toThrow(/lockfileVersion must be '9\.0'/);
  });

  it('rejects YAML anchors, aliases and tags', async () => {
    const anchored = lockfile().replace(
      'resolution:',
      'resolution: &shared\n     ',
    );
    await expect(validate({ 'pnpm-lock.yaml': anchored })).rejects.toThrow(
      /YAML anchors or tags/,
    );
    const tagged = lockfile().replace('"9.0"', '!!str "9.0"');
    await expect(validate({ 'pnpm-lock.yaml': tagged })).rejects.toThrow(
      /YAML anchors or tags/,
    );
  });
});
