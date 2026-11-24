/**
 * Lays an App root out as the platform lays out a native-runtime App:
 * `@hatch/ui` copied to `.hatch/ui/`, a generated `nsh.json` with the
 * library's theme, Tailwind extension and exact alias, and the
 * `app/tsconfig.json` that `nsh check` needs next to the entry. None of these
 * are committed.
 *
 *   node_modules/.bin/tsx sdk-internal/ui/gallery/prepare.ts
 *
 * prepares the gallery; tests call `prepareAppRoot` for their fixtures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib',
);

export function prepareAppRoot(
  root: string,
  app: { id: string; name: string },
): void {
  const target = path.join(root, '.hatch/ui');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(LIB, target, { recursive: true });

  const tailwind = JSON.parse(
    fs.readFileSync(path.join(LIB, 'tailwind.json'), 'utf8'),
  ) as unknown;
  const nshJson = {
    name: app.name,
    id: app.id,
    version: '1.0.0',
    build: 1,
    appearance: 'light',
    capabilities: { host: ['hatch.*'] },
    theme: './.hatch/ui/theme.json',
    tailwind,
    resolve: { alias: { '@hatch/ui': './.hatch/ui/index.ts' } },
  };
  fs.writeFileSync(
    path.join(root, 'nsh.json'),
    `${JSON.stringify(nshJson, null, 2)}\n`,
  );

  const tsconfig = {
    extends: './.nsh/tsconfig.json',
    compilerOptions: {
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      paths: {
        nsh: ['./.nsh/types/nsh/index.d.ts'],
        'nsh/*': ['./.nsh/types/nsh/*.d.ts'],
        '@hatch/ui': ['../.hatch/ui/index.ts'],
      },
    },
    include: [
      '**/*.ts',
      '**/*.tsx',
      '../.hatch/ui/**/*.ts',
      '../.hatch/ui/**/*.tsx',
    ],
  };
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app/tsconfig.json'),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareAppRoot(path.dirname(fileURLToPath(import.meta.url)), {
    id: 'dev.hatch.app.ui-gallery',
    name: 'Hatch UI gallery',
  });
  console.log('gallery prepared');
}
