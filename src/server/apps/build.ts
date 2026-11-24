/** Server-only: compile an app source tree into deployable artifacts. */
import {
  detectSourceManifest,
  loadSourceManifest,
} from '../../source-manifest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {
  BUILD_WORK_DIR,
  REPO_ROOT,
  appBuildDir,
  appSrcDir,
} from '~agent/paths';
import { materializeAppHatchSdk } from '~agent/hatch-sdk';
import { NODE_TOOLCHAIN_IGNORED_ROOT_FILE } from '../../app-managed-path';
import { assertNoBundleImports } from '../../node-toolchain-commands';
import {
  detectSourceToolchain,
  sourceToolchainReader,
  type SourceToolchain,
} from '../../source-toolchain';
import { createSourceToolchain } from '../../toolchain';
import {
  hatchSdkPlugin,
  sourceBoundaryPlugin,
} from '../../toolchain/esbuild-plugins';
import { platformToolchainContext } from '../../toolchain/platform';
import { PLATFORM_APP_BUF_GEN_YAML } from '~agent/app-codegen';
import {
  type AppApi,
  type NormalizedManifest,
  type ProtoFile,
  type RpcServiceApi,
  type SourceManifest,
  dataTableUrl,
  normalizeManifest,
  parseSourceManifest,
  rpcUrl,
} from './manifest';
import {
  parseDataSchemaDescriptor,
  type DataSchemaDescriptor,
} from './data-table/schema';
import { fromBinary } from '@bufbuild/protobuf';
import {
  FileDescriptorSetSchema,
  type FileDescriptorSet,
} from '@bufbuild/protobuf/wkt';
import { subprocessSandboxEnv } from '../sandbox-env';
import { validateSchemaInput } from '../json-schema-input';
import { validateCron } from './cron-expr';
import {
  TaskInputSchemaError,
  taskDescriptorRegistry,
  taskInputSchema,
} from './tasks/input-schema';
import { assertDenoPermissionFlags } from '../deno-permissions';
import { run as runSubprocess } from '../subprocess';

export type BuildResult = {
  source: SourceManifest;
  normalized: NormalizedManifest;
  dataSchema?: DataSchemaDescriptor;
  log: string;
};

export type BuildAppOptions = {
  sourceDir?: string;
  outputDir?: string;
  deploymentId?: string;
};

const BIN_DIR = path.join(REPO_ROOT, 'node_modules', '.bin');

/**
 * Bounded build-step runner (shared timeout + output cap) with the platform's
 * node_modules/.bin prepended so buf can resolve the protoc-gen-es plugin.
 */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): ReturnType<typeof runSubprocess> {
  const baseEnv = opts.env ?? process.env;
  return runSubprocess(cmd, args, {
    cwd: opts.cwd,
    env: { ...baseEnv, PATH: `${BIN_DIR}:${baseEnv.PATH ?? ''}` },
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function backendBundleEntry(sourceEntry: string): string {
  const normalized = sourceEntry.replaceAll('\\', '/');
  const extension = path.posix.extname(normalized);
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  return `${stem}.bundle.js`;
}

async function copyBackendAssetNode(
  source: string,
  destination: string,
  relativePath: string,
): Promise<void> {
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) {
    throw new Error(`backend asset disappeared during build: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `backend asset must not be a symbolic link: ${relativePath}`,
    );
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      await copyBackendAssetNode(
        path.join(source, entry),
        path.join(destination, entry),
        path.posix.join(relativePath, entry),
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      `backend asset must be a regular file or directory: ${relativePath}`,
    );
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copyBackendAssets(
  sourceRoot: string,
  outputRoot: string,
): Promise<void> {
  const backendPath = 'backend';
  const backendSource = path.join(sourceRoot, backendPath);
  const backendStat = await fs.lstat(backendSource).catch(() => null);
  if (backendStat?.isSymbolicLink()) {
    throw new Error(
      `backend source directory must not be a symbolic link: ${backendPath}`,
    );
  }
  if (backendStat && !backendStat.isDirectory()) {
    throw new Error(`backend source path must be a directory: ${backendPath}`);
  }

  const relativePath = 'backend/assets';
  const source = path.join(sourceRoot, relativePath);
  const destination = path.join(outputRoot, relativePath);
  const stat = await fs.lstat(source).catch(() => null);

  // The runtime contract always points at this directory, including for apps
  // that do not ship static files.
  await fs.mkdir(destination, { recursive: true });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(
      `backend asset directory must not be a symbolic link: ${relativePath}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`backend asset path must be a directory: ${relativePath}`);
  }
  for (const entry of await fs.readdir(source)) {
    await copyBackendAssetNode(
      path.join(source, entry),
      path.join(destination, entry),
      path.posix.join(relativePath, entry),
    );
  }
}

async function validateBackendBundleSourceNode(
  sourceRoot: string,
  relativePath: string,
): Promise<void> {
  // Assets have their own stricter copy-time walk and diagnostics below.
  if (
    relativePath === 'backend/assets' ||
    relativePath.startsWith('backend/assets/')
  ) {
    return;
  }

  const source = path.join(sourceRoot, relativePath);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) {
    throw new Error(
      `backend bundle source disappeared during build: ${relativePath}`,
    );
  }
  if (stat.isSymbolicLink()) {
    if (relativePath === 'backend') {
      throw new Error(
        'backend source directory must not be a symbolic link: backend',
      );
    }
    throw new Error(
      `backend bundle source must not be a symbolic link: ${relativePath}`,
    );
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(source)) {
      await validateBackendBundleSourceNode(
        sourceRoot,
        path.posix.join(relativePath, entry),
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      `backend bundle source must be a regular file or directory: ${relativePath}`,
    );
  }
}

async function validateBackendBundleSourceTree(
  sourceRoot: string,
): Promise<void> {
  // Check the platform-defined backend/generated roots. Installed packages
  // legitimately contain package-manager links, and unrelated app content
  // should not be rejected merely because the app also has a backend.
  for (const root of ['backend', 'gen']) {
    const stat = await fs.lstat(path.join(sourceRoot, root)).catch(() => null);
    if (stat) await validateBackendBundleSourceNode(sourceRoot, root);
  }
}

/**
 * Source trees are untrusted. The builder overwrites platform-managed files and
 * invokes tools inside its temporary copy, so even one preserved symlink could
 * redirect a write/read outside that copy. Validate the copied tree before the
 * first manifest read or generated-file write and never recurse through links.
 */
async function assertSourceHasNoSymlinks(root: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error('App source may not contain symbolic links: .');
  }

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        if (relative === 'backend') {
          throw new Error(
            'backend source directory must not be a symbolic link: backend',
          );
        }
        if (relative === 'backend/assets') {
          throw new Error(
            'backend asset directory must not be a symbolic link: backend/assets',
          );
        }
        if (relative.startsWith('backend/assets/')) {
          throw new Error(
            `backend asset must not be a symbolic link: ${relative}`,
          );
        }
        if (
          relative.startsWith('backend/') ||
          relative === 'gen' ||
          relative.startsWith('gen/')
        ) {
          throw new Error(
            `backend bundle source must not be a symbolic link: ${relative}`,
          );
        }
        throw new Error(
          `App source may not contain symbolic links: ${relative}`,
        );
      }
      if (entry.isDirectory()) await walk(full);
    }
  }

  await walk(root);
}

type SourceCheckEntry = {
  path: string;
  missingMessage: string;
};

/**
 * Return the authored TypeScript roots enabled by the source manifest. Deno
 * follows every transitive import from these roots, so one invocation checks
 * the complete App graph while avoiding disabled capabilities.
 */
function sourceCheckEntries(manifest: SourceManifest): SourceCheckEntry[] {
  const entries: SourceCheckEntry[] = [];
  if (manifest.capabilities.frontend && manifest.app) {
    entries.push({
      path: manifest.app.entry,
      missingMessage: `app entry not found: ${manifest.app.entry}`,
    });
  }
  if (manifest.capabilities.backend && manifest.backend) {
    entries.push({
      path: manifest.backend.entry,
      missingMessage: `backend entry not found: ${manifest.backend.entry}`,
    });
  }
  if (manifest.capabilities.widgets) {
    for (const widget of manifest.widgets) {
      entries.push({
        path: widget.entry,
        missingMessage: `widget entry not found: ${widget.entry}`,
      });
    }
  }
  if (manifest.capabilities.dataTable) {
    entries.push({
      path: 'data/schema.ts',
      missingMessage:
        'capabilities.dataTable is true but data/schema.ts does not exist.',
    });
  }

  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

/** Type-check every enabled App entry before evaluating or bundling source. */
async function checkAppSource(
  src: string,
  manifest: SourceManifest,
  toolchain: SourceToolchain,
): Promise<void> {
  const entries = sourceCheckEntries(manifest);
  if (entries.length === 0) return;

  for (const entry of entries) {
    if (!(await pathExists(path.join(src, entry.path)))) {
      throw new Error(`Source validation failed: ${entry.missingMessage}`);
    }
  }

  const backend = manifest.backend;
  const validatesFetchBackend =
    backend?.runtime === 'deno-serve' &&
    manifest.capabilities.backend &&
    backend !== undefined;
  await toolchain.check({
    entries: entries.map((entry) => entry.path),
    fetchContract: validatesFetchBackend ? backend.entry : undefined,
  });
}

function stripLeadingDot(t: string): string {
  return t.startsWith('.') ? t.slice(1) : t;
}

/** Map a compiled descriptor set to the platform's service/method API view. */
function parseServices(set: FileDescriptorSet): RpcServiceApi[] {
  const services: RpcServiceApi[] = [];
  for (const file of set.file) {
    const pkg = file.package ? `${file.package}.` : '';
    for (const svc of file.service) {
      if (!svc.name) continue;
      services.push({
        name: `${pkg}${svc.name}`,
        methods: svc.method.map((m) => ({
          name: m.name,
          inputType: stripLeadingDot(m.inputType),
          outputType: stripLeadingDot(m.outputType),
          clientStreaming: m.clientStreaming,
          serverStreaming: m.serverStreaming,
        })),
      });
    }
  }
  return services;
}

/** Recursively read every `.proto` under the app's fixed `proto/` directory. */
async function collectProtoFiles(src: string): Promise<ProtoFile[]> {
  const protoRoot = path.join(src, 'proto');
  if (!(await pathExists(protoRoot))) return [];
  const files: ProtoFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.proto')) {
        files.push({
          path: path.relative(src, full).split(path.sep).join('/'),
          content: await fs.readFile(full, 'utf8'),
        });
      }
    }
  }
  await walk(protoRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Capture the app's declared API: compile the proto module to a JSON descriptor
 * set (so we enumerate services + methods exactly as the wire sees them) and
 * collect the raw proto sources for upload. Runs alongside `buf generate` and is
 * keyed off the same `proto/` module.
 */
async function extractAppApi(
  src: string,
): Promise<{ api: AppApi; descriptors: FileDescriptorSet }> {
  // Write to a temp file (not stdout) so buf warnings on stderr never corrupt
  // the descriptor we parse. The file lives outside the staged output dir.
  // The binary form keeps custom options (task input hints) and source
  // comments, which the JSON form cannot carry for unknown extensions.
  const descriptorPath = path.join(
    BUILD_WORK_DIR,
    `descriptor-${randomUUID()}.binpb`,
  );
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
  try {
    const built = await run('buf', ['build', '-o', descriptorPath], {
      cwd: src,
      env: subprocessSandboxEnv(),
    });
    if (built.code !== 0) {
      throw new Error(`buf build (API descriptor) failed:\n${built.output}`);
    }
    const set = fromBinary(
      FileDescriptorSetSchema,
      await fs.readFile(descriptorPath),
    );
    return {
      api: {
        services: parseServices(set),
        protoFiles: await collectProtoFiles(src),
      },
      descriptors: set,
    };
  } finally {
    await fs.rm(descriptorPath, { force: true });
  }
}

/** Shared esbuild define for browser bundles (app + widgets). */
function browserDefine(
  id: string,
  name: string,
  deploymentId: string | undefined,
): Record<string, string> {
  return {
    __RPC_BASE_URL__: JSON.stringify(rpcUrl(id)),
    __DATA_BASE_URL__: JSON.stringify(dataTableUrl(id)),
    __DATA_DEPLOYMENT_ID__: JSON.stringify(deploymentId ?? ''),
    __APP_NAME__: JSON.stringify(name),
    'process.env.NODE_ENV': '"production"',
  };
}

/**
 * A classic script that scopes `localStorage` and `sessionStorage` to this App
 * before any App or library code runs (see @hatch/app/storage/install). Keyed
 * by the immutable id so renaming the slug keeps users' stored values.
 */
async function storageInstallScript(
  id: string,
  esbuildResolve: Pick<esbuild.BuildOptions, 'absWorkingDir' | 'plugins'>,
): Promise<string> {
  const result = await esbuild.build({
    ...esbuildResolve,
    stdin: {
      contents:
        "import { installAppStorage } from '@hatch/app/storage/install';\n" +
        `installAppStorage(${JSON.stringify(id)});\n`,
      resolveDir: esbuildResolve.absWorkingDir,
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/**
 * Blank out what the browser does not parse as tags (comments and the bodies
 * of script, style, template and textarea elements) without changing the
 * length, so indexes found in the result address the same place in `html`.
 */
function markupOnly(html: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  // One left-to-right scan, so whichever construct opens first wins.
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|(<(script|style|template|textarea)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi,
    (match, open?: string, _name?: string, body?: string, close?: string) =>
      open === undefined ? blank(match) : open + blank(body!) + close!,
  );
}

/** Inline `code` as a classic script that runs before every page script. */
function prependHeadScript(html: string, code: string): string {
  const tag = `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
  const markup = markupOnly(html);
  const insertAt = (index: number) =>
    html.slice(0, index) + tag + html.slice(index);
  const head = /<head(?:\s[^>]*)?>/i.exec(markup);
  if (head) return insertAt(head.index + head[0].length);
  // Without an explicit head, the first script still precedes all others.
  const firstScript = /<script\b/i.exec(markup);
  if (firstScript) return insertAt(firstScript.index);
  const body = /<\/body\s*>/i.exec(markup);
  return body ? insertAt(body.index) : html + tag;
}

async function describeDataSchema(
  src: string,
  toolchain: SourceToolchain,
): Promise<DataSchemaDescriptor> {
  const schemaPath = path.join(src, 'data', 'schema.ts');
  if (!(await pathExists(schemaPath))) {
    throw new Error(
      'capabilities.dataTable is true but data/schema.ts does not exist.',
    );
  }
  const descriptor = await toolchain.describe();
  try {
    return parseDataSchemaDescriptor(JSON.parse(descriptor));
  } catch (error) {
    throw new Error(
      `Data Table schema is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
    throw new Error('Tasks require a compiled RPC service (rpc.service).');
  }
  const registry = taskDescriptorRegistry(descriptors);
  for (const task of tasks.definitions) {
    const method = service.methods.find((m) => m.name === task.method);
    if (!method) {
      throw new Error(
        `Task "${task.name}" names RPC method "${task.method}", which is not defined on ${service.name}.`,
      );
    }
    if (method.clientStreaming || method.serverStreaming) {
      throw new Error(
        `Task "${task.name}" names RPC method "${task.method}", which is a streaming method. A task run sends one unary request.`,
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
    for (const job of task.cron) {
      const scheduleError = validateCron(job.schedule);
      if (scheduleError) {
        throw new Error(
          `Task "${task.name}" cron job "${job.name}" has an invalid schedule: ${scheduleError}`,
        );
      }
      const check = validateSchemaInput(task.inputSchema, job.input, {
        strict: true,
      });
      if (!check.success) {
        throw new Error(
          `Task "${task.name}" cron job "${job.name}" input does not match the task input: ${check.message}`,
        );
      }
    }
  }
}

export async function buildApp(
  id: string,
  options: BuildAppOptions = {},
): Promise<BuildResult> {
  const originalSrc = options.sourceDir ?? appSrcDir(id);
  const out = options.outputDir ?? appBuildDir(id);
  const logs: string[] = [];

  if (!(await pathExists(originalSrc))) {
    throw new Error(`App source not found: ${originalSrc}`);
  }

  const tempSrc = path.join(BUILD_WORK_DIR, id, randomUUID());
  await fs.rm(tempSrc, { recursive: true, force: true });
  await fs.mkdir(path.dirname(tempSrc), { recursive: true });
  const src = tempSrc;

  try {
    await fs.cp(originalSrc, tempSrc, {
      recursive: true,
      // Reproduce dependencies from the committed lock below; never trust or
      // waste time copying a source checkout's pre-existing installations. The
      // exclusions are platform-generated roots; matching only the first path
      // segment keeps identically named authored directories below app/, widgets/,
      // backend/assets/, and other source trees intact.
      filter: (source) => {
        const relative = path
          .relative(originalSrc, source)
          .split(path.sep)
          .join('/');
        const rootEntry = relative.split('/', 1)[0]?.toLowerCase();
        return ![
          '.git',
          '.hatch',
          'gen',
          'node_modules',
          // pnpm writes this file itself; install never reads it.
          NODE_TOOLCHAIN_IGNORED_ROOT_FILE,
        ].includes(rootEntry);
      },
    });
    await assertSourceHasNoSymlinks(tempSrc);

    const manifestFile = await detectSourceManifest(src);
    const legacy =
      manifestFile === 'manifest.json'
        ? await loadSourceManifest(src, {
            kind: 'app',
            parse: parseSourceManifest,
          })
        : undefined;

    // The committed lockfile selects the build pipeline before any source is
    // evaluated; it is independent of the runtime the manifest declares.
    const toolchain = createSourceToolchain(
      await detectSourceToolchain(sourceToolchainReader(src)),
      platformToolchainContext('app', src, logs),
    );
    await toolchain.validateDependencies();

    // Agent worktree dependencies are intentionally absent from deploy bundles.
    // After validating authored dependency metadata, materialize the trusted
    // SDK and fixed platform import map inside this disposable checkout.
    await materializeAppHatchSdk(src);

    // 2) Reproduce the dependency install from the committed lockfile. Neither
    // pipeline runs npm lifecycle scripts for Apps inside the platform process.
    await toolchain.install();

    const { manifest } =
      legacy ?? (await toolchain.evaluateManifest(parseSourceManifest));

    if (manifest.backend?.extraPermissions !== undefined) {
      await assertDenoPermissionFlags(manifest.backend?.extraPermissions, src);
    }

    // The manifest id drives every generated URL (app/widget/RPC), but
    // artifacts and the DB row are keyed by the `id` argument. If they diverge,
    // the deploy "succeeds" with URLs pointing at a different slug. Reject early.
    if (manifest.id !== id) {
      throw new Error(
        `manifest.id "${manifest.id}" does not match the app id "${id}". ` +
          `Fix ${manifestFile} so its id matches the app.`,
      );
    }

    // 1) Connect codegen from proto (if the app has a backend RPC service). We
    // also compile the proto to a descriptor set so the platform records the
    // app's declared API (services + methods) and uploads the raw proto.
    const protoPath = manifest.rpc ? path.join(src, manifest.rpc.proto) : null;
    let api: AppApi | undefined;
    let descriptors: FileDescriptorSet | undefined;
    if (manifest.rpc && protoPath) {
      const rpc = manifest.rpc;
      const protoEntry = await fs.lstat(protoPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!protoEntry) {
        throw new Error(
          `RPC proto declared by ${manifestFile} was not found: ${rpc.proto}`,
        );
      }
      if (!protoEntry.isFile()) {
        throw new Error(
          `RPC proto declared by ${manifestFile} must be a regular file: ${rpc.proto}`,
        );
      }
      // `buf generate` executes the plugins listed in buf.gen.yaml, and `local:`
      // plugins are arbitrary commands. The file ships with the app source, so
      // an app could point it at `sh` and run code at build time. Overwrite it
      // (we build from a temp copy) with the platform's fixed codegen config so
      // only the sanctioned plugin ever runs, and withhold platform secrets
      // from the plugin's environment like every other build subprocess.
      await fs.writeFile(
        path.join(src, 'buf.gen.yaml'),
        PLATFORM_APP_BUF_GEN_YAML,
      );
      const gen = await run('buf', ['generate'], {
        cwd: src,
        env: subprocessSandboxEnv(),
      });
      logs.push(`$ buf generate\n${gen.output.trim()}`);
      if (gen.code !== 0) {
        throw new Error(`Connect codegen failed:\n${gen.output}`);
      }
      ({ api, descriptors } = await extractAppApi(src));
      if (!api.services.some((service) => service.name === rpc.service)) {
        throw new Error(
          `RPC service declared by ${manifestFile} was not found in the compiled proto: ${rpc.service}`,
        );
      }
      logs.push(
        `captured app API: ${api.services.length} service(s), ${api.protoFiles.length} proto file(s)`,
      );
    }

    // Type-check every enabled manifest entry and its transitive imports after
    // the frozen install, before schema evaluation, bundling, or artifact writes.
    await checkAppSource(src, manifest, toolchain);

    // Source checking validates imports and types, but schema.ts still needs to
    // execute to produce the declarative migration descriptor. Keep that run
    // frozen as well so it cannot add an unreviewed dependency to the temporary
    // lockfile and bless it for the rest of this build.
    let dataSchema: DataSchemaDescriptor | undefined;
    if (manifest.capabilities.dataTable) {
      dataSchema = await describeDataSchema(src, toolchain);
    }

    // Task inputs come from the compiled proto: resolve (and validate) them
    // with the other source checks, before the output is replaced.
    let tasks: NormalizedManifest['tasks'];
    {
      const preview = normalizeManifest(manifest);
      if (preview.tasks) {
        if (api) preview.api = api;
        resolveTaskInputs(preview, descriptors);
        tasks = preview.tasks;
      }
    }

    // Only start replacing the requested output after every source validation
    // step has passed. Deploy builds use a fresh path, while direct callers do
    // not lose a prior output merely because new source fails validation.
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out, { recursive: true });

    // Browser bundles may resolve only modules materialized inside this build's
    // disposable App root. The install above put every declared npm dependency there;
    // falling back to the platform repository would make builds non-hermetic.
    const browserSourceRoot = await fs.realpath(src);
    const esbuildResolve = {
      absWorkingDir: src,
      plugins: [hatchSdkPlugin(src), sourceBoundaryPlugin(browserSourceRoot)],
      // Prevent esbuild from walking above the temporary App root in search of
      // a platform tsconfig. The toolchain's type checker is the source of
      // truth for types.
      tsconfigRaw: {
        compilerOptions: {
          jsx: 'react-jsx' as const,
          jsxImportSource: 'react',
        },
      },
      metafile: true as const,
    };
    // `deno check --no-remote` rejects remote imports for Deno sources. tsc
    // accepts any import an ambient declaration covers, and esbuild keeps URL
    // imports external, so Node sources are checked on the bundle itself.
    const assertSelfContained = (
      result: esbuild.BuildResult<{ metafile: true }>,
      subject: string,
    ) => {
      if (toolchain.name === 'node') {
        assertNoBundleImports(result.metafile, subject);
      }
    };

    const define = browserDefine(id, manifest.name, options.deploymentId);
    const storageInstall =
      (manifest.capabilities.frontend && manifest.app) ||
      (manifest.capabilities.widgets && manifest.widgets.length > 0)
        ? await storageInstallScript(id, esbuildResolve)
        : '';
    let bundledBackendEntry: string | undefined;

    // 3) Bundle the frontend SPA -> static app/app.js + index.html.
    if (manifest.capabilities.frontend && manifest.app) {
      const entry = path.join(src, manifest.app.entry);
      if (!(await pathExists(entry))) {
        throw new Error(`app entry not found: ${manifest.app.entry}`);
      }
      await fs.mkdir(path.join(out, 'app'), { recursive: true });
      const appBundle = await esbuild.build({
        ...esbuildResolve,
        entryPoints: [entry],
        outfile: path.join(out, 'app', 'app.js'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        jsx: 'automatic',
        minify: true,
        sourcemap: false,
        define,
        logLevel: 'silent',
      });
      assertSelfContained(appBundle, 'App bundle');
      const htmlRel = manifest.app.html ?? 'app/index.html';
      const htmlSrc = path.join(src, htmlRel);
      if (!(await pathExists(htmlSrc))) {
        throw new Error(`app html not found: ${htmlRel}`);
      }
      // Inline the bundle into index.html. The platform serves the app over an
      // extensionless HTML route; inlining avoids a separate .js asset request
      // (which dev middleware would intercept) and keeps the app a single doc.
      const code = await fs.readFile(path.join(out, 'app', 'app.js'), 'utf8');
      const inlined = `<script type="module">${code.replace(
        /<\/script>/g,
        '<\\/script>',
      )}</script>`;
      // Place the storage scope in the authored markup before inlining the
      // bundle, so a `<head>` inside bundled code can never be matched.
      let html = prependHeadScript(
        await fs.readFile(htmlSrc, 'utf8'),
        storageInstall,
      );
      const scriptTag =
        /<script[^>]*src=["']\.?\/?app\.js["'][^>]*>\s*<\/script>/;
      // Use a replacement function so `$`-sequences in the bundle (e.g. React's
      // "$&/") are inserted literally instead of being treated as replacement
      // patterns by String.prototype.replace.
      html = scriptTag.test(html)
        ? html.replace(scriptTag, () => inlined)
        : html.replace('</body>', () => `${inlined}\n</body>`);
      await fs.writeFile(path.join(out, 'app', 'index.html'), html, 'utf8');
      logs.push('bundled app -> inlined into app/index.html');
    }

    // 4) Bundle each widget -> standalone ESM module exporting mount().
    if (manifest.capabilities.widgets && manifest.widgets.length > 0) {
      await fs.mkdir(path.join(out, 'widgets'), { recursive: true });
      for (const widget of manifest.widgets) {
        const entry = path.join(src, widget.entry);
        if (!(await pathExists(entry))) {
          throw new Error(`widget entry not found: ${widget.entry}`);
        }
        const widgetBundle = await esbuild.build({
          ...esbuildResolve,
          entryPoints: [entry],
          outfile: path.join(out, 'widgets', `${widget.id}.js`),
          // Runs before the widget's modules: each widget has its own frame.
          banner: { js: storageInstall },
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2022',
          jsx: 'automatic',
          minify: true,
          sourcemap: false,
          define,
          logLevel: 'silent',
        });
        assertSelfContained(widgetBundle, `Widget ${widget.id} bundle`);
        logs.push(`bundled widget ${widget.id} -> widgets/${widget.id}.js`);
      }
    }

    // 5) Bundle the backend, generated stubs, and npm dependencies into one
    // runtime entry. Source files and dependency manifests remain build inputs;
    // only files below the fixed backend/assets directory enter the artifact.
    if (manifest.capabilities.backend && manifest.backend) {
      await copyBackendAssets(src, out);
      await validateBackendBundleSourceTree(src);

      const sourceEntry = manifest.backend.entry;
      bundledBackendEntry = backendBundleEntry(sourceEntry);
      const bundlePath = path.join(out, bundledBackendEntry);
      await fs.mkdir(path.dirname(bundlePath), { recursive: true });
      await toolchain.bundle({
        entry: sourceEntry,
        outfile: bundlePath,
        outputRoot: out,
      });
      logs.push(`bundled backend -> ${bundledBackendEntry}`);
    }

    const normalized = normalizeManifest(manifest);
    if (bundledBackendEntry && normalized.backend) {
      normalized.backend = {
        ...normalized.backend,
        entry: bundledBackendEntry,
        format: 'bundle-v1',
      };
    }
    if (api) normalized.api = api;
    if (tasks) {
      normalized.tasks = tasks;
      logs.push(
        `captured ${normalized.tasks.definitions.length} task input schema(s)`,
      );
    }
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

    return {
      source: manifest,
      normalized,
      dataSchema,
      log: logs.join('\n'),
    };
  } finally {
    await fs.rm(tempSrc, { recursive: true, force: true });
  }
}
