/** Exercise a rendered scaffold through the production manifest loader. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { materializeAppHatchSdk } from './agent/hatch-sdk';
import { BUILD_WORK_DIR } from './agent/paths';
import {
  detectSourceToolchain,
  sourceToolchainReader,
} from './source-toolchain';
import { createSourceToolchain } from './toolchain';
import { platformToolchainContext } from './toolchain/platform';
import { parseSourceManifest } from './server/apps/manifest';

export async function createManifestFixtureRoot(): Promise<string> {
  // Match production build inputs: SDK generations are staged privately on
  // the workspace filesystem. The OS temp directory may be a separate mount.
  await fs.mkdir(BUILD_WORK_DIR, { recursive: true });
  return fs.mkdtemp(path.join(BUILD_WORK_DIR, 'manifest-test-'));
}

export async function evaluateTemplateManifest(source: string) {
  const root = await createManifestFixtureRoot();
  try {
    // Use the dependency files the template ships, with the toolchain they
    // select, exactly as a deploy of a freshly scaffolded source would.
    const template = path.resolve('templates/default-app');
    for (const file of await fs.readdir(template)) {
      if (
        /^(?:package\.json|pnpm-lock\.yaml|deno\.json|deno\.lock)$/.test(file)
      )
        await fs.copyFile(path.join(template, file), path.join(root, file));
    }
    await fs.writeFile(path.join(root, 'manifest.ts'), source);
    const toolchain = createSourceToolchain(
      await detectSourceToolchain(sourceToolchainReader(root)),
      platformToolchainContext(root, []),
    );
    await toolchain.validateDependencies();
    await materializeAppHatchSdk(root);
    await toolchain.install();
    return (await toolchain.evaluateManifest(parseSourceManifest)).manifest;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
