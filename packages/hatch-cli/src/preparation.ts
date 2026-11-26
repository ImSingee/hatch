/** Frozen source preparation without platform server imports or credentials. */
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  mkdir,
  mkdtemp,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceManifestSchema } from '../../hatch-manifest/src/app-schema.js';
import { isAppManagedPathSegment } from '../../../src/app-managed-path';
import {
  NATIVE_ENTRY_TSCONFIG_FILE,
  NATIVE_NSH_BASE_FILE,
  composeNativeNshJson,
} from '../../../src/app-native-config';
import { validateDenoDependencySource } from '../../../src/deno-dependencies';
import {
  MANIFEST_SERIALIZER,
  MANIFEST_RESULT,
} from '../../../src/manifest-evaluation';
import { validateNodeDependencySource } from '../../../src/node-dependencies';
import {
  assertBundleInputsInsideRoot,
  assertListedFilesInsideRoot,
  assertNoBundleImports,
  esbuildManifestCliArgs,
  nodeEvaluationArgs,
  pnpmDlxArgs,
  pnpmFetchArgs,
  pnpmInstallArgs,
  tscArgs,
  withEmptyConfigHome,
  type BundleMetafile,
} from '../../../src/node-toolchain-commands';
import {
  detectSourceToolchain,
  sourceToolchainReader,
} from '../../../src/source-toolchain';
import { CliError, preparationFailure } from './error';
import { command, childEnvironment } from './process';
import { pnpmInvocation } from './pnpm';

function inside(root: string, target: string) {
  const path = relative(root, target);
  return (
    path === '' ||
    (!isAbsolute(path) &&
      path !== '..' &&
      !path.startsWith('../') &&
      !path.startsWith('..\\'))
  );
}
async function preflight(root: string, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      directory === root &&
      ['.git', '.hatch', 'node_modules', 'gen'].includes(entry.name)
    ) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error(`${entry.name} must be a real directory.`);
      continue;
    }
    if (entry.isSymbolicLink() || isAppManagedPathSegment(entry.name))
      throw new Error('Source contains a symlink or reserved managed path.');
    if (entry.isDirectory()) await preflight(root, join(directory, entry.name));
  }
}
async function trustedEnv(root: string) {
  const env = childEnvironment();
  const entries: string[] = [];
  for (const path of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(path)) continue;
    const canonical = await realpath(path).catch(() => null);
    if (canonical && !inside(root, canonical)) entries.push(canonical);
  }
  env.PATH = [...new Set(entries)].join(delimiter);
  return env;
}
/** Tool versions the platform builds with, as delivered with its SDK. */
export type Tooling = {
  bufVersion: string;
  protocGenEsVersion: string;
  typescriptVersion?: string;
  esbuildVersion?: string;
  pnpmVersion?: string;
};
type ToolingSource = Tooling | undefined | (() => Promise<Tooling | undefined>);

const MANIFEST_TSCONFIG = '.hatch/tsconfig.manifest.json';

/**
 * The Node build toolchain as this machine can run it: the user's pnpm with
 * the platform's fixed arguments, and the platform's pinned tsc and esbuild
 * fetched with `pnpm dlx`. Manifest evaluation uses this process's own Node.
 */
async function nodeToolchain(
  root: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  source: ToolingSource,
  configHome: string,
) {
  const tooling = typeof source === 'function' ? await source() : source;
  const { typescriptVersion, esbuildVersion, pnpmVersion } = tooling ?? {};
  if (!typescriptVersion || !esbuildVersion || !pnpmVersion)
    throw new Error(
      'This platform does not provide the pnpm build toolchain. Upgrade the platform, or keep building this source with deno.json and deno.lock.',
    );
  const pnpm = await pnpmInvocation(process.platform, env);
  // Global pnpm configuration could redirect downloads; the directory is empty.
  const pnpmEnv = { ...env, XDG_CONFIG_HOME: configHome };
  const run = (args: string[]) =>
    command(pnpm.executable, [...pnpm.prefix, ...args], root, signal, false, {
      env: pnpmEnv,
    });
  const local = (await run(['--pm-on-fail=ignore', '--version'])).stdout;
  if (local.split('.')[0] !== pnpmVersion.split('.')[0])
    throw new Error(
      `pnpm ${local} cannot reproduce this source. Install pnpm ${pnpmVersion.split('.')[0]} (the platform uses ${pnpmVersion}).`,
    );
  return {
    async install() {
      await run(pnpmFetchArgs());
      await run(pnpmInstallArgs());
    },
    async readManifest(parse: (value: unknown) => { id: string }) {
      if (!(await lstat(join(root, MANIFEST_TSCONFIG)).catch(() => null)))
        throw new Error(
          'The installed SDK has no pnpm toolchain configuration. Upgrade the platform.',
        );
      const tsc = (args: string[]) =>
        run(pnpmDlxArgs(`typescript@${typescriptVersion}`, ['tsc', ...args]));
      // The listing includes type-only imports that a bundler would discard.
      await assertListedFilesInsideRoot(
        (await tsc(tscArgs(MANIFEST_TSCONFIG, true))).stdout,
        root,
      );
      await tsc(tscArgs(MANIFEST_TSCONFIG));
      const temporary = await mkdtemp(
        join(root, '.git', 'hatch-manifest-eval-'),
      );
      let result;
      try {
        const file = (name: string) =>
          relative(root, join(temporary, name)).split(sep).join('/');
        await writeFile(
          join(temporary, 'entry.ts'),
          "import manifest from '../../manifest.ts';\ndeclare const __hatchSerialize: (value: unknown) => void;\n__hatchSerialize(manifest);",
        );
        // The same bundler and options the platform uses in-process. Its
        // source-boundary plugin cannot run here, so the metafile is checked.
        await run(
          pnpmDlxArgs(`esbuild@${esbuildVersion}`, [
            'esbuild',
            ...esbuildManifestCliArgs({
              entry: file('entry.ts'),
              outfile: file('out.js'),
              metafile: file('meta.json'),
              tsconfig: MANIFEST_TSCONFIG,
            }),
          ]),
        );
        const metafile = JSON.parse(
          await readFile(join(temporary, 'meta.json'), 'utf8'),
        ) as BundleMetafile;
        assertNoBundleImports(metafile, 'Manifest bundle');
        await assertBundleInputsInsideRoot(metafile, root);
        const bundled = await readFile(join(temporary, 'out.js'), 'utf8');
        if (Buffer.byteLength(bundled) > 1000000)
          throw new Error('Manifest bundle exceeds its output budget.');
        result = await command(
          process.execPath,
          nodeEvaluationArgs(),
          root,
          signal,
          false,
          { env, input: `${MANIFEST_SERIALIZER}\n${bundled}` },
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      const line = result.stdout
        .split('\n')
        .find((value) => value.startsWith(MANIFEST_RESULT));
      if (!line) throw new Error('Manifest did not produce JSON data.');
      return parse(JSON.parse(line.slice(MANIFEST_RESULT.length)));
    },
  };
}

/**
 * Evaluate the workspace manifest. A source with `pnpm-lock.yaml` needs its
 * dependencies installed first; `tooling` supplies the platform's versions.
 */
export async function readWorkspaceManifest(
  root: string,
  signal: AbortSignal,
  tooling?: ToolingSource,
  options: { installed?: boolean } = {},
) {
  const ts = await lstat(join(root, 'manifest.ts')).catch(() => null);
  const json = await lstat(join(root, 'manifest.json')).catch(() => null);
  if (Boolean(ts) === Boolean(json))
    throw new Error('Keep exactly one manifest.ts or manifest.json.');
  const file = ts ? 'manifest.ts' : 'manifest.json';
  const entry = ts ?? json;
  if (!entry?.isFile() || entry.isSymbolicLink())
    throw new Error('Manifest must be a regular file.');
  const parse = (value: unknown) => sourceManifestSchema.parse(value);
  if (json) return parse(JSON.parse(await readFile(join(root, file), 'utf8')));
  const env = await trustedEnv(root);
  if ((await detectSourceToolchain(sourceToolchainReader(root))) === 'node') {
    if (!options.installed) await validateNodeDependencySource(root);
    return withEmptyConfigHome(async (configHome) => {
      const node = await nodeToolchain(root, signal, env, tooling, configHome);
      if (!options.installed) await node.install();
      return node.readManifest(parse);
    });
  }
  const flags = [
    '--config=deno.json',
    '--no-remote',
    '--node-modules-dir=manual',
    '--import-map=.hatch/import-map.json',
    '--lock=deno.lock',
    '--frozen',
  ];
  const graph = JSON.parse(
    (
      await command(
        'deno',
        ['info', '--json', ...flags, file],
        root,
        signal,
        false,
        { env },
      )
    ).stdout,
  ) as { modules?: { specifier: string; error?: string }[] };
  if (!graph.modules) throw new Error('Manifest dependency graph is missing.');
  for (const module of graph.modules) {
    if (module.error) throw new Error('Manifest dependency graph is invalid.');
    if (module.specifier.startsWith('file:')) {
      if (!inside(root, await realpath(fileURLToPath(module.specifier))))
        throw new Error('Manifest import escapes source root.');
    } else if (!module.specifier.startsWith('npm:'))
      throw new Error('Unsupported manifest import.');
  }
  await command('deno', ['check', ...flags, file], root, signal, false, {
    env,
  });
  // Bundle before evaluating so the trusted serializer captures intrinsics
  // before authored modules run. Evaluation has no source or npm access.
  // Agent SDK generations can be read-only. Evaluation scratch belongs in
  // writable Git metadata, not inside the protected platform-owned SDK.
  const temporary = await mkdtemp(join(root, '.git', 'hatch-manifest-eval-'));
  let result;
  try {
    const entry = join(temporary, 'entry.ts');
    await writeFile(
      entry,
      "import manifest from '../../manifest.ts';\ndeclare const __hatchSerialize: (value: unknown) => void;\n__hatchSerialize(manifest);",
    );
    const bundled = await command(
      'deno',
      ['bundle', ...flags, '--platform=deno', entry],
      root,
      signal,
      false,
      { env },
    );
    if (Buffer.byteLength(bundled.stdout) > 1000000)
      throw new Error('Manifest bundle exceeds its output budget.');
    result = await command(
      'deno',
      [
        'run',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        '--no-prompt',
        '-',
      ],
      root,
      signal,
      false,
      { env, input: `${MANIFEST_SERIALIZER}\n${bundled.stdout}` },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const line = result.stdout
    .split('\n')
    .find((value) => value.startsWith(MANIFEST_RESULT));
  if (!line) throw new Error('Manifest did not produce JSON data.');
  return parse(JSON.parse(line.slice(MANIFEST_RESULT.length)));
}
/** What `.git/info/exclude` gains in a native App's checkout. */
const NATIVE_EXCLUDES = ['/nsh.json', '/app/tsconfig.json', '.nsh/'];

/**
 * A native App's checkout gets the NSH configuration a deploy generates, so
 * `nsh check`, `nsh test` and `nsh build` run from the App root: the root
 * `nsh.json` (the delivered base plus the App's name, id and entry) and
 * `app/tsconfig.json`. Both are regenerated on every preparation and kept
 * out of Git, also in an App whose `.gitignore` predates the native runtime.
 */
export async function writeNativeConfig(
  root: string,
  app: { id: string; name: string; entry: string },
) {
  const delivered = async (file: string) => {
    try {
      return await readFile(join(root, '.hatch', ...file.split('/')), 'utf8');
    } catch {
      throw new Error(
        `The platform SDK has no ${file}; update the platform or the hatch CLI.`,
      );
    }
  };
  const base = JSON.parse(await delivered(NATIVE_NSH_BASE_FILE)) as Record<
    string,
    unknown
  >;
  await writeFile(join(root, 'nsh.json'), composeNativeNshJson(app, base));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(
    join(root, 'app', 'tsconfig.json'),
    await delivered(NATIVE_ENTRY_TSCONFIG_FILE),
  );
  const exclude = join(root, '.git', 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => null);
  if (current === null) return;
  const lines = new Set(current.split('\n'));
  const missing = NATIVE_EXCLUDES.filter((line) => !lines.has(line));
  if (missing.length)
    await writeFile(
      exclude,
      `${current.endsWith('\n') ? current : `${current}\n`}${missing.join('\n')}\n`,
    );
}

export async function prepareApp(
  root: string,
  signal: AbortSignal,
  tooling?: Tooling,
) {
  let stage = 'source preflight';
  try {
    await preflight(root);
    // The committed lockfile selects the toolchain before anything is evaluated.
    const node =
      (await detectSourceToolchain(sourceToolchainReader(root))) === 'node';
    if (node) await validateNodeDependencySource(root);
    else await validateDenoDependencySource(root);
    const env = await trustedEnv(root);
    stage = 'dependency install';
    if (node)
      await withEmptyConfigHome(async (configHome) => {
        await (
          await nodeToolchain(root, signal, env, tooling, configHome)
        ).install();
      });
    else
      await command(
        'deno',
        [
          'install',
          '--no-config',
          '--package-json',
          '--node-modules-dir=auto',
          '--lock=deno.lock',
          '--frozen',
        ],
        root,
        signal,
        false,
        { env },
      );
    stage = 'manifest validation';
    const manifest = await readWorkspaceManifest(root, signal, tooling, {
      installed: true,
    });
    const source = manifest as {
      id: string;
      name?: string;
      app?: { entry: string; runtime?: string };
    };
    if (source.app?.runtime === 'native') {
      stage = 'native configuration';
      await writeNativeConfig(root, {
        id: source.id,
        name: source.name ?? source.id,
        entry: source.app.entry,
      });
    }
    stage = 'Connect codegen';
    if ('rpc' in manifest && manifest.rpc) {
      if (!tooling) throw new Error('Platform codegen versions are missing.');
      const pnpm = await pnpmInvocation(process.platform, env);
      // Only platform-pinned tools, using platform-authored configuration.
      await command(
        pnpm.executable,
        [
          ...pnpm.prefix,
          'dlx',
          '--allow-build',
          '@bufbuild/buf',
          '--package',
          `@bufbuild/buf@${tooling.bufVersion}`,
          '--package',
          `@bufbuild/protoc-gen-es@${tooling.protocGenEsVersion}`,
          'buf',
          'generate',
          '--template',
          '.hatch/buf.gen.yaml',
        ],
        root,
        signal,
        false,
        { env },
      );
    } else {
      await rm(join(root, 'gen'), { recursive: true, force: true });
      await mkdir(join(root, 'gen'));
    }
  } catch (error) {
    const detail =
      error instanceof CliError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Invalid source.';
    throw preparationFailure(
      'app_preparation_failed',
      `App preparation failed during ${stage}: ${detail}`,
      error,
      signal,
    );
  }
}
