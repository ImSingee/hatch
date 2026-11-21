/**
 * Deno build pipeline: the commands Hatch ran before toolchains existed, kept
 * argument for argument behind `SourceToolchain`. Sources with `deno.json` and
 * `deno.lock` build exactly as they always did.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hatchImportMapPath } from '../agent/hatch-sdk';
import {
  validateDenoDependencySource,
  type DenoDependencySourceFile,
} from '../deno-dependencies';
import { loadSourceManifest } from '../source-manifest';
import type {
  SourceToolchain,
  SourceToolchainContext,
  ToolchainStep,
} from '../source-toolchain';
import { DATA_SCHEMA_SENTINEL, dataSchemaFromOutput } from './data-schema';

export function createDenoToolchain(
  context: SourceToolchainContext,
): SourceToolchain {
  const { root, kind, logs } = context;
  const deno = (
    step: ToolchainStep,
    args: string[],
    extra: { cwd?: string; input?: string; timeoutMs?: number } = {},
  ) => context.run({ tool: 'deno', args, step, ...extra });

  return {
    name: 'deno',

    async validateDependencies() {
      const read = context.read;
      await validateDenoDependencySource(
        root,
        kind,
        context.readDependenciesThroughReader && read
          ? (file: DenoDependencySourceFile) => read(file)
          : undefined,
      );
    },

    async install() {
      if (kind === 'app') {
        // Reproduce the Agent-reviewed dependency install from the committed
        // package.json + deno.lock. `--no-config` prevents Deno from implicitly
        // executing source-controlled lifecycle policy. App deploys never run
        // npm preinstall/install/postinstall code inside the platform process.
        const installArgs = [
          'install',
          '--no-config',
          '--package-json',
          '--node-modules-dir=auto',
          '--lock=deno.lock',
          '--frozen',
        ];
        const install = await deno('install', installArgs);
        logs?.push(`$ deno ${installArgs.join(' ')}\n${install.output.trim()}`);
        if (install.code !== 0) {
          throw new Error(
            'Dependency install failed with the committed deno.lock. Load the ' +
              '"building-apps" Skill, run deno install locally, commit the updated ' +
              `dependency files, and deploy again:\n${install.output}`,
          );
        }
        return;
      }
      // Reproduce the source-controlled dependency graph. Deno reads reviewed
      // allowScripts entries from deno.json; --frozen rejects uncommitted
      // changes.
      const installArgs = [
        'install',
        '--package-json',
        '--node-modules-dir=auto',
        '--lock=deno.lock',
        '--frozen',
      ];
      const install = await deno('install', installArgs);
      logs?.push(
        `$ deno ${installArgs.join(' ')}\n${(
          install.stderr || install.stdout
        ).trim()}`,
      );
      if (install.code !== 0) {
        throw new Error(
          'Workflow dependency install failed with the committed deno.lock. ' +
            'Load the "building-workflows" Skill, run deno install locally, ' +
            `commit the updated dependency files, and deploy again:\n${
              install.stderr || install.stdout
            }`,
        );
      }
    },

    evaluateManifest(parse) {
      return loadSourceManifest(root, {
        kind,
        parse,
        read: context.read,
        logs,
        evaluationTimeoutMs: context.evaluationTimeoutMs,
        run: (args, extra) =>
          context.run({ tool: 'deno', args, step: 'manifest', ...extra }),
      });
    },

    async check({ entries, fetchContract }) {
      if (kind === 'workflow') {
        const checkArgs = [
          'check',
          '--config=deno.json',
          '--node-modules-dir=auto',
          `--import-map=${hatchImportMapPath(root)}`,
          '--lock=deno.lock',
          '--frozen',
          ...entries.map((entry) => `./${entry}`),
        ];
        const checked = await deno('check', checkArgs);
        logs?.push(`$ deno ${checkArgs.join(' ')}\n${checked.output.trim()}`);
        if (checked.code !== 0) {
          throw new Error(
            `Workflow source validation failed during deno check:\n${checked.output}`,
          );
        }
        return;
      }

      const checkPaths = [...entries];
      const contractEntry = fetchContract
        ? '.hatch/backend-fetch-contract.ts'
        : null;
      if (contractEntry && fetchContract) {
        const backendUrl = pathToFileURL(
          await fs.realpath(path.resolve(root, fetchContract)),
        ).href;
        await fs.writeFile(
          path.join(root, contractEntry),
          '/// <reference lib="deno.ns" />\n' +
            `import backend from ${JSON.stringify(backendUrl)};\n\n` +
            'const fetchHandler: Deno.ServeDefaultExport = backend;\n' +
            'void fetchHandler;\n',
          'utf8',
        );
        checkPaths.push(contractEntry);
      }

      const checkArgs = [
        'check',
        '--config=deno.json',
        '--no-remote',
        '--node-modules-dir=auto',
        `--import-map=${hatchImportMapPath(root)}`,
        '--lock=deno.lock',
        '--frozen',
        ...checkPaths.map((entry) => `./${entry}`),
      ];
      const checked = await deno('check', checkArgs);
      logs?.push(`$ deno ${checkArgs.join(' ')}\n${checked.output.trim()}`);
      if (checked.code !== 0) {
        const contractMessage =
          contractEntry && checked.output.includes(contractEntry)
            ? ' deno-serve backends must default-export ' +
              'a Deno.ServeDefaultExport.'
            : '';
        throw new Error(
          `Source validation failed during deno check.${contractMessage}\n` +
            checked.output,
        );
      }
    },

    async describe() {
      const runner = path.join(root, '.hatch', '__describe_data.ts');
      await fs.writeFile(
        runner,
        `import schema from '../data/schema.ts';\n` +
          `console.log(${JSON.stringify(DATA_SCHEMA_SENTINEL)} + JSON.stringify(schema.descriptor));\n`,
        'utf8',
      );
      const describeArgs = [
        'run',
        '--no-prompt',
        '--config=deno.json',
        '--no-remote',
        '--node-modules-dir=auto',
        `--import-map=${hatchImportMapPath(root)}`,
        '--lock=deno.lock',
        '--frozen',
        `--allow-read=${root}`,
        runner,
      ];
      const result = await deno('describe', describeArgs);
      logs?.push(`$ deno ${describeArgs.join(' ')}\n${result.output.trim()}`);
      if (result.code !== 0) {
        throw new Error(
          `Data Table schema evaluation failed:\n${result.output}`,
        );
      }
      return dataSchemaFromOutput(result.output);
    },

    async bundle({ entry, outfile, outputRoot }) {
      if (kind === 'workflow') {
        const bundleArgs = [
          'bundle',
          '--node-modules-dir=auto',
          '--lock=deno.lock',
          '--frozen',
          '--import-map',
          hatchImportMapPath(root),
          '-o',
          outfile,
          path.join(root, entry),
        ];
        const bundle = await deno('bundle', bundleArgs);
        logs?.push(
          `$ deno ${bundleArgs.join(' ')}\n${(
            bundle.stderr || bundle.stdout
          ).trim()}`,
        );
        if (bundle.code !== 0 || !(await exists(outfile))) {
          throw new Error(
            `Workflow bundle failed:\n${bundle.stderr || bundle.stdout}`,
          );
        }
        return;
      }

      const bundleArgs = [
        'bundle',
        '--config=deno.json',
        '--no-remote',
        '--platform=deno',
        '--packages=bundle',
        '--node-modules-dir=auto',
        `--import-map=${hatchImportMapPath(root)}`,
        '--lock=deno.lock',
        '--frozen',
        '-o',
        outfile,
        entry,
      ];
      const bundle = await deno('bundle', bundleArgs);
      logs?.push(`$ deno ${bundleArgs.join(' ')}\n${bundle.output.trim()}`);
      if (bundle.code !== 0 || !(await exists(outfile))) {
        throw new Error(`Backend bundle failed:\n${bundle.output}`);
      }

      const checkArgs = [
        'check',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        outfile,
      ];
      const checked = await deno('bundle', checkArgs, { cwd: outputRoot });
      logs?.push(`$ deno ${checkArgs.join(' ')}\n${checked.output.trim()}`);
      if (checked.code !== 0) {
        throw new Error(`Backend bundle validation failed:\n${checked.output}`);
      }
    },
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
