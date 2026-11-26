import { chmod, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { resolveBuildInfo } from './build-info';

const entry = fileURLToPath(
  new URL('../packages/hatch-cli/src/main.ts', import.meta.url),
);
const output = fileURLToPath(
  new URL('../packages/hatch-cli/dist/main.mjs', import.meta.url),
);

const result = await build({
  define: { __HATCH_BUILD_INFO__: JSON.stringify(resolveBuildInfo()) },
  metafile: true,
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  banner: {
    // Bundled CommonJS dependencies require Node built-ins; an ES module has
    // no `require` of its own.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __hatchCreateRequire } from 'node:module';",
      'const require = __hatchCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
await chmod(output, 0o755);

for (const input of Object.keys(result.metafile.inputs)) {
  if (/^src\/(server|db|auth|agent)\//.test(input))
    throw new Error(`Server-only module leaked into CLI: ${input}`);
}

// The local build driver runs from the toolchain cache, where esbuild and
// TypeScript (native binaries, the platform's exact versions) are installed
// beside it; everything else is bundled.
const driver = await build({
  define: { __HATCH_BUILD_INFO__: JSON.stringify(resolveBuildInfo()) },
  metafile: true,
  entryPoints: [
    fileURLToPath(
      new URL('../packages/hatch-cli/src/build-driver.ts', import.meta.url),
    ),
  ],
  outfile: path.join(path.dirname(output), 'build-driver.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  external: ['esbuild', 'typescript', 'typescript/*'],
  banner: {
    js: [
      "import { createRequire as __hatchCreateRequire } from 'node:module';",
      'const require = __hatchCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
for (const input of Object.keys(driver.metafile.inputs)) {
  // The driver builds App source; it must never carry platform state.
  if (/^src\/(db|auth)\//.test(input) || input === 'src/env.ts')
    throw new Error(`Platform module leaked into the build driver: ${input}`);
}

// Preserve license notices for every npm package whose code is bundled.
const notices = new Map<string, string>();
for (const input of [
  ...Object.keys(result.metafile.inputs),
  ...Object.keys(driver.metafile.inputs),
]) {
  if (!input.includes('node_modules/')) continue;
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    const manifest = await readFile(
      path.join(directory, 'package.json'),
      'utf8',
    ).then(
      (value) => JSON.parse(value) as { name: string; version: string },
      () => null,
    );
    if (manifest?.name) {
      for (const filename of [
        'LICENSE',
        'LICENSE.md',
        'LICENSE.txt',
        'license',
      ]) {
        const license = await readFile(
          path.join(directory, filename),
          'utf8',
        ).catch(() => null);
        if (license) {
          notices.set(`${manifest.name}@${manifest.version}`, license);
          break;
        }
      }
      break;
    }
    directory = path.dirname(directory);
  }
}
const licenseDir = path.join(path.dirname(output), 'licenses');
await mkdir(licenseDir, { recursive: true });
await writeFile(
  path.join(licenseDir, 'third-party.txt'),
  [...notices].map(([name, text]) => `${name}\n${text}`).join('\n\n'),
);
await writeFile(
  path.join(licenseDir, 'Hatch.md'),
  await readFile(new URL('../LICENSE.md', import.meta.url)),
);
