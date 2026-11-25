/**
 * Server-only: build and check a `native` (NSH TSX) App frontend inside the
 * disposable build copy, and write its web player page.
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
import * as esbuild from 'esbuild';
import { BUILD_WORK_DIR, REPO_ROOT } from '~agent/paths';
import { withSandboxOwnership } from '~agent/shell-sandbox';
import {
  APP_SDK,
  NATIVE_APP_SDK_DEFINITIONS,
  sdkImports,
} from '../../../../sdk-internal/definitions';
import {
  NATIVE_RUNTIME_META,
  NATIVE_SURFACE_PROTOCOL,
} from '../../../../sdk-internal/app/src/native-surface';
import type { NativePlayerConfig } from '../../../../sdk-internal/app/src/native-player';
import { ACCENT_NAMES, DEFAULT_ACCENT } from '../../../ui/theme/accents';
import { subprocessSandboxEnv } from '../../sandbox-env';
import { run } from '../../subprocess';
import { sandboxedEvaluationCommand } from '../../../toolchain/platform';
import { dataTableUrl, rpcUrl, type AppApi } from '../manifest';
import { nshBinary, nshEnv, NSH_VERSION } from './nsh-toolchain';
import { nshTailwind, nshTheme, nshThemesByAccent } from './nsh-theme';
import {
  isRuntimeFileName,
  nshRuntimeBase,
  publishRuntimeFile,
} from './runtime-store';
import { checkNativeSourceRules, nativeModuleGraph } from './source-rules';

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

/** The grant a shell hands NSH for an App, as the JSON text NSH reads. */
export function nativeGrant(): string {
  return JSON.stringify({ host: [...NATIVE_HOST_CALLS] });
}

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
export function nativeNshJson(app: { id: string; name: string }): string {
  return `${JSON.stringify(
    {
      name: app.name,
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

class NativeBuildError extends Error {
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

/** How long the start-up check may run before the deploy fails. */
const SMOKE_TIMEOUT_MS = 60_000;

type PackagedApp = {
  id: string;
  wasm: string;
  code: string;
  rust?: boolean;
  host?: string | null;
  runtime: string;
  data?: Record<string, string>;
  sides?: Record<string, { url: string } & Record<string, unknown>>;
  assets?: Record<string, string>;
  fonts?: string[];
  chunks?: Record<string, string>;
  nativeExports?: Record<string, string[]>;
  glue?: string;
};

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function htmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const PLAYER_CSS = `html, body { margin: 0; height: 100%; overflow: hidden; }
html, body { background: var(--hatch-player-background, #ffffff); }
#app { position: fixed; inset: 0; }
#status { position: fixed; inset: 0; display: flex; align-items: center;
  justify-content: center; padding: 24px; box-sizing: border-box;
  font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #1e2230; text-align: center; white-space: pre-wrap; }
#status[hidden] { display: none; }
`;

/**
 * The Desk fonts, under the family names the theme uses, from the same
 * `@fontsource-variable` files the platform UI ships. NSH renders text as
 * DOM on the web, so the player page's `@font-face` rules reach the App.
 */
const PLAYER_FONTS = [
  { family: 'Nunito', package: '@fontsource-variable/nunito' },
  { family: 'JetBrains Mono', package: '@fontsource-variable/jetbrains-mono' },
];

async function writePlayerFonts(appOut: string): Promise<void> {
  const fontsOut = path.join(appOut, 'fonts');
  await fs.mkdir(fontsOut, { recursive: true });
  const rules: string[] = [];
  for (const font of PLAYER_FONTS) {
    const dir = path.join(
      REPO_ROOT,
      'node_modules',
      ...font.package.split('/'),
    );
    const css = await fs.readFile(path.join(dir, 'wght.css'), 'utf8');
    const files = new Set<string>();
    rules.push(
      css
        .replace(/font-family:\s*'[^']*'/g, `font-family: '${font.family}'`)
        .replace(/url\(\.\/files\/([\w.-]+)\)/g, (_match, file: string) => {
          files.add(file);
          return `url(./fonts/${file})`;
        }),
    );
    for (const file of files) {
      await fs.copyFile(
        path.join(dir, 'files', file),
        path.join(fontsOut, file),
      );
    }
  }
  await fs.writeFile(path.join(appOut, 'fonts.css'), rules.join('\n'), 'utf8');
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, errorOnExist: false });
}

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

function packagedApp(html: string): PackagedApp {
  const match =
    /<script type="application\/json" id="nsh-app">([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (!match) {
    throw new NativeBuildError(
      `nsh package wrote no app description; is nsh ${NSH_VERSION} installed?`,
    );
  }
  return JSON.parse(match[1]) as PackagedApp;
}

export type NativeBuildOptions = {
  /** Disposable App root (already installed, SDK materialized, codegen run). */
  src: string;
  /** Build output root; the frontend goes to `<out>/app/`. */
  out: string;
  app: { id: string; name: string; entry: string };
  api?: AppApi;
  dataTable: boolean;
  deploymentId?: string;
  /** esbuild resolution for the player script (SDK plugin, boundary). */
  esbuildResolve: Pick<esbuild.BuildOptions, 'absWorkingDir' | 'plugins'>;
  logs: string[];
};

/** Build a native frontend into `<out>/app/`. Returns the NSH version used. */
export async function buildNativeFrontend(
  options: NativeBuildOptions,
): Promise<{ nshVersion: string }> {
  const { src, out, app, logs } = options;
  const nsh = nshBinary();
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

  const env = subprocessSandboxEnv(nshEnv());
  const work = path.join(BUILD_WORK_DIR, `${app.id}-nsh-${randomUUID()}`);
  await fs.mkdir(work, { recursive: true });
  try {
    const nshRun = async (
      step: string,
      args: string[],
      extra: { sandboxed?: boolean; timeoutMs?: number } = {},
    ) => {
      const [command, commandArgs] = extra.sandboxed
        ? sandboxedEvaluationCommand([nsh, ...args])
        : [nsh, args];
      const result = await run(command, commandArgs, {
        cwd: src,
        env,
        timeoutMs: extra.timeoutMs,
      });
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
    // `nsh test` writes its step harness to `<entry dir>/.nsh/test/`; start
    // from a fresh one.
    await fs.rm(path.join(src, entryDir, '.nsh', 'test'), {
      recursive: true,
      force: true,
    });
    // The check runs as the sandbox identity, which owns the private build
    // copy only while it runs.
    await withSandboxOwnership([src], () =>
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
    );
    if (packaged.rust || packaged.host || packaged.glue) {
      throw new NativeBuildError(
        'nsh package produced a Rust or host-module app; native Apps are TSX only.',
      );
    }

    const appOut = path.join(out, 'app');
    const webOut = path.join(appOut, 'web');
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

    // Runtime files go to the shared, content-addressed store; App files
    // stay with the deployment.
    const runtimeFiles = new Set<string>();
    const runtimeRefs = [
      packaged.runtime,
      packaged.wasm,
      ...Object.values(packaged.data ?? {}),
      ...Object.values(packaged.sides ?? {}).map((side) => side.url),
    ].map((file) => file.replace(/^\.\//, ''));
    const allFiles = await listFiles(site);
    for (const file of allFiles) {
      const base = file.replace(/\.(?:br|gz)$/, '');
      if (runtimeRefs.includes(base) || /^browser\.[0-9a-f]+\//.test(file)) {
        if (!isRuntimeFileName(file)) {
          throw new NativeBuildError(`Unexpected NSH runtime file: ${file}`);
        }
        runtimeFiles.add(file);
      }
    }
    for (const file of runtimeFiles) {
      await publishRuntimeFile(NSH_VERSION, file, path.join(site, file));
    }
    const appRefs = new Set(
      [
        packaged.code,
        ...Object.values(packaged.chunks ?? {}),
        ...Object.values(packaged.assets ?? {}),
      ].map((file) => file.replace(/^\.\//, '')),
    );
    for (const file of allFiles) {
      const base = file.replace(/\.(?:br|gz)$/, '');
      if (file.endsWith('.br') || file.endsWith('.gz')) continue;
      if (appRefs.has(base) || file.startsWith('facades/')) {
        await copyTree(path.join(site, file), path.join(webOut, file));
      }
    }

    const web = (file: string) => `web/${file.replace(/^\.\//, '')}`;
    const runtimeRel = (file: string) => file.replace(/^\.\//, '');
    const methods: Record<string, string[]> = {};
    for (const service of options.api?.services ?? []) {
      methods[service.name] = service.methods
        .filter((method) => !method.clientStreaming && !method.serverStreaming)
        .map((method) => method.name);
    }
    const config: NativePlayerConfig = {
      appId: app.id,
      deploymentId: options.deploymentId ?? '',
      name: app.name,
      nshAppId: nshAppId(app.id),
      runtime: {
        base: nshRuntimeBase(NSH_VERSION),
        module: runtimeRel(packaged.runtime),
        wasm: runtimeRel(packaged.wasm),
        data: Object.fromEntries(
          Object.entries(packaged.data ?? {}).map(([key, file]) => [
            key,
            runtimeRel(file),
          ]),
        ),
        sides: Object.fromEntries(
          Object.entries(packaged.sides ?? {}).map(([key, side]) => [
            key,
            { ...side, url: runtimeRel(side.url) },
          ]),
        ),
      },
      app: {
        code: web(packaged.code),
        chunks: Object.fromEntries(
          Object.entries(packaged.chunks ?? {}).map(([key, file]) => [
            key,
            web(file),
          ]),
        ),
        assets: Object.fromEntries(
          Object.entries(packaged.assets ?? {}).map(([key, file]) => [
            key,
            web(file),
          ]),
        ),
        fonts: packaged.fonts ?? [],
        nativeExports: packaged.nativeExports ?? {},
      },
      grant: nativeGrant(),
      rpc: options.api?.services.length
        ? { url: rpcUrl(app.id), methods }
        : null,
      data: options.dataTable ? { url: dataTableUrl(app.id) } : null,
      themes: nshThemesByAccent(),
      defaultAccent: DEFAULT_ACCENT,
    };
    // Every accent the player may be told about has a theme.
    for (const accent of ACCENT_NAMES) {
      if (!config.themes[accent]) throw new Error(`No theme for ${accent}`);
    }

    const player = await esbuild.build({
      ...options.esbuildResolve,
      stdin: {
        // A platform-only SDK entry: no import map lists it, so App source
        // cannot import it; it is loaded here by its materialized path.
        contents:
          `import { startNativePlayer } from ${JSON.stringify(
            `./.hatch/sdk/${APP_SDK.manifest.name}/${APP_SDK.manifest.exports['./native/player'].default.slice(2)}`,
          )};\n` + 'void startNativePlayer();\n',
        resolveDir: options.esbuildResolve.absWorkingDir,
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    await fs.writeFile(
      path.join(appOut, 'player.js'),
      player.outputFiles[0].text,
      'utf8',
    );
    await fs.writeFile(path.join(appOut, 'player.css'), PLAYER_CSS, 'utf8');
    await writePlayerFonts(appOut);
    const title = htmlText(app.name);
    await fs.writeFile(
      path.join(appOut, 'index.html'),
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="${NATIVE_RUNTIME_META}" content="native" data-protocol="${NATIVE_SURFACE_PROTOCOL}">
<title>${title}</title>
<link rel="stylesheet" href="./player.css">
<link rel="stylesheet" href="./fonts.css">
<link rel="modulepreload" href="${nshRuntimeBase(NSH_VERSION)}${runtimeRel(packaged.runtime)}">
<script type="application/json" id="hatch-player">${scriptJson(config)}</script>
<script type="module" src="./player.js"></script>
</head>
<body>
<div id="app"></div>
<div id="status" role="status" aria-live="polite" hidden></div>
<noscript>${title} needs JavaScript.</noscript>
</body>
</html>
`,
      'utf8',
    );
    logs.push(
      `built native frontend with nsh ${NSH_VERSION} -> app/index.html, ` +
        `app/bundle.js, ${runtimeFiles.size} shared runtime file(s)`,
    );
    return { nshVersion: NSH_VERSION };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
