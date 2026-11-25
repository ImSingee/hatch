/**
 * `pnpm release:set-version <version>` sets every product version to the
 * release version. Prints the normalized version and the changed files.
 */
import { fileURLToPath } from 'node:url';
import { setReleaseVersion } from './release-version.ts';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: pnpm release:set-version <version>');
  process.exit(2);
}

try {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { version, changed } = await setReleaseVersion(root, args[0]!);
  console.log(`Version: ${version}`);
  for (const path of changed) console.log(`Updated ${path}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
