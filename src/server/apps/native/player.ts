/**
 * Server-only: make a native App's web player page from a build package.
 * The package's NSH output is untrusted, so only App-scoped files are taken
 * from it: the runtime is published as its own content-addressed set and
 * the player script, styles, fonts and page are the platform's.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { BUILD_WORK_DIR, REPO_ROOT } from '~agent/paths';
import { materializeAppHatchSdk } from '~agent/hatch-sdk';
import { APP_SDK } from '../../../../sdk-internal/definitions';
import {
  NATIVE_RUNTIME_META,
  NATIVE_SURFACE_PROTOCOL,
} from '../../../../sdk-internal/app/src/native-surface';
import type { NativePlayerConfig } from '../../../../sdk-internal/app/src/native-player';
import { ACCENT_NAMES, DEFAULT_ACCENT } from '../../../ui/theme/accents';
import {
  BUILD_PACKAGE_NATIVE_DESCRIPTION,
  BUILD_PACKAGE_NSH_RUNTIME_DIR,
  nativePackageSchema,
} from '../../../app-build/format';
import { nativeAppRefs, nativeRuntimeRefs } from '../../../app-build/native';
import {
  hatchSdkPlugin,
  sourceBoundaryPlugin,
} from '../../../toolchain/esbuild-plugins';
import { dataTableUrl, rpcUrl, type AppApi } from '../manifest';
import { nativeGrant, nshAppId } from './nsh-config';
import { NSH_VERSION } from './nsh-toolchain';
import { nshThemesByAccent } from './nsh-theme';
import { publishRuntimeSet } from './runtime-store';
import { randomUUID } from 'node:crypto';

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

let playerScript: Promise<string> | undefined;

/** The player script, bundled once per platform process from its own SDK. */
function nativePlayerScript(): Promise<string> {
  playerScript ??= (async () => {
    const root = path.join(BUILD_WORK_DIR, `native-player-${randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
    try {
      await materializeAppHatchSdk(root);
      const realRoot = await fs.realpath(root);
      const result = await esbuild.build({
        absWorkingDir: root,
        plugins: [hatchSdkPlugin(root), sourceBoundaryPlugin(realRoot)],
        stdin: {
          // A platform-only SDK entry: no import map lists it, so App source
          // cannot import it; it is loaded here by its materialized path.
          contents:
            `import { startNativePlayer } from ${JSON.stringify(
              `./.hatch/sdk/${APP_SDK.manifest.name}/${APP_SDK.manifest.exports['./native/player'].default.slice(2)}`,
            )};\n` + 'void startNativePlayer();\n',
          resolveDir: root,
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
      return result.outputFiles[0].text;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  })();
  playerScript.catch(() => {
    playerScript = undefined;
  });
  return playerScript;
}

/** A package-relative reference that stays below its directory. */
function safeRef(file: string, subject: string): string {
  const relative = file.replace(/^\.\//, '');
  const normalized = path.posix.normalize(relative);
  if (
    normalized !== relative ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes('\\')
  ) {
    throw new Error(`The native package names an invalid ${subject}: ${file}`);
  }
  return normalized;
}

export type NativePlayerOptions = {
  /** The accepted build package. */
  packageDir: string;
  /** Artifact root; the frontend goes to `<out>/app/`. */
  out: string;
  app: { id: string; name: string };
  api?: AppApi;
  dataTable: boolean;
  deploymentId: string;
  logs: string[];
};

/** Copy a native frontend and write its player. Returns the NSH version. */
export async function assembleNativePlayer(
  options: NativePlayerOptions,
): Promise<{ nshVersion: string }> {
  const { packageDir, out, app } = options;
  const description = nativePackageSchema.safeParse(
    JSON.parse(
      await fs
        .readFile(
          path.join(packageDir, BUILD_PACKAGE_NATIVE_DESCRIPTION),
          'utf8',
        )
        .catch(() => {
          throw new Error('The build package has no native frontend.');
        }),
    ),
  );
  if (!description.success) {
    throw new Error('The build package describes its native frontend wrongly.');
  }
  const packaged = description.data;
  if (packaged.nshVersion !== NSH_VERSION) {
    throw new Error(
      `The native frontend was built with nsh ${packaged.nshVersion}; ` +
        `this platform runs nsh ${NSH_VERSION}.`,
    );
  }

  const appIn = path.join(packageDir, 'app');
  const appOut = path.join(out, 'app');
  const webOut = path.join(appOut, 'web');
  await fs.mkdir(webOut, { recursive: true });
  await fs.copyFile(
    path.join(appIn, 'bundle.js'),
    path.join(appOut, 'bundle.js'),
  );
  // Only files the packaged App references (and NSH's facades) are served.
  const appRefs = nativeAppRefs(packaged).map((file) =>
    safeRef(file, 'App file'),
  );
  for (const file of appRefs) {
    const source = path.join(appIn, 'web', ...file.split('/'));
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`The native package is missing web/${file}.`);
    }
  }
  await fs.cp(path.join(appIn, 'web'), webOut, { recursive: true });

  const runtimeRefs = nativeRuntimeRefs(packaged).map((file) =>
    safeRef(file, 'runtime file'),
  );
  const runtimeBase = await publishRuntimeSet(
    NSH_VERSION,
    path.join(packageDir, BUILD_PACKAGE_NSH_RUNTIME_DIR),
    runtimeRefs,
  );

  const web = (file: string) => `web/${safeRef(file, 'App file')}`;
  const runtimeRel = (file: string) => safeRef(file, 'runtime file');
  const methods: Record<string, string[]> = {};
  for (const service of options.api?.services ?? []) {
    methods[service.name] = service.methods
      .filter((method) => !method.clientStreaming && !method.serverStreaming)
      .map((method) => method.name);
  }
  const config: NativePlayerConfig = {
    appId: app.id,
    deploymentId: options.deploymentId,
    name: app.name,
    nshAppId: nshAppId(app.id),
    runtime: {
      base: runtimeBase,
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
      chunkFonts: packaged.chunkFonts ?? {},
      chunkSides: packaged.chunkSides ?? {},
      entryChunks: packaged.entryChunks ?? [],
      nativeExports: packaged.nativeExports ?? {},
    },
    grant: nativeGrant(),
    rpc: options.api?.services.length ? { url: rpcUrl(app.id), methods } : null,
    data: options.dataTable ? { url: dataTableUrl(app.id) } : null,
    themes: nshThemesByAccent(),
    defaultAccent: DEFAULT_ACCENT,
  };
  // Every accent the player may be told about has a theme.
  for (const accent of ACCENT_NAMES) {
    if (!config.themes[accent]) throw new Error(`No theme for ${accent}`);
  }

  await fs.writeFile(
    path.join(appOut, 'player.js'),
    await nativePlayerScript(),
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
<link rel="modulepreload" href="${runtimeBase}${runtimeRel(packaged.runtime)}">
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
  options.logs.push(
    `assembled native player for nsh ${NSH_VERSION} -> app/index.html`,
  );
  return { nshVersion: NSH_VERSION };
}
