/** Server-only: compile a workflow source tree into a single-file program. */
import {
  detectSourceManifest,
  loadSourceManifest,
} from '../../source-manifest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { materializeWorkflowHatchSdk } from '~agent/hatch-sdk';
import { WORKFLOW_BUILD_WORK_DIR } from '~agent/paths';
import { NODE_TOOLCHAIN_IGNORED_ROOT_FILE } from '../../app-managed-path';
import {
  detectSourceToolchain,
  sourceToolchainReader,
} from '../../source-toolchain';
import { createSourceToolchain } from '../../toolchain';
import { platformToolchainContext } from '../../toolchain/platform';
import { assertDenoPermissionFlags } from '../deno-permissions';
import { run } from '../subprocess';
import {
  type NormalizedWorkflowManifest,
  type SourceWorkflowManifest,
  normalizeWorkflowManifest,
  parseSourceWorkflowManifest,
} from './manifest';
import { buildWorkflowDenoArgs } from './runtime-permissions';
import { workflowSandboxEnv } from './sandbox-env';

export type WorkflowBuildResult = {
  source: SourceWorkflowManifest;
  normalized: NormalizedWorkflowManifest;
  /** JSON Schema (draft 2020-12) of the workflow input. */
  inputSchema: Record<string, unknown>;
  /** Absolute path to the bundled single-file program in the output dir. */
  bundlePath: string;
  log: string;
};

export type BuildWorkflowOptions = {
  sourceDir: string;
  outputDir: string;
};

const SENTINEL = '[[hatch]]';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Find the JSON object carried on the first `[[hatch]]` event line of a kind. */
function parseSentinel(stdout: string, kind: string): unknown {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(SENTINEL)) continue;
    try {
      const event = JSON.parse(line.slice(SENTINEL.length)) as {
        t?: string;
        schema?: unknown;
      };
      if (event.t === kind) return event;
    } catch {
      /* ignore malformed lines */
    }
  }
  return null;
}

export async function buildWorkflow(
  id: string,
  options: BuildWorkflowOptions,
): Promise<WorkflowBuildResult> {
  const originalSrc = options.sourceDir;
  const out = options.outputDir;
  const logs: string[] = [];

  if (!(await pathExists(originalSrc))) {
    throw new Error(`Workflow source not found: ${originalSrc}`);
  }

  const tempSrc = path.join(WORKFLOW_BUILD_WORK_DIR, id, randomUUID());
  const stagedOutput = `${tempSrc}-output`;
  await fs.rm(tempSrc, { recursive: true, force: true });
  await fs.mkdir(path.dirname(tempSrc), { recursive: true });
  await fs.cp(originalSrc, tempSrc, {
    recursive: true,
    // Reproduce dependencies from committed metadata and replace generated
    // roots below. Never trust an SDK or node_modules supplied by source.
    filter: (source) => {
      const relative = path
        .relative(originalSrc, source)
        .split(path.sep)
        .join('/');
      const rootEntry = relative.split('/', 1)[0]?.toLowerCase();
      return ![
        '.git',
        '.hatch',
        'node_modules',
        // pnpm writes this file itself; install never reads it.
        NODE_TOOLCHAIN_IGNORED_ROOT_FILE,
      ].includes(rootEntry);
    },
  });

  try {
    const file = await detectSourceManifest(tempSrc);
    const legacy =
      file === 'manifest.json'
        ? await loadSourceManifest(tempSrc, {
            kind: 'workflow',
            parse: parseSourceWorkflowManifest,
          })
        : undefined;

    // The committed lockfile selects the build pipeline before any source is
    // evaluated; the artifact runs on the same runtime either way.
    const toolchain = createSourceToolchain(
      await detectSourceToolchain(sourceToolchainReader(tempSrc)),
      platformToolchainContext('workflow', tempSrc, logs),
    );
    await toolchain.validateDependencies();

    if (await pathExists(path.join(tempSrc, 'hatch', 'workflow.ts'))) {
      throw new Error(
        'Workflow source contains the retired hatch/workflow.ts SDK. Remove ' +
          'the source-owned SDK and use the platform-generated .hatch SDK.',
      );
    }

    await materializeWorkflowHatchSdk(tempSrc);
    // 1) Reproduce the source-controlled dependency graph from the committed
    // lockfile.
    await toolchain.install();

    const { manifest } =
      legacy ?? (await toolchain.evaluateManifest(parseSourceWorkflowManifest));
    if (manifest.extraPermissions !== undefined) {
      await assertDenoPermissionFlags(manifest.extraPermissions, tempSrc);
    }

    const entry = path.join(tempSrc, manifest.entry);
    if (!(await pathExists(entry))) {
      throw new Error(`workflow entry not found: ${manifest.entry}`);
    }

    // Check the authored entry and its transitive imports before bundling or
    // evaluating author code. Bundling erases TypeScript types without checking
    // them; describe mode only validates the emitted runtime program.
    await toolchain.check({ entries: [manifest.entry] });

    await fs.mkdir(stagedOutput);

    // Materialize the authoritative SDK and generate only the per-build runner
    // wrapper. User source keeps the stable @hatch/workflow import without
    // owning the SDK implementation or its import map.
    const entryImport = `./${manifest.entry.replace(/\\/g, '/')}`;
    const wrapper = path.join(tempSrc, '__hatch_main.ts');
    await fs.writeFile(
      wrapper,
      // JSON.stringify the specifier so an entry path with quotes/backslashes
      // can't break out of the import string (entry is already constrained to a
      // safe relative path by the manifest schema; this is defense in depth).
      `import workflow from ${JSON.stringify(entryImport)};\n` +
        `import { runCli } from '@hatch/workflow';\n` +
        'await runCli(workflow);\n',
      'utf8',
    );

    // 2) Bundle the workflow + its npm deps into one Deno-runnable file.
    const bundlePath = path.join(stagedOutput, 'workflow.js');
    await toolchain.bundle({
      entry: path.basename(wrapper),
      outfile: bundlePath,
      outputRoot: stagedOutput,
    });

    // 3) Run the bundle in describe mode to capture the input JSON Schema. This
    // executes the deployed artifact, so it uses the runtime, not the toolchain.
    const describe = await run(
      'deno',
      // Describe mode imports and evaluates the same author-written bundle as a
      // real run, so it must use the identical network permission contract.
      buildWorkflowDenoArgs({
        bundlePath,
        artifactDir: stagedOutput,
        network: manifest.network,
        extraPermissions: manifest.extraPermissions,
      }),
      {
        cwd: stagedOutput,
        env: workflowSandboxEnv({ HATCH_MODE: 'describe' }),
      },
    );
    if (describe.code !== 0) {
      throw new Error(
        `Failed to read workflow input schema:\n${
          describe.stderr || describe.stdout
        }`,
      );
    }
    const schemaEvent = parseSentinel(describe.stdout, 'schema') as {
      schema?: Record<string, unknown>;
    } | null;
    if (!schemaEvent || !schemaEvent.schema) {
      throw new Error(
        'Workflow did not emit an input schema. Ensure it uses ' +
          '`export default defineWorkflow(...)`.',
      );
    }
    const inputSchema = schemaEvent.schema;
    logs.push('captured input schema');

    const normalized = normalizeWorkflowManifest(manifest);
    await fs.writeFile(
      path.join(stagedOutput, 'manifest.normalized.json'),
      JSON.stringify(normalized, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(stagedOutput, 'input.schema.json'),
      JSON.stringify(inputSchema, null, 2),
      'utf8',
    );

    await fs.rm(out, { recursive: true, force: true });
    await fs.cp(stagedOutput, out, { recursive: true });

    return {
      source: manifest,
      normalized,
      inputSchema,
      bundlePath: path.join(out, 'workflow.js'),
      log: logs.join('\n'),
    };
  } finally {
    await fs.rm(tempSrc, { recursive: true, force: true });
    await fs.rm(stagedOutput, { recursive: true, force: true });
  }
}
