/** Public SDK exports are the shared build and resolution contract. */
import appManifest from './app/package.json' with { type: 'json' };
import dataManifest from './data/package.json' with { type: 'json' };

type SdkManifest = {
  name: string;
  exports: Record<string, { types: string; default: string }>;
  peerDependencies: Record<string, string>;
};

type SdkEntry = { source: string } | { reexport: string };

export type SdkDefinition = {
  directory: string;
  manifest: SdkManifest;
  entries: Record<string, SdkEntry>;
};

export const APP_SDK: SdkDefinition = {
  directory: 'app',
  manifest: appManifest,
  entries: {
    '.': { source: 'app.ts' },
    './data': { source: 'data.ts' },
    './data/react': { source: 'data-react.ts' },
    './notifications': { source: 'notifications.ts' },
    './storage': { source: 'storage.ts' },
    './storage/react': { source: 'storage-react.ts' },
    './storage/install': { source: 'storage-install.ts' },
    './tasks': { source: 'tasks.ts' },
  },
};

export const LEGACY_DATA_SDK: SdkDefinition = {
  directory: 'data',
  manifest: dataManifest,
  entries: {
    '.': { reexport: '@hatch/app/data' },
    './react': { reexport: '@hatch/app/data/react' },
  },
};

/** Every SDK a source receives: `@hatch/app` and its legacy alias. */
export const SDK_DEFINITIONS = [APP_SDK, LEGACY_DATA_SDK];

export function sdkImports(
  definitions: readonly SdkDefinition[],
): Record<string, string> {
  return Object.fromEntries(
    definitions.flatMap(({ manifest }) =>
      Object.entries(manifest.exports).map(([key, entry]) => [
        key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`,
        `./sdk/${manifest.name}/${entry.default.slice(2)}`,
      ]),
    ),
  );
}

/** Deno namespace declarations shipped beside the generated tsconfig. */
export const SDK_DENO_TYPES = 'types/deno.d.ts';
export const SDK_DENO_TYPES_LICENSE = 'types/deno.LICENSE';
export const SDK_TSCONFIG = 'tsconfig.json';
export const SDK_MANIFEST_TSCONFIG = 'tsconfig.manifest.json';
export const SDK_SCHEMA_TSCONFIG = 'tsconfig.schema.json';

/**
 * A tsconfig that checks only `files`, with the platform compiler options.
 * Paths are relative to the `.hatch` directory that holds the file.
 */
export function sdkEntryTsconfig(files: readonly string[]): string {
  return `${JSON.stringify(
    {
      extends: `./${SDK_TSCONFIG}`,
      files: [`./${SDK_DENO_TYPES}`, ...files],
      include: [],
    },
    null,
    2,
  )}\n`;
}

/**
 * Platform-authored TypeScript configuration for Node-toolchain sources,
 * written into `.hatch/` next to the SDK. Authored sources carry no compiler
 * configuration of their own; these are the options `deno.json` used to fix.
 *
 * - `paths` targets have no extension, so `tsc` picks the declaration file
 *   and esbuild picks the JavaScript file of the same SDK entry.
 * - `typeRoots` is explicit so `types: ["*"]` loads the source's own
 *   `@types/*` packages and never those of a directory above the source root.
 * - The runtime is Deno, so the `Deno` namespace is declared; web globals
 *   come from the DOM library, as they did under `deno.json`.
 */
export function sdkToolchainFiles(): Record<string, string> {
  const paths = Object.fromEntries(
    Object.entries(sdkImports(SDK_DEFINITIONS)).map(([specifier, target]) => [
      specifier,
      [target.replace(/\.js$/, '')],
    ]),
  );
  const tsconfig = {
    compilerOptions: {
      target: 'esnext',
      module: 'esnext',
      moduleResolution: 'bundler',
      moduleDetection: 'force',
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      noEmit: true,
      strict: true,
      noImplicitOverride: true,
      jsx: 'react-jsx',
      jsxImportSource: 'react',
      lib: ['esnext', 'dom', 'dom.asynciterable'],
      skipLibCheck: true,
      types: ['*'],
      typeRoots: ['../node_modules/@types'],
      paths,
    },
    files: [`./${SDK_DENO_TYPES}`],
    include: ['../**/*.ts', '../**/*.tsx'],
    exclude: ['../node_modules', '../.hatch', '../.git'],
  };
  return {
    [SDK_TSCONFIG]: `${JSON.stringify(tsconfig, null, 2)}\n`,
    [SDK_MANIFEST_TSCONFIG]: sdkEntryTsconfig(['../manifest.ts']),
    [SDK_SCHEMA_TSCONFIG]: sdkEntryTsconfig(['../data/schema.ts']),
  };
}
