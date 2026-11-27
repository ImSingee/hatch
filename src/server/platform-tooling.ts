/** Versions of the tools the platform builds Apps with, from its own install. */
import { createRequire } from 'node:module';
import { REPO_ROOT } from '~agent/paths';

// Read at runtime from the installed packages, so every bundle of the
// platform (Nitro, Runner, Builder) reports the tools it actually runs.
const require = createRequire(`${REPO_ROOT}/package.json`);

function version(name: string): string {
  return (require(`${name}/package.json`) as { version: string }).version;
}

/** Versions of the tools the platform itself runs, for builds elsewhere. */
export function platformTooling() {
  const platform = require('./package.json') as {
    packageManager: string;
  };
  return {
    bufVersion: version('@bufbuild/buf'),
    protocGenEsVersion: version('@bufbuild/protoc-gen-es'),
    typescriptVersion: version('typescript'),
    esbuildVersion: version('esbuild'),
    pnpmVersion: platform.packageManager.replace(/^pnpm@/, ''),
  };
}
