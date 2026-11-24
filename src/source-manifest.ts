/** Load authored App configuration without executing it in the host. */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { APP_HATCH_SDK_IMPORTS, hatchImportMapPath } from './agent/hatch-sdk';
import { subprocessSandboxEnv } from './server/sandbox-env';
import { run, type RunOptions, type RunResult } from './server/subprocess';

export type ManifestFile = 'manifest.ts' | 'manifest.json';
export type ManifestRunner = (
  args: string[],
  options: { input?: string; timeoutMs?: number },
) => Promise<RunResult>;
export type ManifestReader = (file: string) => Promise<string | null>;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Read only a regular file reached through real directories inside the root. */
export async function readManifestFile(
  root: string,
  file: string,
): Promise<string | null> {
  if (!inside(path.resolve(root), path.resolve(root, file)))
    throw new Error(`Source path escapes its root: ${file}`);
  const parts = file.split(/[\\/]/);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await fs
      .lstat(current)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!info) return null;
    if (info.isSymbolicLink())
      throw new Error(`Source must not contain symbolic links: ${file}`);
  }
  const handle = await fs.open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`${file} must be a regular file.`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function detectSourceManifest(
  root: string,
  reader: ManifestReader = (file) => readManifestFile(root, file),
): Promise<ManifestFile> {
  const ts = await reader('manifest.ts');
  const json = await reader('manifest.json');
  if (ts !== null && json !== null)
    throw new Error(
      'Keep exactly one source manifest: manifest.ts or manifest.json, not both.',
    );
  if (ts === null && json === null)
    throw new Error('Source must contain manifest.ts or manifest.json.');
  return ts === null ? 'manifest.json' : 'manifest.ts';
}

export function manifestRunner(
  root: string,
  options: Omit<RunOptions, 'cwd'> = {},
): ManifestRunner {
  return (args, extra) =>
    run('deno', args, {
      ...options,
      cwd: root,
      env: options.env ?? subprocessSandboxEnv(),
      ...extra,
    });
}

import {
  MANIFEST_RESULT as RESULT,
  MANIFEST_SERIALIZER as SERIALIZER,
} from './manifest-evaluation';

function manifestBundleBoundary(
  root: string,
  read: ManifestReader,
  subject: string,
): Plugin {
  const imports = APP_HATCH_SDK_IMPORTS;
  const escapes = `${subject[0].toUpperCase()}${subject.slice(1)} import escapes source root`;
  return {
    name: 'manifest-source-boundary',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === 'resolved') return;
        const sdk = (imports as Record<string, string>)[args.path];
        const specifier = sdk ? path.resolve(root, '.hatch', sdk) : args.path;
        if (
          !sdk &&
          (/^[a-z][a-z\d+.-]*:/i.test(specifier) ||
            specifier.startsWith('@hatch/'))
        ) {
          throw new Error(`Unsupported ${subject} import: ${args.path}`);
        }
        const resolved = await plugin.resolve(specifier, {
          kind: args.kind,
          resolveDir: args.resolveDir || root,
          pluginData: 'resolved',
        });
        if (resolved.errors.length) return resolved;
        if (resolved.external || !inside(root, resolved.path))
          throw new Error(`${escapes}: ${args.path}`);
        const canonical = await fs.realpath(resolved.path);
        if (!inside(root, canonical))
          throw new Error(`${escapes}: ${args.path}`);
        return { path: canonical };
      });
      plugin.onLoad({ filter: /\.[cm]?[jt]sx?$|\.json$/ }, async (args) => {
        if (!inside(root, args.path))
          throw new Error(`${escapes}: ${args.path}`);
        const contents = await read(
          path.relative(root, args.path).split(path.sep).join('/'),
        );
        if (contents === null)
          throw new Error(`Missing ${subject} module: ${args.path}`);
        const extension = path.extname(args.path);
        const loader =
          extension === '.json'
            ? 'json'
            : extension.endsWith('x')
              ? extension === '.tsx'
                ? 'tsx'
                : 'jsx'
              : /\.([cm]?ts)$/.test(extension)
                ? 'ts'
                : 'js';
        return { contents, loader, resolveDir: path.dirname(args.path) };
      });
    },
  };
}

/**
 * Bundle a trusted evaluator entry and everything it imports into one module
 * with no imports left. Authored files are read through `read`, and every
 * resolved module must stay inside the source root.
 */
export async function bundleEvaluationModule(options: {
  /** Canonical source root. */
  root: string;
  read: ManifestReader;
  /** Trusted entry that imports the authored module. */
  contents: string;
  /** Resolution conditions of the runtime that evaluates the bundle. */
  conditions: string[];
  /**
   * Package whose automatic JSX runtime the bundle uses, matching the
   * toolchain's type check. Omitted, JSX compiles to `React.createElement`.
   */
  jsxImportSource?: string;
  /** Lower-case noun used in error messages, e.g. `manifest`. */
  subject: string;
}): Promise<string> {
  const label = `${options.subject[0].toUpperCase()}${options.subject.slice(1)}`;
  const bundled = await build({
    absWorkingDir: options.root,
    stdin: {
      contents: options.contents,
      resolveDir: options.root,
      sourcefile: `${options.subject}-evaluator.js`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: options.conditions,
    target: 'esnext',
    tsconfigRaw: {},
    ...(options.jsxImportSource
      ? { jsx: 'automatic', jsxImportSource: options.jsxImportSource }
      : {}),
    logLevel: 'silent',
    metafile: true,
    plugins: [
      manifestBundleBoundary(options.root, options.read, options.subject),
    ],
  });
  if (
    Object.values(bundled.metafile.outputs).some(
      (output) => output.imports.length,
    )
  )
    throw new Error(`${label} bundle must not contain external imports.`);
  const source = bundled.outputFiles[0]?.text;
  if (!source) throw new Error(`${label} bundle is empty.`);
  return source;
}

/**
 * The toolchain-specific half of manifest evaluation. Bundling is shared; a
 * toolchain supplies the import-graph check, the type check and the process
 * that evaluates the bundle without host access.
 */
export type ManifestEvaluationSteps = {
  /** Resolution conditions of the runtime that evaluates the bundle. */
  conditions: string[];
  /**
   * Package whose automatic JSX runtime the bundle uses, matching the
   * toolchain's type check. Omitted, JSX compiles to `React.createElement`.
   */
  jsxImportSource?: string;
  /** Verify the full import graph, including type-only imports. */
  graph(file: ManifestFile): Promise<void>;
  check(file: ManifestFile): Promise<void>;
  /** Evaluate the serializer plus bundle read from stdin; return stdout. */
  evaluate(input: string): Promise<string>;
};

function denoManifestSteps(options: {
  root: string;
  canonicalRoot: string;
  execute: ManifestRunner;
  logs?: string[];
  evaluationTimeoutMs?: number;
}): ManifestEvaluationSteps {
  const { root, canonicalRoot, execute } = options;
  const invoke = async (
    args: string[],
    extra: { input?: string; timeoutMs?: number } = {},
  ) => {
    const result = await execute(args, extra);
    if (result.stdout.length > 1_000_000 || result.stderr.length > 1_000_000)
      throw new Error('Manifest command output exceeded the 1 MB limit.');
    if (args[0] !== 'info')
      options.logs?.push(`$ deno ${args.join(' ')}\n${result.output.trim()}`);
    if (result.code !== 0)
      throw new Error(result.output || 'manifest command failed');
    return result;
  };
  const flags = [
    '--config=deno.json',
    '--no-remote',
    '--node-modules-dir=manual',
    `--import-map=${hatchImportMapPath(root)}`,
    '--lock=deno.lock',
    '--frozen',
  ];
  return {
    conditions: ['deno', 'import', 'default'],
    async graph(file) {
      // The graph includes type-only imports that a JS bundler would discard.
      const graph = await invoke(['info', '--json', ...flags, file]);
      const info = JSON.parse(graph.stdout) as {
        modules?: { specifier: string; error?: string }[];
      };
      if (!info.modules)
        throw new Error('Manifest dependency graph is missing.');
      for (const module of info.modules) {
        if (module.specifier.startsWith('file:')) {
          const target = fileURLToPath(module.specifier);
          if (
            !inside(path.resolve(root), target) &&
            !inside(canonicalRoot, target)
          )
            throw new Error(
              `Manifest import escapes source root: ${module.specifier}`,
            );
          if (!inside(canonicalRoot, await fs.realpath(target)))
            throw new Error(
              `Manifest import escapes source root: ${module.specifier}`,
            );
        } else if (!module.specifier.startsWith('npm:')) {
          throw new Error(`Unsupported manifest import: ${module.specifier}`);
        }
        if (module.error) throw new Error(module.error);
      }
    },
    async check(file) {
      await invoke(['check', ...flags, file]);
    },
    async evaluate(input) {
      const evaluated = await invoke(
        [
          'run',
          '--no-config',
          '--no-lock',
          '--no-npm',
          '--no-remote',
          '--no-prompt',
          '-',
        ],
        { input, timeoutMs: options.evaluationTimeoutMs ?? 30_000 },
      );
      return evaluated.stdout;
    },
  };
}

export async function loadSourceManifest<T>(
  root: string,
  options: {
    parse: (raw: unknown) => T;
    run?: ManifestRunner;
    read?: ManifestReader;
    logs?: string[];
    evaluationTimeoutMs?: number;
    /** Defaults to the Deno toolchain driven through `run`. */
    steps?: ManifestEvaluationSteps;
  },
): Promise<{ manifest: T; file: ManifestFile }> {
  const reader = options.read ?? ((file) => readManifestFile(root, file));
  const file = await detectSourceManifest(root, reader);
  try {
    if (file === 'manifest.json') {
      return {
        file,
        manifest: options.parse(JSON.parse((await reader(file))!)),
      };
    }
    const canonicalRoot = await fs.realpath(root);
    const steps =
      options.steps ??
      denoManifestSteps({
        root,
        canonicalRoot,
        execute: options.run ?? manifestRunner(root),
        logs: options.logs,
        evaluationTimeoutMs: options.evaluationTimeoutMs,
      });
    await steps.graph(file);
    const source = await bundleEvaluationModule({
      root: canonicalRoot,
      read: reader,
      contents: `import manifest from './manifest.ts';\n__hatchSerialize(manifest);`,
      conditions: steps.conditions,
      jsxImportSource: steps.jsxImportSource,
      subject: 'manifest',
    });
    await steps.check(file);
    const stdout = await steps.evaluate(`${SERIALIZER}\n${source}\n`);
    const records = stdout
      .split('\n')
      .filter((line) => line.startsWith(RESULT));
    if (records.length !== 1)
      throw new Error('Manifest evaluation must emit exactly one result.');
    return {
      file,
      manifest: options.parse(JSON.parse(records[0].slice(RESULT.length))),
    };
  } catch (error) {
    throw new Error(
      `${file} validation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
