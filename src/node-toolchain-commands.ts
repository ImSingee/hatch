/**
 * Fixed command lines and output checks of the Node build toolchain.
 *
 * The platform, the Agent Runner and the CLI must accept the same lockfile
 * bytes and evaluate the same manifest, so they all build their pnpm, tsc and
 * Node invocations here. This file has no server imports.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';

export type PnpmStoreOptions = {
  /** Shared content-addressable store; pnpm's default when omitted. */
  storeDir?: string;
};

/**
 * Arguments that stop pnpm from reading anything the source controls except
 * `package.json` and `pnpm-lock.yaml`:
 *
 * - `--ignore-workspace` skips `pnpm-workspace.yaml` in the source root and in
 *   every directory above it, and with it every pnpm setting the file carries.
 * - `--ignore-pnpmfile` skips install hooks.
 * - `--pm-on-fail=ignore` never downloads another pnpm version.
 * - `--registry` and `--npmrc-auth-file` fix where packages come from; the
 *   user-level npmrc would otherwise add scoped registries and tokens.
 * - The layout settings keep every `node_modules` link inside the source root
 *   and copy files, so sources never share an inode with the store.
 *
 * A project-level `.npmrc` and runtime entries are not covered by arguments;
 * `validateNodeDependencySource` rejects them.
 */
function pnpmHermeticArgs({ storeDir }: PnpmStoreOptions): string[] {
  return [
    '--ignore-workspace',
    '--ignore-pnpmfile',
    '--pm-on-fail=ignore',
    '--registry',
    NPM_REGISTRY,
    '--npmrc-auth-file',
    os.devNull,
    '--config.nodeLinker=isolated',
    '--config.enableGlobalVirtualStore=false',
    '--config.packageImportMethod=copy',
    ...(storeDir ? ['--store-dir', storeDir] : []),
    '--no-progress',
  ];
}

/** Network step: download the locked packages into the store. */
export function pnpmFetchArgs(options: PnpmStoreOptions = {}): string[] {
  return [
    'fetch',
    ...pnpmHermeticArgs(options),
    // `fetch` has no --ignore-scripts; without these it fails on any locked
    // package that declares a build script.
    '--config.strictDepBuilds=false',
    '--config.ignoreScripts=true',
  ];
}

/**
 * Offline step: link `node_modules` from the store. `--trust-lockfile` skips
 * pnpm's time-dependent release-age policy, which would let the same lockfile
 * pass at one site and fail at another; integrity is still verified.
 */
export function pnpmInstallArgs(options: PnpmStoreOptions = {}): string[] {
  return [
    'install',
    ...pnpmHermeticArgs(options),
    '--offline',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--no-runtime',
    '--trust-lockfile',
  ];
}

/** Run a platform-pinned tool that the host does not ship (CLI only). */
export function pnpmDlxArgs(spec: string, command: string[]): string[] {
  return [
    '--ignore-workspace',
    '--pm-on-fail=ignore',
    '--registry',
    NPM_REGISTRY,
    '--npmrc-auth-file',
    os.devNull,
    '--config.ignoreScripts=true',
    '--reporter=silent',
    'dlx',
    '--package',
    spec,
    ...command,
  ];
}

/**
 * Run with an empty directory to use as `XDG_CONFIG_HOME`, which is where
 * pnpm looks for its global config and auth files. The directory is readable
 * by a sandbox user but only writable by this process.
 */
export async function withEmptyConfigHome<T>(
  run: (configHome: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hatch-pnpm-config-'),
  );
  try {
    await fs.chmod(directory, 0o755);
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Node arguments that evaluate a module read from stdin with no permission
 * grants: no file system, network, child process, worker, addon or WASI
 * access. Node denies network only from the version that has an
 * `--allow-net` flag to withhold; an older one is refused, because evaluated
 * code that can both signal a Node process and reach its inspector over the
 * loopback interface runs arbitrary code in that process.
 */
export function nodeEvaluationArgs(
  flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): string[] {
  if (!flags.has('--permission') || !flags.has('--allow-net')) {
    throw new Error(
      `Node.js ${process.versions.node} cannot evaluate source without ` +
        'host and network access. Use Node.js 26 or later.',
    );
  }
  return ['--permission', '--input-type=module', '-'];
}

export function tscArgs(project: string, listFilesOnly = false): string[] {
  return [
    '-p',
    project,
    '--pretty',
    'false',
    ...(listFilesOnly ? ['--listFilesOnly'] : []),
  ];
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Check a `tsc --listFilesOnly` listing: every file of the program must live
 * in the source root. The compiler's own `lib.*.d.ts` files are the single
 * exception, and they all sit in one directory. This catches type-only
 * imports, which a bundler drops, and packages resolved from a directory
 * above the source root.
 */
export async function assertListedFilesInsideRoot(
  listing: string,
  root: string,
): Promise<void> {
  const canonicalRoot = await fs.realpath(root);
  const libraryDirectories = new Set<string>();
  for (const line of listing.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    if (!path.isAbsolute(file)) {
      throw new Error(`Unexpected module listing entry: ${file}`);
    }
    const canonical = await fs.realpath(file);
    if (inside(canonicalRoot, canonical)) continue;
    if (!/^lib\.[a-z0-9.]+\.d\.ts$/.test(path.basename(canonical))) {
      throw new Error(`Import escapes source root: ${file}`);
    }
    libraryDirectories.add(path.dirname(canonical));
  }
  if (libraryDirectories.size > 1) {
    throw new Error(
      `Import escapes source root: ${[...libraryDirectories].join(', ')}`,
    );
  }
}

export type BundleMetafile = {
  inputs: Record<string, unknown>;
  outputs: Record<
    string,
    { imports: { path: string; kind: string; external?: boolean }[] }
  >;
};

function bundleImports(metafile: BundleMetafile) {
  return Object.values(metafile.outputs).flatMap((output) => output.imports);
}

/** A manifest, schema or browser bundle must be fully self-contained. */
export function assertNoBundleImports(
  metafile: BundleMetafile,
  subject: string,
): void {
  const [first] = bundleImports(metafile);
  if (first) {
    throw new Error(
      `${subject} must not contain external imports: "${first.path}". ` +
        'Remote and runtime-provided modules are not supported; declare npm ' +
        'dependencies in package.json.',
    );
  }
}

const OPTIONAL_REQUIRE = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(?:\/.*)?$/;

/**
 * A runtime bundle may leave only Node built-ins unresolved. The one other
 * shape is a `require()` of a package that was not installed, which esbuild
 * keeps only when it sits in a `try` block (optional native accelerators such
 * as `pg-native`); it fails at run time exactly as it would unbundled.
 */
export function assertRuntimeBundleImports(metafile: BundleMetafile): void {
  for (const item of bundleImports(metafile)) {
    if (item.path.startsWith('node:')) continue;
    if (item.kind === 'require-call' && OPTIONAL_REQUIRE.test(item.path)) {
      continue;
    }
    throw new Error(
      `Bundle left "${item.path}" unresolved. Only Node built-in modules may ` +
        'stay external; declare npm dependencies in package.json.',
    );
  }
}

/** Every bundled file must resolve inside the source root (CLI check). */
export async function assertBundleInputsInsideRoot(
  metafile: BundleMetafile,
  root: string,
): Promise<void> {
  const canonicalRoot = await fs.realpath(root);
  for (const input of Object.keys(metafile.inputs)) {
    // esbuild prefixes plugin namespaces; plain files are relative paths.
    if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[A-Za-z]:[\\/]/.test(input)) {
      throw new Error(`Unsupported manifest import: ${input}`);
    }
    const canonical = await fs.realpath(path.resolve(canonicalRoot, input));
    if (!inside(canonicalRoot, canonical)) {
      throw new Error(`Manifest import escapes source root: ${input}`);
    }
  }
}

/**
 * Custom resolution condition of a bundle that Node evaluates. esbuild adds
 * `import` or `require` itself according to how each module is loaded;
 * listing `import` here would also apply it to `require()` calls.
 */
export const NODE_EVALUATION_CONDITIONS = ['node'];

/** esbuild command line equivalent of the in-process manifest bundle. */
export function esbuildManifestCliArgs(options: {
  entry: string;
  outfile: string;
  metafile: string;
  tsconfig: string;
}): string[] {
  return [
    options.entry,
    '--bundle',
    '--format=esm',
    '--platform=neutral',
    '--main-fields=module,main',
    `--conditions=${NODE_EVALUATION_CONDITIONS.join(',')}`,
    '--target=esnext',
    `--tsconfig=${options.tsconfig}`,
    '--log-level=error',
    `--metafile=${options.metafile}`,
    `--outfile=${options.outfile}`,
  ];
}
