/** Public SDK exports are the shared build and resolution contract. */
import appManifest from './app/package.json' with { type: 'json' };
import dataManifest from './data/package.json' with { type: 'json' };
import uiManifest from './ui/package.json' with { type: 'json' };
import uiTailwind from './ui/src/tailwind.json' with { type: 'json' };
import { buildAppTheme, type AccentName } from './ui/theme/build.ts';

type SdkManifest = {
  name: string;
  exports: Record<string, { types: string; default: string }>;
  peerDependencies: Record<string, string>;
};

/**
 * Which App runtime may import an entry: `web` entries (React adapters,
 * browser storage scoping, backend task helpers) stay out of `nsh.json`;
 * `native` entries (the NSH host bridge) stay out of the web and Deno import
 * maps. Absent means both. `platform` entries are in neither: only platform
 * builds load them, by path.
 */
export type SdkEntryRuntime = 'web' | 'native' | 'platform';

type SdkEntry = ({ source: string } | { reexport: string }) & {
  runtime?: SdkEntryRuntime;
};

import type { ResolvedTheme } from '../packages/hatch-design-tokens/src/index.ts';

/** An NSH theme: shadcn `cssVars`, as `nsh.json` "theme" and `setTheme` take. */
export type SdkNshTheme = {
  cssVars: {
    theme?: Record<string, string | number>;
    light?: Record<string, string | number>;
    dark?: Record<string, string | number>;
  };
};

export type SdkDefinition = {
  directory: string;
  manifest: SdkManifest;
  entries: Record<string, SdkEntry>;
  /**
   * `bundle` (the default): `src/` is bundled by esbuild into `dist/` with
   * declarations. `source`: `src/` is copied to `dist/` verbatim, for a
   * library NSH compiles together with the App (its TSX output is reactive
   * only when NSH compiles it).
   */
  form?: 'bundle' | 'source';
  /**
   * What a native UI library contributes to every native App: the generated
   * `nsh.json` "theme" and "tailwind", and the theme shells push with
   * `hatch.theme`. At most one definition in NATIVE_APP_SDK_DEFINITIONS sets
   * it; without one the platform's own token theme applies.
   */
  nsh?: {
    /** The complete theme for an accent name (`indigo`, `teal`, ...). */
    theme?: (accent: string) => SdkNshTheme;
    /**
     * The complete theme for a user's resolved theme (a preset or a
     * custom theme, light or dark; `ResolvedTheme` in
     * `packages/hatch-design-tokens`).
     */
    resolvedTheme?: (theme: ResolvedTheme) => SdkNshTheme;
    /** `nsh.json` "tailwind" (an object, inlined). */
    tailwind?: Record<string, unknown>;
  };
};

export const APP_SDK: SdkDefinition = {
  directory: 'app',
  manifest: appManifest,
  entries: {
    '.': { source: 'app.ts' },
    './data': { source: 'data.ts' },
    './data/react': { source: 'data-react.ts', runtime: 'web' },
    './notifications': { source: 'notifications.ts' },
    './storage': { source: 'storage.ts', runtime: 'web' },
    './storage/react': { source: 'storage-react.ts', runtime: 'web' },
    './storage/install': { source: 'storage-install.ts', runtime: 'web' },
    './tasks': { source: 'tasks.ts', runtime: 'web' },
    './native': { source: 'native.ts', runtime: 'native' },
    './native/rpc': { source: 'native-rpc.ts', runtime: 'native' },
    // Not for App source: the platform bundles it as the native web player.
    './native/player': { source: 'native-player.ts', runtime: 'platform' },
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

/**
 * `@hatch/ui`, the component library of native Apps: NSH TSX source that
 * NSH compiles with the App. Its theme and Tailwind extension become every
 * native App's `nsh.json` "theme" and "tailwind", and the theme shells push.
 */
export const UI_SDK: SdkDefinition = {
  directory: 'ui',
  manifest: uiManifest,
  form: 'source',
  entries: { '.': { source: 'index.ts', runtime: 'native' } },
  nsh: {
    theme: (accent) => buildAppTheme({ accent: accent as AccentName }),
    resolvedTheme: (theme) => buildAppTheme({ theme }),
    tailwind: uiTailwind,
  },
};

/**
 * Every SDK a web or Deno source resolves: `@hatch/app` and its legacy
 * alias. They feed the import map and the `.hatch/tsconfig.json` paths.
 */
export const SDK_DEFINITIONS = [APP_SDK, LEGACY_DATA_SDK];

/**
 * SDKs a `native` (NSH) App frontend may import. The platform generates one
 * exact `nsh.json` alias per entry of these, so adding a library here is all
 * it takes to make it importable. They are materialized with the App SDK.
 */
export const NATIVE_APP_SDK_DEFINITIONS: readonly SdkDefinition[] = [
  APP_SDK,
  UI_SDK,
];

/**
 * Public specifier -> target below `.hatch/` for every entry `runtime` may
 * import. Web and Deno resolution (the default) never see native-only
 * entries.
 */
export function sdkImports(
  definitions: readonly SdkDefinition[],
  runtime: 'web' | 'native' = 'web',
): Record<string, string> {
  return Object.fromEntries(
    definitions.flatMap(({ manifest, entries }) =>
      Object.entries(manifest.exports)
        .filter(([key]) => {
          const only = entries[key]?.runtime;
          return only === undefined || only === runtime;
        })
        .map(([key, entry]) => [
          key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`,
          `./sdk/${manifest.name}/${entry.default.slice(2)}`,
        ]),
    ),
  );
}

/** Every SDK package materialized into an App root, and built by `pnpm hatch-sdk:build`. */
export function appMaterializedSdkDefinitions(): SdkDefinition[] {
  return [...new Set([...SDK_DEFINITIONS, ...NATIVE_APP_SDK_DEFINITIONS])];
}

/** Deno namespace declarations shipped beside the generated tsconfig. */
export const SDK_DENO_TYPES = 'types/deno.d.ts';
export const SDK_DENO_TYPES_LICENSE = 'types/deno.LICENSE';
export const SDK_TSCONFIG = 'tsconfig.json';
export const SDK_MANIFEST_TSCONFIG = 'tsconfig.manifest.json';
export const SDK_SCHEMA_TSCONFIG = 'tsconfig.schema.json';
/**
 * For a native App: every authored file except its NSH frontend in `app/`
 * (backend, widgets, schema, generated RPC code), which `nsh check` checks
 * against `app/tsconfig.json`.
 */
export const SDK_NATIVE_APP_TSCONFIG = 'tsconfig.native.json';

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
    // `.nsh/` holds NSH's generated types and test harnesses.
    exclude: ['../node_modules', '../.hatch', '../.git', '../**/.nsh'],
  };
  const nativeApp = {
    extends: `./${SDK_TSCONFIG}`,
    exclude: [...tsconfig.exclude, '../app'],
  };
  return {
    [SDK_TSCONFIG]: `${JSON.stringify(tsconfig, null, 2)}\n`,
    [SDK_NATIVE_APP_TSCONFIG]: `${JSON.stringify(nativeApp, null, 2)}\n`,
    [SDK_MANIFEST_TSCONFIG]: sdkEntryTsconfig(['../manifest.ts']),
    [SDK_SCHEMA_TSCONFIG]: sdkEntryTsconfig(['../data/schema.ts']),
  };
}
