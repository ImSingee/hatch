/**
 * Build a pushed commit on this machine for one deployment: export the
 * commit, run the build driver with the platform's pinned toolchain and pack
 * the build package for upload.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packBuildDirectory } from '../../../src/app-build/archive';
import { CliError } from './error';
import { pnpmInvocation } from './pnpm';
import { childEnvironment, command } from './process';

export type LocalBuildTooling = {
  typescriptVersion: string;
  esbuildVersion: string;
  pnpmVersion: string;
  bufVersion: string;
  protocGenEsVersion: string;
  nshVersion?: string;
};

/** The platform's pinned tools from `GetSdk`; rejects an older platform. */
export function localBuildTooling(tooling?: {
  typescriptVersion?: string;
  esbuildVersion?: string;
  pnpmVersion?: string;
  bufVersion: string;
  protocGenEsVersion: string;
  nshVersion?: string;
}): LocalBuildTooling {
  if (
    !tooling?.typescriptVersion ||
    !tooling.esbuildVersion ||
    !tooling.pnpmVersion
  )
    throw new CliError(
      'toolchain_mismatch',
      'This platform does not publish its build toolchain. Upgrade the platform.',
      6,
    );
  return tooling as LocalBuildTooling;
}

/** Running from source (`pnpm cli`) rather than the packed CLI. */
const sourceMode = import.meta.url.endsWith('.ts');

function cacheRoot(): string {
  const base =
    process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(base, 'hatch');
}

function toolchainDependencies(tooling: LocalBuildTooling) {
  return {
    esbuild: tooling.esbuildVersion,
    typescript: tooling.typescriptVersion,
    '@bufbuild/buf': tooling.bufVersion,
    '@bufbuild/protoc-gen-es': tooling.protocGenEsVersion,
  };
}

/**
 * A node_modules directory that already holds exactly these versions, such
 * as the platform image's own (HATCH_BUILD_TOOLCHAIN_DIR), so the Agent's
 * Runner builds without downloading anything.
 */
async function installedToolchain(
  tooling: LocalBuildTooling,
): Promise<string | null> {
  const root = process.env.HATCH_BUILD_TOOLCHAIN_DIR?.trim();
  if (!root) return null;
  const modules = path.join(root, 'node_modules');
  for (const [name, version] of Object.entries(
    toolchainDependencies(tooling),
  )) {
    const manifest = await readFile(
      path.join(modules, ...name.split('/'), 'package.json'),
      'utf8',
    )
      .then((text) => JSON.parse(text) as { version?: string })
      .catch(() => null);
    if (manifest?.version !== version) return null;
  }
  return modules;
}

/**
 * node_modules with the platform's exact esbuild, TypeScript, buf and
 * protoc-gen-es: an installed one, or a cache installed once per version set.
 */
async function ensureToolchain(
  tooling: LocalBuildTooling,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const installed = await installedToolchain(tooling);
  if (installed) return installed;
  const dependencies = toolchainDependencies(tooling);
  const key = createHash('sha256')
    .update(JSON.stringify(dependencies))
    .digest('hex')
    .slice(0, 16);
  const directory = path.join(cacheRoot(), 'toolchain', key);
  const ready = path.join(directory, '.ready');
  if (
    await access(ready)
      .then(() => true)
      .catch(() => false)
  )
    return path.join(directory, 'node_modules');
  await mkdir(path.dirname(directory), { recursive: true });
  const stage = await mkdtemp(`${directory}-install-`);
  try {
    await writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify({ private: true, type: 'module', dependencies }, null, 2),
    );
    // The platform's own build-script policy: esbuild verifies its binary,
    // buf's platform binary needs no script.
    await writeFile(
      path.join(stage, 'pnpm-workspace.yaml'),
      "allowBuilds:\n  esbuild: true\n  '@bufbuild/buf': false\n",
    );
    const env = childEnvironment();
    const pnpm = await pnpmInvocation(process.platform, env);
    const configHome = await mkdtemp(path.join(os.tmpdir(), 'hatch-pnpm-'));
    try {
      process.stderr.write(
        `Installing the build toolchain (esbuild ${tooling.esbuildVersion}, ` +
          `TypeScript ${tooling.typescriptVersion}, buf ${tooling.bufVersion})...\n`,
      );
      const installed = await command(
        pnpm.executable,
        [
          ...pnpm.prefix,
          'install',
          '--config.registry=https://registry.npmjs.org/',
          '--config.node-linker=hoisted',
          '--no-frozen-lockfile',
          '--prefer-offline',
        ],
        stage,
        signal,
        true,
        { env: { ...env, XDG_CONFIG_HOME: configHome }, timeoutMs },
      );
      if (installed.code !== 0)
        throw new CliError(
          'tool_unavailable',
          `Could not install the build toolchain with pnpm:\n${installed.stderr.trim()}`,
          7,
        );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
    await writeFile(path.join(stage, '.ready'), '');
    await rm(directory, { recursive: true, force: true });
    await rename(stage, directory).catch(async (error) => {
      // Another CLI finished the same install first.
      if (
        await access(ready)
          .then(() => true)
          .catch(() => false)
      )
        return;
      throw error;
    });
    return path.join(directory, 'node_modules');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Export `commit` from the workspace repository into `target`. */
async function exportCommit(
  root: string,
  commit: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  const archive = `${target}.tar`;
  const exported = await command(
    'git',
    ['archive', '--format=tar', '-o', archive, commit],
    root,
    signal,
    true,
  );
  if (exported.code !== 0)
    throw new CliError(
      'source_unavailable',
      `Commit ${commit} is not in this checkout. Run hatch app update first.`,
      6,
    );
  await mkdir(target);
  const unpacked = await command(
    'tar',
    ['-xf', archive, '-C', target],
    root,
    signal,
    true,
  );
  await rm(archive, { force: true });
  if (unpacked.code !== 0)
    throw new CliError(
      'tool_unavailable',
      `Could not unpack the source export: ${unpacked.stderr.trim()}`,
      7,
    );
}

/** Run the driver, forwarding its build output to stderr. */
function runDriver(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    timer.unref();
    signal.addEventListener('abort', kill, { once: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => (stdout += data));
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      if (signal.aborted) {
        reject(new CliError('cancelled', 'Cancelled.', 130));
        return;
      }
      const line = stdout.trim().split('\n').at(-1) ?? '';
      try {
        resolve(JSON.parse(line) as { ok: boolean });
      } catch {
        reject(
          new CliError(
            'app_build_failed',
            'The local build stopped without a result.',
            7,
          ),
        );
      }
    });
  });
}

export type LocalBuildInput = {
  root: string;
  appId: string;
  deploymentId: string;
  commit: string;
  sdkFiles: { path: string; contentBase64: string }[];
  tooling: LocalBuildTooling;
  signal: AbortSignal;
  timeoutMs: number;
};

/** Build `commit` for `deploymentId` and return the packed build package. */
export async function buildLocally(input: LocalBuildInput): Promise<Buffer> {
  const { signal, timeoutMs } = input;
  const work = await mkdtemp(path.join(os.tmpdir(), 'hatch-build-'));
  try {
    let toolchainDir: string;
    let driver: string;
    if (sourceMode) {
      toolchainDir = fileURLToPath(new URL('../../../', import.meta.url));
      driver = fileURLToPath(new URL('./build-driver.ts', import.meta.url));
    } else {
      // The driver resolves esbuild and TypeScript from node_modules next to
      // itself, here a link to the toolchain.
      toolchainDir = path.join(work, 'toolchain');
      await mkdir(toolchainDir);
      await symlink(
        await ensureToolchain(input.tooling, signal, timeoutMs),
        path.join(toolchainDir, 'node_modules'),
        'junction',
      );
      driver = path.join(toolchainDir, 'build-driver.mjs');
      await copyFile(
        fileURLToPath(new URL('./build-driver.mjs', import.meta.url)),
        driver,
      );
    }
    const source = path.join(work, 'source');
    await exportCommit(input.root, input.commit, source, signal);
    const sdkFiles = path.join(work, 'sdk-files.json');
    await writeFile(sdkFiles, JSON.stringify(input.sdkFiles));
    const request = path.join(work, 'request.json');
    const outDir = path.join(work, 'package');
    await writeFile(
      request,
      JSON.stringify({
        appId: input.appId,
        deploymentId: input.deploymentId,
        commit: input.commit,
        sourceDir: source,
        outDir,
        workDir: path.join(work, 'scratch'),
        sdkFiles,
        toolchainDir,
        tooling: {
          typescript: input.tooling.typescriptVersion,
          esbuild: input.tooling.esbuildVersion,
          pnpm: input.tooling.pnpmVersion,
          buf: input.tooling.bufVersion,
          protocGenEs: input.tooling.protocGenEsVersion,
          nsh: input.tooling.nshVersion || null,
        },
      }),
    );
    await mkdir(path.join(work, 'scratch'));
    const result = await runDriver(
      sourceMode ? ['--import', 'tsx', driver, request] : [driver, request],
      sourceMode ? toolchainDir : work,
      signal,
      timeoutMs,
    );
    if (result.code === 'APP_MANIFEST_INVALID')
      // The same rejection, message and exit status as the platform's.
      throw new CliError(
        'APP_MANIFEST_INVALID',
        result.message ?? 'The App manifest is invalid.',
        2,
      );
    if (!result.ok)
      throw new CliError(
        result.code === 'nsh_unavailable'
          ? 'nsh_unavailable'
          : 'app_build_failed',
        `The local build failed: ${result.message ?? 'unknown error'}`,
        // A source the build rejects is an input error (exit 2).
        result.code === 'nsh_unavailable' ? 7 : 2,
      );
    return await packBuildDirectory(outDir);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'app_build_failed',
      `The local build failed: ${error instanceof Error ? error.message : String(error)}`,
      6,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
