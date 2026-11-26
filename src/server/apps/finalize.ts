/**
 * Server-only: accept a build package (src/app-build/format.ts) for one
 * deployment and write the deployment artifact from it.
 *
 * A package is built where App source may run (the dedicated Builder or the
 * author's CLI), so the platform trusts none of it. It never runs package
 * code. It re-checks everything that can be checked without running code and
 * writes the files that decide how the App runs itself:
 *  - the source manifest is validated again and must name this App;
 *  - `manifest.normalized.json` (the backend's runtime permissions) and
 *    `deployment.json` are written here, never copied;
 *  - the API, tasks and cron are read from the compiled descriptor set;
 *  - the Data Table descriptor is parsed here, and the platform plans the
 *    migration SQL from it;
 *  - docs are read and limited here;
 *  - a native frontend's runtime is published as its own content-addressed
 *    set, and its player page is the platform's.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileDescriptorSet } from '@bufbuild/protobuf/wkt';
import { readAppApi } from '../../app-build/api';
import {
  BUILD_PACKAGE_API_DESCRIPTOR,
  BUILD_PACKAGE_DOCS_DIR,
  BUILD_PACKAGE_MANIFEST,
  BUILD_PACKAGE_MAX_EXPANDED_BYTES,
  BUILD_PACKAGE_MAX_FILES,
  BUILD_PACKAGE_ROOT_ENTRIES,
  buildPackageManifestSchema,
  type BuildPackageManifest,
  type BuildTooling,
} from '../../app-build/format';
import { backendBundleEntry } from '../../app-build/produce';
import { assertDenoPermissionFlags } from '../deno-permissions';
import { validateSchemaInput } from '../json-schema-input';
import { validateCron } from './cron-expr';
import {
  parseDataSchemaDescriptor,
  type DataSchemaDescriptor,
} from './data-table/schema';
import { captureAppDocs, writeAppDocs } from './docs-build';
import {
  type AppApi,
  type NormalizedManifest,
  type SourceManifest,
  normalizeManifest,
  parseSourceManifest,
} from './manifest';
import { manifestInvalid } from './manifest-validation';
import { assembleNativePlayer } from './native/player';
import {
  TaskInputSchemaError,
  taskDescriptorRegistry,
  taskInputSchema,
} from './tasks/input-schema';

export type FinalizedBuild = {
  source: SourceManifest;
  normalized: NormalizedManifest;
  dataSchema?: DataSchemaDescriptor;
  log: string;
  tooling: BuildTooling;
};

/** A package the platform does not accept; nothing has been released. */
export class BuildPackageError extends Error {
  constructor(
    message: string,
    readonly code: 'app_build_invalid' | 'toolchain_mismatch',
  ) {
    super(message);
    this.name = 'BuildPackageError';
  }
}

export type FinalizeBuildOptions = {
  /** The unpacked package. Read only. */
  packageDir: string;
  /** Where the artifact is written; must not exist yet. */
  outDir: string;
  appId: string;
  deploymentId: string;
  /** The deployment's source commit; null for a build without one. */
  commit: string | null;
  /** The toolchain the platform accepts packages from. */
  tooling: (options: { native: boolean }) => Promise<BuildTooling>;
};

/**
 * Walk the package: regular files and directories only, known top-level
 * entries, bounded in count and size. Unpacking applies the same rules;
 * this keeps finalize safe on its own.
 */
async function assertPackageTree(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  async function walk(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        !relative &&
        !(BUILD_PACKAGE_ROOT_ENTRIES as readonly string[]).includes(entry.name)
      ) {
        throw new BuildPackageError(
          `The build package has an unexpected entry: ${child}`,
          'app_build_invalid',
        );
      }
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await fs.lstat(path.join(root, child))).size;
        if (
          files > BUILD_PACKAGE_MAX_FILES ||
          bytes > BUILD_PACKAGE_MAX_EXPANDED_BYTES
        ) {
          throw new BuildPackageError(
            'The build package is too large.',
            'app_build_invalid',
          );
        }
      } else {
        throw new BuildPackageError(
          `The build package may contain only files and directories: ${child}`,
          'app_build_invalid',
        );
      }
    }
  }
  await walk('');
}

async function readPackageManifest(
  root: string,
): Promise<BuildPackageManifest> {
  const text = await fs
    .readFile(path.join(root, BUILD_PACKAGE_MANIFEST), 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      // Only a missing file is the package's fault; another read error is
      // the platform's.
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
      throw new BuildPackageError(
        `The build package has no ${BUILD_PACKAGE_MANIFEST}.`,
        'app_build_invalid',
      );
    });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BuildPackageError(
      `${BUILD_PACKAGE_MANIFEST} is not JSON.`,
      'app_build_invalid',
    );
  }
  const parsed = buildPackageManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new BuildPackageError(
      `${BUILD_PACKAGE_MANIFEST} is not a hatch-build-v1 manifest (${issues}).`,
      'app_build_invalid',
    );
  }
  return parsed.data;
}

function assertTooling(actual: BuildTooling, expected: BuildTooling): void {
  const differences = (Object.keys(expected) as (keyof BuildTooling)[])
    .filter((key) => actual[key] !== expected[key])
    .map(
      (key) =>
        `${key} ${actual[key] ?? 'none'} (platform: ${expected[key] ?? 'none'})`,
    );
  if (differences.length) {
    throw new BuildPackageError(
      `The App was built with a different toolchain than this platform ` +
        `uses: ${differences.join(', ')}. Upgrade the hatch CLI and build again.`,
      'toolchain_mismatch',
    );
  }
}

async function pathIsFile(file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => null);
  return Boolean(stat?.isFile());
}

/**
 * Check every task against the compiled proto and fill its input schema:
 * the method must be a unary method of the declared service, its request
 * message must map to a form, and each cron input must satisfy it.
 */
function resolveTaskInputs(
  normalized: NormalizedManifest,
  descriptors: FileDescriptorSet | undefined,
): void {
  const tasks = normalized.tasks;
  if (!tasks) return;
  const serviceName = normalized.rpc?.service;
  const service = normalized.api?.services.find((s) => s.name === serviceName);
  if (!service || !descriptors) {
    throw manifestInvalid(
      ['rpc', 'service'],
      'tasks require a compiled RPC service',
    );
  }
  const registry = taskDescriptorRegistry(descriptors);
  for (const [index, task] of tasks.definitions.entries()) {
    const at = ['tasks', 'definitions', index] as const;
    const method = service.methods.find((m) => m.name === task.method);
    if (!method) {
      throw manifestInvalid(
        [...at, 'method'],
        'is not a method of the declared rpc.service',
      );
    }
    if (method.clientStreaming || method.serverStreaming) {
      throw manifestInvalid(
        [...at, 'method'],
        'names a streaming method; a task run sends one unary request',
      );
    }
    try {
      task.inputSchema = taskInputSchema(registry, method.inputType);
    } catch (error) {
      if (error instanceof TaskInputSchemaError) {
        throw new Error(
          `Task "${task.name}" cannot use ${method.inputType} as its input: ${error.message}`,
        );
      }
      throw error;
    }
    task.inputType = method.inputType;
    for (const [jobIndex, job] of task.cron.entries()) {
      if (validateCron(job.schedule)) {
        throw manifestInvalid(
          [...at, 'cron', jobIndex, 'schedule'],
          'is not a valid five-field cron expression',
        );
      }
      if (!validateSchemaInput(task.inputSchema, job.input).success) {
        throw manifestInvalid(
          [...at, 'cron', jobIndex, 'input'],
          `does not match the task input message ${method.inputType}`,
        );
      }
    }
  }
}

async function copyFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

/** Accept `packageDir` for one deployment and write its artifact. */
export async function finalizeBuild(
  options: FinalizeBuildOptions,
): Promise<FinalizedBuild> {
  const { packageDir: root, outDir: out, appId: id } = options;
  await assertPackageTree(root);
  const pkg = await readPackageManifest(root);
  if (pkg.appId !== id || pkg.deploymentId !== options.deploymentId) {
    throw new BuildPackageError(
      'The build package was built for another deployment.',
      'app_build_invalid',
    );
  }
  if (options.commit !== null && pkg.commit !== options.commit) {
    throw new BuildPackageError(
      `The build package was built from ${pkg.commit ?? 'no commit'}, ` +
        `not the deployment's commit ${options.commit}.`,
      'app_build_invalid',
    );
  }
  const manifestFile = pkg.manifestFile;
  const logs = [pkg.log];

  const manifest = parseSourceManifest(pkg.manifest);
  // The manifest id drives every generated URL (app/widget/RPC), but
  // artifacts and the DB row are keyed by the App id. If they diverge, the
  // deploy "succeeds" with URLs pointing at a different slug.
  if (manifest.id !== id) {
    throw manifestInvalid(['id'], `does not match the App id "${id}"`).inFile(
      manifestFile,
    );
  }
  const nativeFrontend = Boolean(
    manifest.capabilities.frontend && manifest.app?.runtime === 'native',
  );
  assertTooling(pkg.tooling, await options.tooling({ native: nativeFrontend }));

  if (manifest.backend?.extraPermissions !== undefined) {
    await assertDenoPermissionFlags(manifest.backend.extraPermissions, root);
  }

  let api: AppApi | undefined;
  let descriptors: FileDescriptorSet | undefined;
  if (manifest.rpc) {
    const rpc = manifest.rpc;
    if (!(await pathIsFile(path.join(root, BUILD_PACKAGE_API_DESCRIPTOR)))) {
      throw new BuildPackageError(
        `The build package has no ${BUILD_PACKAGE_API_DESCRIPTOR} for its RPC service.`,
        'app_build_invalid',
      );
    }
    try {
      ({ api, descriptors } = await readAppApi(root));
    } catch {
      throw new BuildPackageError(
        `${BUILD_PACKAGE_API_DESCRIPTOR} is not a compiled descriptor set.`,
        'app_build_invalid',
      );
    }
    if (!api.services.some((service) => service.name === rpc.service)) {
      throw new Error(
        `RPC service declared by ${manifestFile} was not found in the compiled proto: ${rpc.service}`,
      );
    }
    logs.push(
      `captured app API: ${api.services.length} service(s), ${api.protoFiles.length} proto file(s)`,
    );
  }

  let dataSchema: DataSchemaDescriptor | undefined;
  if (manifest.capabilities.dataTable) {
    try {
      dataSchema = parseDataSchemaDescriptor(pkg.dataSchema);
    } catch (error) {
      throw new Error(
        `Data Table schema is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const normalized = normalizeManifest(manifest);
  if (api) normalized.api = api;
  if (normalized.tasks) {
    resolveTaskInputs(normalized, descriptors);
    logs.push(
      `captured ${normalized.tasks.definitions.length} task input schema(s)`,
    );
  }
  const docs = await captureAppDocs(
    path.join(root, BUILD_PACKAGE_DOCS_DIR),
    manifest.docs,
    manifestFile,
  );
  if (docs.length > 0) logs.push(`captured ${docs.length} external doc(s)`);

  await fs.mkdir(out, { recursive: false });
  try {
    if (nativeFrontend && manifest.app) {
      const { nshVersion } = await assembleNativePlayer({
        packageDir: root,
        out,
        app: { id, name: manifest.name },
        api,
        dataTable: manifest.capabilities.dataTable,
        deploymentId: options.deploymentId,
        logs,
      });
      if (normalized.app) normalized.app = { ...normalized.app, nshVersion };
    } else if (manifest.capabilities.frontend && manifest.app) {
      const html = path.join(root, 'app', 'index.html');
      if (!(await pathIsFile(html))) {
        throw new BuildPackageError(
          'The build package has no app/index.html.',
          'app_build_invalid',
        );
      }
      await copyFile(html, path.join(out, 'app', 'index.html'));
      const bundle = path.join(root, 'app', 'app.js');
      if (await pathIsFile(bundle)) {
        await copyFile(bundle, path.join(out, 'app', 'app.js'));
      }
    }

    if (manifest.capabilities.widgets) {
      for (const [index, widget] of manifest.widgets.entries()) {
        const file = path.join(root, 'widgets', `${widget.id}.js`);
        if (!(await pathIsFile(file))) {
          throw manifestInvalid(
            ['widgets', index, 'entry'],
            'was not bundled',
          ).inFile(manifestFile);
        }
        await copyFile(file, path.join(out, 'widgets', `${widget.id}.js`));
      }
    }

    if (manifest.capabilities.backend && manifest.backend) {
      // The runtime entry is derived from the validated manifest, never read
      // from the package.
      const entry = backendBundleEntry(manifest.backend.entry);
      if (!(await pathIsFile(path.join(root, entry)))) {
        throw new BuildPackageError(
          `The build package has no backend bundle ${entry}.`,
          'app_build_invalid',
        );
      }
      await copyFile(path.join(root, entry), path.join(out, entry));
      const assets = path.join(root, 'backend', 'assets');
      if ((await fs.lstat(assets).catch(() => null))?.isDirectory()) {
        await fs.cp(assets, path.join(out, 'backend', 'assets'), {
          recursive: true,
        });
      }
      // The runtime contract always points at this directory.
      await fs.mkdir(path.join(out, 'backend', 'assets'), { recursive: true });
      if (normalized.backend) {
        normalized.backend = {
          ...normalized.backend,
          entry,
          format: 'bundle-v1',
        };
      }
    }

    await writeAppDocs(out, docs);
    if (docs.length > 0) normalized.docs = docs.map(({ doc }) => doc);
    await fs.writeFile(
      path.join(out, 'manifest.normalized.json'),
      JSON.stringify(normalized, null, 2),
      'utf8',
    );
    if (options.deploymentId) {
      // Runtime workers use this immutable marker to reject/restart a backend
      // whose process was spawned from a superseded shared build directory.
      await fs.writeFile(
        path.join(out, 'deployment.json'),
        JSON.stringify({ deploymentId: options.deploymentId }, null, 2),
        'utf8',
      );
    }
  } catch (error) {
    // The rejection is what the deployment reports, not a failed cleanup.
    await fs.rm(out, { recursive: true, force: true }).catch((cleanup) => {
      console.error(`[apps] could not remove ${out}:`, cleanup);
    });
    throw error;
  }

  return {
    source: manifest,
    normalized,
    dataSchema,
    log: logs.filter(Boolean).join('\n'),
    tooling: pkg.tooling,
  };
}
