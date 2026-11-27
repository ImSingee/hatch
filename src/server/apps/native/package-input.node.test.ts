/**
 * What the platform takes from a build's native package: its files, never
 * its capabilities, and its bytecode only from a build it trusts. Built with
 * the real pinned `nsh` and `hatch-nshpkg` (CI builds both).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILD_PACKAGE_NATIVE_PACKAGE,
  BUILD_PACKAGE_NATIVE_PACKAGE_ROOT,
} from '../../../app-build/format';
import { buildAppSource } from '../../../app-build/produce';
import { platformBuildHost } from '../build-host';
import { BuildPackageError, finalizeBuild } from '../finalize';
import { nativePackageCapabilities, nshAppId } from './nsh-config';
import { NATIVE_PACKAGE_INPUT_DIR, runNshpkg } from './nshpkg';
import {
  packageToolsAvailable,
  writePackageSource,
} from './test-fixtures/package-source';

const APP = { id: 'pkgdemo', name: 'Package demo', title: 'Version A' };
const SDK = createHash('sha256').update('package-input-test').digest('hex');

type Input = {
  capabilities: Record<string, unknown>;
  bytecodeVersion: string | null;
  files: { path: string; kind: string; sha256: string }[];
};

describe.skipIf(!packageToolsAvailable())('a native package input', () => {
  let root: string;
  let packageDir: string;
  let counter = 0;
  const host = () => platformBuildHost({ sdkDigest: SDK });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-package-input-'));
    const source = path.join(root, 'src');
    await writePackageSource(source, APP);
    packageDir = path.join(root, 'package');
    await buildAppSource(host(), {
      appId: APP.id,
      deploymentId: 'dep-1',
      commit: null,
      sourceDir: source,
      outDir: packageDir,
    });
  }, 300_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function finalize(dir: string, trustBytecode: boolean) {
    const outDir = path.join(root, `out-${++counter}`);
    await finalizeBuild({
      packageDir: dir,
      outDir,
      appId: APP.id,
      deploymentId: 'dep-1',
      commit: null,
      tooling: host().tooling,
      trustBytecode,
    });
    return {
      outDir,
      input: JSON.parse(
        await fs.readFile(
          path.join(outDir, NATIVE_PACKAGE_INPUT_DIR, 'package-input.json'),
          'utf8',
        ),
      ) as Input,
    };
  }

  it('declares the capabilities the platform derived, and keeps bytecode only from a trusted build', async () => {
    const trusted = await finalize(packageDir, true);
    expect(trusted.input.capabilities).toEqual(
      nativePackageCapabilities({ app: { runtime: 'native' } }),
    );
    expect(trusted.input.bytecodeVersion).toMatch(/^quickjs-/);
    expect(trusted.input.files.map((file) => file.kind)).toContain('bytecode');

    // A `--local` build: the same files, without its bytecode.
    const local = await finalize(packageDir, false);
    expect(local.input.bytecodeVersion).toBeNull();
    expect(local.input.files).toEqual(
      trusted.input.files.filter((file) => file.kind !== 'bytecode'),
    );
    // The package input is never served with the App's files.
    await expect(
      fs.access(path.join(local.outDir, 'app', 'native')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('refuses a build whose package grants itself a capability the manifest does not', async () => {
    // A compromised Builder: the honest package's files, re-signed with
    // keys of its own after adding clipboard access.
    const forged = path.join(root, 'forged-package');
    await fs.cp(packageDir, forged, { recursive: true });
    const honest = path.join(root, 'honest-input');
    const expected = path.join(root, 'expected.json');
    await fs.writeFile(
      expected,
      JSON.stringify(nativePackageCapabilities({ app: { runtime: 'native' } })),
    );
    await runNshpkg([
      'extract',
      '--package',
      path.join(packageDir, BUILD_PACKAGE_NATIVE_PACKAGE),
      '--root',
      path.join(packageDir, BUILD_PACKAGE_NATIVE_PACKAGE_ROOT),
      '--out',
      honest,
      '--id',
      nshAppId(APP.id),
      '--name',
      APP.name,
      '--app-version',
      '1.0.0',
      '--min-runtime',
      '0.7.0',
      '--capabilities',
      expected,
    ]);
    const inputFile = path.join(honest, 'package-input.json');
    const input = JSON.parse(await fs.readFile(inputFile, 'utf8')) as Input;
    input.capabilities = { ...input.capabilities, clipboard: true };
    await fs.writeFile(inputFile, JSON.stringify(input));
    const keys = path.join(root, 'forger-keys');
    const state = await runNshpkg<{ activeReleaseKeyId: string }>([
      'keygen',
      '--out',
      keys,
      '--apps',
      'dev.hatch.app.*',
      '--days',
      '1',
    ]);
    const release = path.join(keys, 'release', state.activeReleaseKeyId);
    await fs.rm(path.join(forged, BUILD_PACKAGE_NATIVE_PACKAGE));
    await runNshpkg([
      'pack',
      '--input',
      honest,
      '--id',
      nshAppId(APP.id),
      '--app-version',
      '1.0.0',
      '--build',
      '1',
      '--key',
      `${release}.secret`,
      '--cert',
      `${release}.cert`,
      '--out',
      path.join(forged, BUILD_PACKAGE_NATIVE_PACKAGE),
    ]);
    await fs.copyFile(
      path.join(keys, 'root.pub'),
      path.join(forged, BUILD_PACKAGE_NATIVE_PACKAGE_ROOT),
    );

    const refusal = await finalize(forged, true).catch((error) => error);
    expect(refusal).toBeInstanceOf(BuildPackageError);
    expect(refusal).toMatchObject({ code: 'app_build_invalid' });
    expect(refusal.message).toContain('"clipboard":true');
  }, 120_000);
});
