/**
 * The platform accepts build packages from builds it does not trust. These
 * cover what it must never take from a package: files that decide how the
 * App runs, another deployment's output, or output of another toolchain.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUILD_PACKAGE_FORMAT,
  type BuildPackageManifest,
  type BuildTooling,
} from '../../app-build/format';
import { finalizeBuild } from './finalize';
import { parseSourceManifest } from './manifest';

const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-finalize-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const TOOLING: BuildTooling = {
  typescript: '7.0.2',
  esbuild: '0.28.2',
  pnpm: '12.21.0',
  buf: '1.75.0',
  protocGenEs: '2.17.0',
  nsh: null,
  sdk: 'a'.repeat(64),
};
const COMMIT = 'c'.repeat(40);

let counter = 0;

/** A backend package for App `demo`, deployment `dep-1`. */
async function writePackage(
  overrides: Partial<BuildPackageManifest> = {},
  manifest: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  const dir = path.join(root, `package-${++counter}`);
  await mkdir(path.join(dir, 'backend'), { recursive: true });
  const pkg: BuildPackageManifest = {
    format: BUILD_PACKAGE_FORMAT,
    appId: 'demo',
    deploymentId: 'dep-1',
    commit: COMMIT,
    toolchain: 'node',
    manifestFile: 'manifest.ts',
    manifest: {
      id: 'demo',
      name: 'Demo',
      compatibilityVersion: 2,
      capabilities: { backend: true },
      backend: { entry: 'backend/main.ts' },
      ...manifest,
    },
    dataSchema: null,
    tooling: TOOLING,
    log: 'built',
    ...overrides,
  };
  await writeFile(path.join(dir, 'build.json'), JSON.stringify(pkg));
  await writeFile(
    path.join(dir, 'backend', 'main.bundle.js'),
    'export default {};',
  );
  for (const [file, body] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body);
  }
  return dir;
}

const finalize = (packageDir: string, tooling = TOOLING) =>
  finalizeBuild({
    packageDir,
    outDir: path.join(root, `out-${++counter}`),
    appId: 'demo',
    deploymentId: 'dep-1',
    commit: COMMIT,
    tooling: async () => tooling,
  });

describe('accepting a build package', () => {
  it('writes the runtime manifest and deployment marker itself', async () => {
    const outDir = path.join(root, `out-${++counter}`);
    const result = await finalizeBuild({
      packageDir: await writePackage(),
      outDir,
      appId: 'demo',
      deploymentId: 'dep-1',
      commit: COMMIT,
      tooling: async () => TOOLING,
    });
    expect(result.normalized.backend).toMatchObject({
      entry: 'backend/main.bundle.js',
      format: 'bundle-v1',
    });
    const written = JSON.parse(
      await readFile(path.join(outDir, 'manifest.normalized.json'), 'utf8'),
    );
    expect(written.backend.entry).toBe('backend/main.bundle.js');
    expect(
      JSON.parse(await readFile(path.join(outDir, 'deployment.json'), 'utf8')),
    ).toEqual({ deploymentId: 'dep-1' });
  });

  it('refuses a package that ships its own runtime manifest or marker', async () => {
    for (const forged of ['manifest.normalized.json', 'deployment.json']) {
      await expect(
        finalize(
          await writePackage(
            {},
            {},
            {
              [forged]: JSON.stringify({
                backend: { extraPermissions: ['--allow-all'] },
              }),
            },
          ),
        ),
      ).rejects.toThrow(/unexpected entry/);
    }
  });

  it('refuses a package built for another App, deployment or commit', async () => {
    for (const overrides of [
      { appId: 'other' },
      { deploymentId: 'dep-2' },
      { commit: 'd'.repeat(40) },
    ]) {
      await expect(finalize(await writePackage(overrides))).rejects.toThrow(
        /another deployment|not the deployment's commit/,
      );
    }
    // A manifest naming another App would serve that App's URLs.
    await expect(
      finalize(await writePackage({}, { id: 'other' })),
    ).rejects.toThrow(/does not match the App id/);
  });

  it('refuses output of another toolchain', async () => {
    await expect(
      finalize(
        await writePackage({ tooling: { ...TOOLING, esbuild: '0.1.0' } }),
      ),
    ).rejects.toMatchObject({ code: 'toolchain_mismatch' });
  });

  it('validates the manifest the package reports instead of trusting it', async () => {
    await expect(
      finalize(await writePackage({}, { capabilities: { backend: 'yes' } })),
    ).rejects.toThrow(/capabilities\.backend/);
    await expect(
      finalize(
        await writePackage(
          {},
          {
            backend: {
              entry: 'backend/main.ts',
              extraPermissions: ['--allow-foo'],
            },
          },
        ),
      ),
    ).rejects.toThrow(/extraPermissions/);
  });

  it('takes nothing the commit does not declare from the package manifest', async () => {
    const committed = {
      id: 'demo',
      name: 'Demo',
      compatibilityVersion: 2,
      capabilities: { backend: true },
      backend: { entry: 'backend/main.ts' },
    };
    const finalizeAgainst = (packageDir: string) =>
      finalizeBuild({
        packageDir,
        outDir: path.join(root, `out-${++counter}`),
        appId: 'demo',
        deploymentId: 'dep-1',
        commit: COMMIT,
        tooling: async () => TOOLING,
        committedManifest: async () => parseSourceManifest(committed),
      });
    // A builder that grants itself more than the commit declares.
    await expect(
      finalizeAgainst(
        await writePackage(
          {},
          {
            backend: {
              entry: 'backend/main.ts',
              extraPermissions: ['--allow-all'],
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'app_build_invalid' });
    // The package that reports the commit's own manifest is accepted.
    await expect(finalizeAgainst(await writePackage())).resolves.toMatchObject({
      normalized: { id: 'demo' },
    });
  });

  it('requires the descriptor set of a declared RPC service', async () => {
    await expect(
      finalize(
        await writePackage(
          {},
          {
            rpc: { proto: 'proto/service.proto', service: 'demo.v1.Demo' },
          },
        ),
      ),
    ).rejects.toThrow(/api\.binpb/);
  });
});
