/**
 * Lays the gallery out as the platform lays out a native-runtime App root:
 * `@hatch/ui` copied to `.hatch/ui/`, a generated `nsh.json` with the
 * library's theme, Tailwind extension and exact aliases, and the
 * `app/tsconfig.json` that `nsh check` needs. None of these are committed.
 *
 *   node_modules/.bin/tsx sdk-internal/ui/gallery/prepare.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gallery = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(gallery, '../lib');
const target = path.join(gallery, '.hatch/ui');

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(lib, target, { recursive: true });

const tailwind = JSON.parse(
  fs.readFileSync(path.join(lib, 'tailwind.json'), 'utf8'),
) as unknown;

const nshJson = {
  name: 'Hatch UI gallery',
  id: 'dev.hatch.app.ui-gallery',
  version: '1.0.0',
  build: 1,
  appearance: 'light',
  capabilities: { host: ['hatch.*'] },
  theme: './.hatch/ui/theme.json',
  tailwind,
  resolve: { alias: { '@hatch/ui': './.hatch/ui/index.ts' } },
};
fs.writeFileSync(
  path.join(gallery, 'nsh.json'),
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
fs.writeFileSync(
  path.join(gallery, 'app/tsconfig.json'),
  `${JSON.stringify(tsconfig, null, 2)}\n`,
);
console.log('gallery prepared');
