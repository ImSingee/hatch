/**
 * Node build pipeline: pnpm install, `tsc` type check, esbuild bundles and
 * zero-grant `node --permission` evaluation. It runs no `deno` command; the
 * bundles it writes still run on Deno under the `bundle-v1` runtime flags.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { build, type BuildFailure } from 'esbuild';
import { sdkEntryTsconfig } from '../../sdk-internal/definitions';
import { APP_HATCH_SDK_IMPORTS } from '../agent/hatch-sdk-paths';
import { validateNodeDependencySource } from '../node-dependencies';
import {
  NODE_EVALUATION_CONDITIONS,
  assertListedFilesInsideRoot,
  assertRuntimeBundleImports,
  nodeEvaluationArgs,
  pnpmFetchArgs,
  pnpmInstallArgs,
  tscArgs,
  withEmptyConfigHome,
} from '../node-toolchain-commands';
import {
  bundleEvaluationModule,
  loadSourceManifest,
  readManifestFile,
} from '../source-manifest';
import {
  PNPM_LOCKFILE,
  type SourceToolchain,
  type SourceToolchainContext,
  type ToolchainCommand,
  type ToolchainRunResult,
} from '../source-toolchain';
import { DATA_SCHEMA_SENTINEL, dataSchemaFromOutput } from './data-schema';
import {
  hatchSdkPlugin,
  nodeBuiltinsPlugin,
  sourceBoundaryPlugin,
} from './esbuild-plugins';

const OUTPUT_LIMIT = 1_000_000;
const MANIFEST_TSCONFIG = '.hatch/tsconfig.manifest.json';
const CHECK_TSCONFIG = '.hatch/tsconfig.check.json';
const FETCH_CONTRACT = '.hatch/backend-fetch-contract.ts';

/**
 * CommonJS dependencies call `require` and read `__dirname`; an ES module has
 * neither. Deno and Node both provide them through `node:module`.
 */
const RUNTIME_BUNDLE_BANNER = [
  "import { createRequire as __hatchCreateRequire } from 'node:module';",
  "import { fileURLToPath as __hatchFileURLToPath } from 'node:url';",
  "import { dirname as __hatchDirname } from 'node:path';",
  'const require = __hatchCreateRequire(import.meta.url);',
  'const __filename = __hatchFileURLToPath(import.meta.url);',
  'const __dirname = __hatchDirname(__filename);',
].join('\n');

function commandLine(command: Pick<ToolchainCommand, 'tool' | 'args'>): string {
  return `$ ${command.tool} ${command.args.join(' ')}`;
}

export function createNodeToolchain(
  context: SourceToolchainContext,
): SourceToolchain {
  const { root, logs } = context;
  const read = context.read ?? ((file) => readManifestFile(root, file));

  /** Run a command, log it, and return its result; the caller judges it. */
  async function run(
    command: ToolchainCommand,
    options: { log?: boolean } = {},
  ): Promise<ToolchainRunResult> {
    const result = await context.run(command);
    if (
      result.stdout.length > OUTPUT_LIMIT ||
      result.stderr.length > OUTPUT_LIMIT
    ) {
      throw new Error(`${command.tool} output exceeded the 1 MB limit.`);
    }
    if (options.log !== false) {
      logs?.push(`${commandLine(command)}\n${result.output.trim()}`);
    }
    return result;
  }

  /** Check the program a tsconfig describes never leaves the source root. */
  async function assertProgramInsideRoot(
    project: string,
    step: ToolchainCommand['step'],
  ): Promise<void> {
    const listing = await run(
      { tool: 'tsc', args: tscArgs(project, true), step },
      { log: false },
    );
    if (listing.code !== 0) {
      throw new Error(listing.output || 'module listing failed');
    }
    await assertListedFilesInsideRoot(listing.stdout, root);
  }

  /** Evaluate a self-contained module from stdin with no permission grants. */
  async function evaluate(
    input: string,
    step: ToolchainCommand['step'],
  ): Promise<ToolchainRunResult> {
    return run({
      tool: 'node',
      args: nodeEvaluationArgs(),
      step,
      input,
      timeoutMs: context.evaluationTimeoutMs ?? 30_000,
    });
  }

  return {
    name: 'node',

    async validateDependencies() {
      await validateNodeDependencySource(
        root,
        context.readDependenciesThroughReader ? read : undefined,
      );
    },

    async install() {
      const store = { storeDir: context.pnpmStoreDir };
      await withEmptyConfigHome(async (configHome) => {
        // Download first, then link with the network unused: once builds run
        // in an OS sandbox, the second step can lose network access entirely.
        for (const args of [pnpmFetchArgs(store), pnpmInstallArgs(store)]) {
          const result = await run({
            tool: 'pnpm',
            args,
            step: 'install',
            env: { XDG_CONFIG_HOME: configHome },
          });
          if (result.code !== 0) {
            throw new Error(
              `Dependency install failed with the committed ${PNPM_LOCKFILE}. ` +
                'Load the "building-apps" Skill, run pnpm install locally, commit ' +
                'the updated dependency files, and deploy again:\n' +
                result.output,
            );
          }
        }
      });
    },

    evaluateManifest(parse) {
      return loadSourceManifest(root, {
        parse,
        read,
        steps: {
          conditions: NODE_EVALUATION_CONDITIONS,
          jsxImportSource: 'react',
          graph: () => assertProgramInsideRoot(MANIFEST_TSCONFIG, 'manifest'),
          async check() {
            const checked = await run({
              tool: 'tsc',
              args: tscArgs(MANIFEST_TSCONFIG),
              step: 'manifest',
            });
            if (checked.code !== 0) {
              throw new Error(checked.output || 'manifest type check failed');
            }
          },
          async evaluate(input) {
            const evaluated = await evaluate(input, 'manifest');
            if (evaluated.code !== 0) {
              throw new Error(evaluated.output || 'manifest evaluation failed');
            }
            return evaluated.stdout;
          },
        },
      });
    },

    async check({ entries, fetchContract }) {
      const files = entries.map((entry) => `../${entry}`);
      if (fetchContract) {
        // The runtime is Deno: a deno-serve backend default-exports the
        // handler object `deno serve` loads.
        await fs.writeFile(
          path.join(root, FETCH_CONTRACT),
          `import backend from ${JSON.stringify(`../${fetchContract}`)};\n\n` +
            'const fetchHandler: Deno.ServeDefaultExport = backend;\n' +
            'void fetchHandler;\n',
          'utf8',
        );
        files.push(`./${path.posix.basename(FETCH_CONTRACT)}`);
      }
      await fs.writeFile(
        path.join(root, CHECK_TSCONFIG),
        sdkEntryTsconfig(files),
        'utf8',
      );
      const checked = await run({
        tool: 'tsc',
        args: tscArgs(CHECK_TSCONFIG),
        step: 'check',
      });
      if (checked.code !== 0) {
        const contractMessage =
          fetchContract &&
          checked.output.includes(path.posix.basename(FETCH_CONTRACT))
            ? ' deno-serve backends must default-export ' +
              'a Deno.ServeDefaultExport.'
            : '';
        throw new Error(
          `Source validation failed during tsc.${contractMessage}\n` +
            checked.output,
        );
      }
      try {
        await assertProgramInsideRoot(CHECK_TSCONFIG, 'check');
      } catch (error) {
        throw new Error(
          `Source validation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    },

    async describe() {
      let result: ToolchainRunResult;
      try {
        const source = await bundleEvaluationModule({
          root: await fs.realpath(root),
          read,
          contents:
            `import schema from './data/schema.ts';\n` +
            `console.log(${JSON.stringify(DATA_SCHEMA_SENTINEL)} + JSON.stringify(schema.descriptor));\n`,
          conditions: NODE_EVALUATION_CONDITIONS,
          jsxImportSource: 'react',
          subject: 'schema',
        });
        result = await evaluate(`${source}\n`, 'describe');
      } catch (error) {
        throw new Error(
          `Data Table schema evaluation failed:\n${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      if (result.code !== 0) {
        throw new Error(
          `Data Table schema evaluation failed:\n${result.output}`,
        );
      }
      return dataSchemaFromOutput(result.stdout);
    },

    async bundle({ entry, outfile }) {
      const canonicalRoot = await fs.realpath(root);
      let metafile;
      try {
        ({ metafile } = await build({
          absWorkingDir: root,
          entryPoints: [entry],
          outfile,
          bundle: true,
          format: 'esm',
          // Node resolution plus the `deno` export condition: packages pick
          // their Deno build where they ship one, and their Node build runs
          // on Deno's Node compatibility layer otherwise.
          platform: 'node',
          conditions: ['deno'],
          mainFields: ['module', 'main'],
          target: 'es2022',
          banner: { js: RUNTIME_BUNDLE_BANNER },
          // Never read a tsconfig from the source or from a directory above it.
          tsconfigRaw: {
            compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' },
          },
          logLevel: 'silent',
          metafile: true,
          plugins: [
            hatchSdkPlugin(root, APP_HATCH_SDK_IMPORTS),
            nodeBuiltinsPlugin(),
            sourceBoundaryPlugin(canonicalRoot, 'Backend', 'source root'),
          ],
        }));
        assertRuntimeBundleImports(metafile);
      } catch (error) {
        const failure = error as Partial<BuildFailure>;
        const detail = failure.errors?.length
          ? failure.errors
              .map((item) =>
                item.location
                  ? `${item.location.file}:${item.location.line}:${item.location.column}: ${item.text}`
                  : item.text,
              )
              .join('\n')
          : error instanceof Error
            ? error.message
            : String(error);
        throw new Error(`Backend bundle failed:\n${detail}`, { cause: error });
      }
      logs?.push(
        `$ esbuild ${entry} --bundle --format=esm --platform=node --conditions=deno`,
      );
    },
  };
}
