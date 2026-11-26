/**
 * Build and check a `native` (NSH TSX) App frontend inside the disposable
 * build copy. The platform makes the player page from what this writes
 * (src/server/apps/native/player.ts).
 *
 * Deploy check, in order (docs/app-native-runtime.md):
 *  1. `nsh check`: types, including token names;
 *  2. the source rules NSH does not enforce (import boundary, bare colours,
 *     streaming RPC calls);
 *  3. `nsh build --release`, with unknown-class warnings as errors;
 *  4. `nsh test` headless start-up with canned host answers: App code runs
 *     here, under the sandbox identity, with no network or file grant and a
 *     time limit;
 * then `nsh package --target web` produces the linked module the player runs.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  NATIVE_APP_SDK_DEFINITIONS,
  sdkImports,
} from '../../sdk-internal/definitions';
import { DEFAULT_ACCENT } from '../ui/theme/accents';
import type { AppApi } from '../server/apps/manifest';
import { nshTailwind, nshTheme } from '../server/apps/native/nsh-theme';
import { isRuntimeFileName } from '../server/apps/native/runtime-names';
import {
  checkNativeSourceRules,
  nativeModuleGraph,
} from '../server/apps/native/source-rules';
import {
  BUILD_PACKAGE_NATIVE_DESCRIPTION,
  BUILD_PACKAGE_NSH_RUNTIME_DIR,
  type NativePackage,
} from './format';
import type { BuildNshHost } from './host';

/**
 * Host calls a native App is granted on every shell, and nothing else: no
 * network, files, clipboard or URL access. Granted native capabilities add
 * their `hatch.native.<id>.*` names (a later phase).
 */
export const NATIVE_HOST_CALLS = [
  'hatch.rpc',
  'hatch.data.query',
  'hatch.data.mutate',
  'hatch.data.events',
  'hatch.theme.get',
  'hatch.nav.setTitle',
  'hatch.nav.setRoute',
  'hatch.nav.open',
  'hatch.native.supports',
] as const;

/**
 * The NSH app id of a Hatch App: NSH scopes an App's storage by it, so the
 * mapping is reversible. Hatch ids are `[a-z0-9-]`; `x` and `-` are escaped
 * as `x` plus two hex digits (`habit-tracker` -> `habitx2dtracker`), so
 * `habit-tracker` and `habittracker` never share a namespace.
 */
export function nshAppId(appId: string): string {
  const encoded = appId.replace(
    /[^a-wyz0-9]/g,
    (char) => `x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  return `dev.hatch.app.${encoded}`;
}

/** Exact `nsh.json` aliases: one per entry of every native SDK, App-root relative. */
export function nativeSdkAliases(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sdkImports(NATIVE_APP_SDK_DEFINITIONS, 'native')).map(
      ([specifier, target]) => [specifier, `./.hatch/${target.slice(2)}`],
    ),
  );
}

/** The platform-generated `nsh.json` at the App root. */
export function nativeNshJson(app: {
  id: string;
  name: string;
  entry: string;
}): string {
  return `${JSON.stringify(
    {
      name: app.name,
      // Names the App root as NSH's app directory for this entry. Without
      // it, an `App.tsx` beside the entry would make `app/` the app
      // directory, where the SDK aliases under `.hatch/` cannot be reached.
      entry: app.entry,
      id: nshAppId(app.id),
      version: '1.0.0',
      build: 1,
      // Declared capabilities deny everything not listed.
      capabilities: { host: [...NATIVE_HOST_CALLS] },
      resolve: { alias: nativeSdkAliases() },
      // Hatch is light-only until the theme-data phase adds dark presets.
      appearance: 'light',
      theme: nshTheme(DEFAULT_ACCENT),
      ...(nshTailwind() ? { tailwind: nshTailwind() } : {}),
    },
    null,
    2,
  )}\n`;
}

/** The platform-generated `app/tsconfig.json` next to the entry. */
export function nativeEntryTsconfig(): string {
  const paths: Record<string, string[]> = {
    nsh: ['./.nsh/types/nsh/index.d.ts'],
    'nsh/*': ['./.nsh/types/nsh/*.d.ts'],
  };
  for (const [specifier, target] of Object.entries(nativeSdkAliases())) {
    // `.js` targets resolve to their sibling declarations; source entries
    // (`.ts`/`.tsx` libraries) are checked as they are.
    paths[specifier] = [`.${target.replace(/\.js$/, '')}`];
  }
  return `${JSON.stringify(
    {
      extends: './.nsh/tsconfig.json',
      compilerOptions: { allowImportingTsExtensions: true, paths },
      include: ['**/*.ts', '**/*.tsx', '../gen/**/*.ts'],
      exclude: ['./.nsh'],
    },
    null,
    2,
  )}\n`;
}

/**
 * Rewrite the paths NSH prints to App-root paths. `nsh build`, `nsh test` and
 * `nsh package` print them relative to the entry's directory (`main.tsx:4:2`,
 * `../gen/x.ts`): pass that directory as `base`. TypeScript in `nsh check`
 * prints them relative to the App root (`app/main.tsx(4,2)`): pass `''`.
 */
export function appRelativeDiagnostics(output: string, base: string): string {
  return output.replace(
    /(^|[\s('"`])((?:\.\.?\/)*[\w@][\w@./-]*\.(?:tsx|ts|jsx|js|mts|cts))(?=[:(]\d)/gm,
    (_match, lead: string, file: string) =>
      `${lead}${path.posix.normalize(path.posix.join(base, file))}`,
  );
}

/** Unknown-class warnings from `nsh build`, as `file:line:col: message`. */
export function unknownClassWarnings(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^warn\b.*unknown class/.test(line))
    .map((line) => line.replace(/^warn\s+(?:nsh::build\s+)?/, ''));
}

export class NativeBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeBuildError';
  }
}

/**
 * The platform owns `nsh.json` and `app/tsconfig.json` (rewritten below) and
 * NSH regenerates `.nsh/` caches (removed here). Any other `nsh.json` could
 * give an entry its own capabilities or Rust crates, so it is refused.
 */
async function prepareNshFiles(src: string): Promise<void> {
  const refused: string[] = [];
  async function walk(relative: string): Promise<void> {
    const dir = path.join(src, relative);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (['node_modules', '.hatch', '.git'].includes(entry.name)) continue;
        if (entry.name === '.nsh') {
          await fs.rm(path.join(src, child), { recursive: true, force: true });
          continue;
        }
        await walk(child);
      } else if (entry.name === 'nsh.json' && child !== 'nsh.json') {
        refused.push(child);
      }
    }
  }
  await walk('');
  if (refused.length) {
    throw new NativeBuildError(
      'Native App source validation failed: the platform generates nsh.json ' +
        'at the App root; remove ' +
        refused.sort().join(', '),
    );
  }
}

/** The canned host of the start-up check (`nsh test --web-host`). */
const SMOKE_HOST = `// Generated by the Hatch build: canned answers for the start-up check.
const theme = __THEME__;
export function createHost() {
  return {
    async call(name, args) {
      switch (name) {
        case "hatch.theme.get": return { ok: true, theme };
        case "hatch.rpc": return { ok: true, message: {}, header: {} };
        case "hatch.data.query":
          return { ok: true, result: { items: [], revision: 0, cursor: null } };
        case "hatch.data.events": return new Promise(() => {});
        case "hatch.nav.setTitle":
        case "hatch.nav.setRoute": return { ok: true };
        case "hatch.native.supports": return { ok: true, capabilities: [] };
        default:
          return { ok: false, code: "unavailable", message: name + " is not available during the deploy check" };
      }
    },
  };
}
`;

/**
 * Files of the page `nsh package --target web` writes for itself (its HTML,
 * start script, styles and icons). The player page replaces that page.
 */
const NSH_PAGE_FILE =
  /^(?:index\.html|manifest\.webmanifest|nsh-(?:start|prefetch)\.[0-9a-f]{8,}\.js|nsh-page\.[0-9a-f]{8,}\.css|icons\/[\w.-]+\.png)$/;

/** How long the start-up check may run before the deploy fails. */
const SMOKE_TIMEOUT_MS = 60_000;

type PackagedApp = NativePackage & {
  id: string;
  rust?: boolean;
  host?: string | null;
  glue?: string;
};

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function packagedApp(html: string, version: string): PackagedApp {
  const match =
    /<script type="application\/json" id="nsh-app">([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (!match) {
    throw new NativeBuildError(
      `nsh package wrote no app description; is nsh ${version} installed?`,
    );
  }
  return JSON.parse(match[1]) as PackagedApp;
}

const relativeRef = (file: string) => file.replace(/^\.\//, '');

/** The runtime files a packaged App references, App-root relative. */
export function nativeRuntimeRefs(packaged: NativePackage): string[] {
  return [
    packaged.runtime,
    packaged.wasm,
    ...Object.values(packaged.data ?? {}),
    ...Object.values(packaged.sides ?? {}).map((side) => side.url),
  ].map(relativeRef);
}

/** The App files a packaged App references, App-root relative. */
export function nativeAppRefs(packaged: NativePackage): string[] {
  return [
    packaged.code,
    ...Object.values(packaged.chunks ?? {}),
    ...Object.values(packaged.assets ?? {}),
  ].map(relativeRef);
}

export type NativeBuildOptions = {
  /** Disposable App root (already installed, SDK materialized, codegen run). */
  src: string;
  /** Package root; the frontend goes to `<out>/app/`. */
  out: string;
  /** Scratch directory for NSH's intermediate output. */
  workDir: string;
  app: { id: string; name: string; entry: string };
  api?: AppApi;
  nsh: BuildNshHost;
  logs: string[];
};

/**
 * Build a native frontend into `<out>/app/`: the release bundle, the linked
 * web module, its runtime files and the package description.
 */
export async function buildNativeFrontend(
  options: NativeBuildOptions,
): Promise<void> {
  const { src, out, app, logs, nsh } = options;
  const entryDir = path.posix.dirname(app.entry);
  if (entryDir !== 'app') {
    throw new NativeBuildError(
      `A native App's entry must be directly in app/ (app/main.tsx); got ${app.entry}.`,
    );
  }

  await prepareNshFiles(src);
  await fs.writeFile(path.join(src, 'nsh.json'), nativeNshJson(app), 'utf8');
  await fs.writeFile(
    path.join(src, 'app', 'tsconfig.json'),
    nativeEntryTsconfig(),
    'utf8',
  );

  const work = path.join(options.workDir, `${app.id}-nsh-${randomUUID()}`);
  await fs.mkdir(work, { recursive: true });
  try {
    const nshRun = async (
      step: string,
      args: string[],
      extra: { sandboxed?: boolean; timeoutMs?: number } = {},
    ) => {
      const result = await nsh.run(args, { cwd: src, ...extra });
      const output = appRelativeDiagnostics(
        result.output.trim(),
        args[0] === 'check' ? '' : entryDir,
      );
      logs.push(`$ nsh ${args.join(' ')}\n${output}`);
      if (result.code !== 0) {
        throw new NativeBuildError(`${step} failed:\n${output}`);
      }
      return output;
    };

    // 1) Types, token names included.
    await nshRun('nsh check', ['check', app.entry]);

    // 2) Rules NSH does not enforce.
    const files = await nativeModuleGraph({
      root: src,
      entry: app.entry,
      aliases: nativeSdkAliases(),
    });
    await checkNativeSourceRules({
      root: src,
      files,
      services: options.api?.services ?? [],
    });
    const custom = files.filter((file) => file.startsWith('app/custom/'));
    logs.push(
      custom.length
        ? `native custom files (may use nsh directly):\n  ${custom.join('\n  ')}`
        : 'native custom files: none',
    );

    // 3) Release build; unknown classes are not tokens of the catalogue.
    const bundleDir = path.join(work, 'bundle');
    const built = await nshRun('nsh build', [
      'build',
      '--release',
      '-o',
      bundleDir,
      app.entry,
    ]);
    const unknown = unknownClassWarnings(built);
    if (unknown.length) {
      throw new NativeBuildError(
        `nsh build failed: unknown classes are not theme tokens:\n${unknown.join('\n')}`,
      );
    }

    // 4) Start-up check on canned host answers.
    const smokeHost = path.join(work, 'smoke-host.js');
    await fs.writeFile(
      smokeHost,
      SMOKE_HOST.replace('__THEME__', JSON.stringify(nshTheme())),
      'utf8',
    );
    await fs.chmod(work, 0o755);
    await fs.chmod(smokeHost, 0o644);
    // `nsh test` writes its step harness to `.nsh/test/` in the app
    // directory, the App root (nsh.json names the entry); start from a
    // fresh one.
    await fs.rm(path.join(src, '.nsh', 'test'), {
      recursive: true,
      force: true,
    });
    // The check runs as the sandbox identity, which owns the private build
    // copy only while it runs.
    await nsh.withSandboxOwnership([src], () =>
      nshRun(
        'Start-up check (nsh test)',
        ['test', app.entry, '--web-host', smokeHost],
        { sandboxed: true, timeoutMs: SMOKE_TIMEOUT_MS },
      ),
    );

    // 5) The linked web module and its engine.
    const packageDir = path.join(work, 'web');
    await nshRun('nsh package', [
      'package',
      '--target',
      'web',
      '-o',
      packageDir,
      '--name',
      'app',
      '--id',
      nshAppId(app.id),
      '--app-version',
      '1.0.0',
      '--build',
      '1',
      app.entry,
    ]);
    const site = path.join(packageDir, 'app');
    const packaged = packagedApp(
      await fs.readFile(path.join(site, 'index.html'), 'utf8'),
      nsh.version,
    );
    if (packaged.rust || packaged.host || packaged.glue) {
      throw new NativeBuildError(
        'nsh package produced a Rust or host-module app; native Apps are TSX only.',
      );
    }

    const appOut = path.join(out, 'app');
    const webOut = path.join(appOut, 'web');
    const runtimeOut = path.join(out, BUILD_PACKAGE_NSH_RUNTIME_DIR);
    await fs.mkdir(webOut, { recursive: true });
    await fs.copyFile(
      path.join(bundleDir, 'bundle.js'),
      path.join(appOut, 'bundle.js'),
    );
    // What native shells will load later (phase 4 packages it).
    await fs.mkdir(path.join(appOut, 'native'), { recursive: true });
    for (const extra of ['bundle.js.map', 'bundle.nshc', 'capabilities.json']) {
      await fs
        .copyFile(
          path.join(bundleDir, extra),
          path.join(appOut, 'native', extra),
        )
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }

    const runtimeRefs = nativeRuntimeRefs(packaged);
    const appRefs = new Set(nativeAppRefs(packaged));
    const allFiles = await listFiles(site);
    const runtimeFiles = new Set<string>();
    for (const file of allFiles) {
      const base = file.replace(/\.(?:br|gz)$/, '');
      if (runtimeRefs.includes(base) || /^browser\.[0-9a-f]+\//.test(file)) {
        if (!isRuntimeFileName(file)) {
          throw new NativeBuildError(`Unexpected NSH runtime file: ${file}`);
        }
        runtimeFiles.add(file);
      }
    }
    // Every file `nsh package` wrote is served (runtime or App) or belongs
    // to its own page, which the player page replaces. A file of another
    // kind (a new NSH release loading more on demand, say) would 404 only
    // when the App first needs it, so it fails the build here instead.
    const unplaced = allFiles.filter((file) => {
      const base = file.replace(/\.(?:br|gz)$/, '');
      return !(
        runtimeFiles.has(file) ||
        appRefs.has(base) ||
        file.startsWith('facades/') ||
        NSH_PAGE_FILE.test(base)
      );
    });
    const missing = [...runtimeRefs, ...appRefs].filter(
      (file) => !allFiles.includes(file),
    );
    if (unplaced.length || missing.length) {
      throw new NativeBuildError(
        `nsh ${nsh.version} package output does not match what the player ` +
          `serves: ${[
            ...unplaced.map((file) => `unexpected ${file}`),
            ...missing.map((file) => `missing ${file}`),
          ].join(', ')}`,
      );
    }
    for (const file of allFiles) {
      const base = file.replace(/\.(?:br|gz)$/, '');
      const target = (root: string) => path.join(root, ...file.split('/'));
      if (runtimeFiles.has(file)) {
        await fs.mkdir(path.dirname(target(runtimeOut)), { recursive: true });
        await fs.copyFile(path.join(site, file), target(runtimeOut));
        continue;
      }
      if (file.endsWith('.br') || file.endsWith('.gz')) continue;
      if (appRefs.has(base) || file.startsWith('facades/')) {
        await fs.mkdir(path.dirname(target(webOut)), { recursive: true });
        await fs.copyFile(path.join(site, file), target(webOut));
      }
    }

    const description: NativePackage = {
      nshVersion: nsh.version,
      runtime: packaged.runtime,
      wasm: packaged.wasm,
      code: packaged.code,
      data: packaged.data,
      sides: packaged.sides,
      assets: packaged.assets,
      fonts: packaged.fonts,
      chunks: packaged.chunks,
      chunkFonts: packaged.chunkFonts,
      chunkSides: packaged.chunkSides,
      entryChunks: packaged.entryChunks,
      nativeExports: packaged.nativeExports,
    };
    await fs.writeFile(
      path.join(out, BUILD_PACKAGE_NATIVE_DESCRIPTION),
      JSON.stringify(description, null, 2),
      'utf8',
    );
    logs.push(
      `built native frontend with nsh ${nsh.version} -> app/bundle.js, ` +
        `${runtimeFiles.size} runtime file(s)`,
    );
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
