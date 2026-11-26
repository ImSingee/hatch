/**
 * Lays an App root out as the platform lays out a native-runtime App (see
 * `s1-contract.md`): `@hatch/ui` materialised as an SDK package in
 * `.hatch/sdk/@hatch/ui/` (its `package.json` and `src/` as `dist/`), a
 * generated `nsh.json` with the exact host grant, the library's theme and
 * Tailwind extension inline and one alias per entry, and the
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

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(UI, 'src');

/** The host calls the platform grants a native App (plan section 9). */
const HOST_GRANT = [
  'hatch.rpc',
  'hatch.data.query',
  'hatch.data.mutate',
  'hatch.data.events',
  'hatch.theme.get',
  'hatch.nav.setTitle',
  'hatch.nav.setRoute',
  'hatch.nav.open',
  'hatch.native.supports',
];

export function prepareAppRoot(
  root: string,
  app: { id: string; name: string },
): void {
  const target = path.join(root, '.hatch/sdk/@hatch/ui');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(
    path.join(UI, 'package.json'),
    path.join(target, 'package.json'),
  );
  fs.cpSync(SOURCE, path.join(target, 'dist'), { recursive: true });

  const read = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(SOURCE, file), 'utf8')) as unknown;
  const nshJson = {
    name: app.name,
    entry: 'app/main.tsx',
    id: app.id,
    version: '1.0.0',
    build: 1,
    appearance: 'light',
    capabilities: { host: HOST_GRANT },
    theme: read('theme.json'),
    tailwind: read('tailwind.json'),
    resolve: {
      alias: { '@hatch/ui': './.hatch/sdk/@hatch/ui/dist/index.ts' },
    },
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
        '@hatch/ui': ['../.hatch/sdk/@hatch/ui/dist/index.ts'],
      },
    },
    include: [
      '**/*.ts',
      '**/*.tsx',
      '../.hatch/sdk/**/*.ts',
      '../.hatch/sdk/**/*.tsx',
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
