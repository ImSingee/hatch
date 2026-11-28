/**
 * What the platform takes from a build's native package: its files and
 * bytecode, whoever built it, never its capabilities. Built with the real
 * pinned `nsh` and `hatch-nshpkg` (CI builds both), by the build the
 * `hatch` CLI runs for `--local` (the Builder runs the same one).
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

type Verified = {
  ok: boolean;
  files?: { path: string; kind: string; sha256: string }[];
};

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

  async function finalize(dir: string) {
    const outDir = path.join(root, `out-${++counter}`);
    await finalizeBuild({
      packageDir: dir,
      outDir,
      appId: APP.id,
      deploymentId: 'dep-1',
      commit: null,
      tooling: host().tooling,
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

  it("keeps a local build's bytecode, with the capabilities the platform derived, in a package that verifies", async () => {
    const { outDir, input } = await finalize(packageDir);
    expect(input.capabilities).toEqual(
      nativePackageCapabilities({ app: { runtime: 'native' } }),
    );
    expect(input.bytecodeVersion).toMatch(/^quickjs-/);
    const bytecode = input.files.find((file) => file.kind === 'bytecode');
    expect(bytecode).toBeDefined();
    // The package input is never served with the App's files.
    await expect(
      fs.access(path.join(outDir, 'app', 'native')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // Signed as the platform signs it, the package carries that bytecode
    // and verifies against the signer's root.
    const keys = path.join(root, 'instance-keys');
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
    const signed = path.join(root, 'signed.nshpkg');
    await runNshpkg([
      'pack',
      '--input',
      path.join(outDir, NATIVE_PACKAGE_INPUT_DIR),
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
      signed,
    ]);
    const { results } = await runNshpkg<{ results: Verified[] }>([
      'verify',
      '--root',
      path.join(keys, 'root.pub'),
      signed,
    ]);
    expect(results[0].ok).toBe(true);
    expect(
      results[0].files?.find((file) => file.kind === 'bytecode')?.sha256,
    ).toBe(bytecode?.sha256);
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

    const refusal = await finalize(forged).catch((error) => error);
    expect(refusal).toBeInstanceOf(BuildPackageError);
    expect(refusal).toMatchObject({ code: 'app_build_invalid' });
    expect(refusal.message).toContain('"clipboard":true');
  }, 120_000);
});
