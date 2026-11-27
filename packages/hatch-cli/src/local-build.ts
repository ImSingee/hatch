/**
 * Build a pushed commit on this machine for one deployment: export the
 * commit, run the build driver with the platform's pinned toolchain and pack
 * the build package for upload.
 */
import { spawn, spawnSync } from 'node:child_process';
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
import {
  CommitCheckoutError,
  checkoutCommit,
} from '../../../src/app-build/checkout';
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
  signal: AbortSignal,
  remaining: () => number,
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
  // The build also needs the platform's pnpm: in that node_modules or on
  // PATH (the image installs it globally). Otherwise the cache, which
  // installs it, is used instead.
  const bundled = await readFile(
    path.join(modules, 'pnpm', 'package.json'),
    'utf8',
  )
    .then((text) => (JSON.parse(text) as { version?: string }).version)
    .catch(() => undefined);
  if (bundled === tooling.pnpmVersion) return modules;
  // A pnpm that cannot be found, run or asked in time is only a miss: the
  // cache may still hold the toolchain with its own pnpm.
  const env = childEnvironment();
  const version = await pnpmInvocation(process.platform, env)
    .then((pnpm) =>
      command(
        pnpm.executable,
        [...pnpm.prefix, '--version'],
        // Not inside any project: a `packageManager` field there would make
        // pnpm switch versions and report one the build would not run.
        os.tmpdir(),
        signal,
        true,
        {
          env,
          timeoutMs: Math.min(PNPM_PROBE_TIMEOUT_MS, remaining()),
        },
      ),
    )
    .then(
      (probe) => (probe.code === 0 ? probe.stdout.trim() : null),
      (error: unknown) => {
        // Cancellation and the build's own deadline still end the build.
        if (
          signal.aborted ||
          (error instanceof CliError && error.code === 'local_build_timeout')
        )
          throw error;
        return null;
      },
    );
  return version === tooling.pnpmVersion ? modules : null;
}

/** How long the installed toolchain's pnpm has to report its version. */
const PNPM_PROBE_TIMEOUT_MS = 30_000;

/**
 * Remove a scratch directory without letting a failure replace the build's
 * own result or error: a file still locked only leaves the directory behind.
 */
async function removeScratch(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => {
    process.stderr.write(
      `Could not remove the temporary directory ${directory}; remove it by hand.\n`,
    );
  });
}

/**
 * node_modules with the platform's exact esbuild, TypeScript, buf,
 * protoc-gen-es and pnpm: an installed one, or a cache installed once per
 * version set.
 */
async function ensureToolchain(
  tooling: LocalBuildTooling,
  signal: AbortSignal,
  remaining: () => number,
): Promise<string> {
  const installed = await installedToolchain(tooling, signal, remaining);
  if (installed) return installed;
  // The cache also carries the platform's pnpm, which the build then uses
  // for App dependencies whatever pnpm this machine has.
  const dependencies = {
    ...toolchainDependencies(tooling),
    pnpm: tooling.pnpmVersion,
  };
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
    // buf's platform binary needs no script, and pnpm runs from its
    // bin/pnpm.mjs without one.
    await writeFile(
      path.join(stage, 'pnpm-workspace.yaml'),
      "allowBuilds:\n  esbuild: true\n  '@bufbuild/buf': false\n  pnpm: false\n",
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
        {
          env: { ...env, XDG_CONFIG_HOME: configHome },
          // What the probe and the setup above left of the build's budget.
          timeoutMs: remaining(),
        },
      );
      if (installed.code !== 0)
        throw new CliError(
          'tool_unavailable',
          `Could not install the build toolchain with pnpm:\n${installed.stderr.trim()}`,
          7,
        );
    } finally {
      await removeScratch(configHome);
    }
    await writeFile(path.join(stage, '.ready'), '');
    // Publish by one atomic rename of the complete install, never replacing
    // a directory: another CLI may already be building from the one it
    // published, which this install then reuses.
    await rename(stage, directory).catch(async (error) => {
      if (
        await access(ready)
          .then(() => true)
          .catch(() => false)
      )
        return;
      throw new CliError(
        'tool_unavailable',
        `Could not publish the build toolchain cache at ${directory} ` +
          `(${(error as Error).message}); remove that directory and retry.`,
        7,
      );
    });
    return path.join(directory, 'node_modules');
  } finally {
    await removeScratch(stage);
  }
}

/**
 * Check out `commit` from the workspace repository into `target`, as the
 * Builder gets it (src/app-build/checkout.ts): every tracked file, whatever
 * archive-only attributes say.
 */
async function exportCommit(
  root: string,
  commit: string,
  target: string,
  signal: AbortSignal,
  timeoutMs: number,
  timedOut: () => CliError,
): Promise<void> {
  // Git stops with the build: on cancellation and once its budget is spent.
  const budget = AbortSignal.timeout(timeoutMs);
  try {
    await checkoutCommit({
      repo: { cwd: root },
      commit,
      target,
      env: childEnvironment(),
      signal: AbortSignal.any([signal, budget]),
    });
  } catch (error) {
    if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
    if (budget.aborted) throw timedOut();
    if (error instanceof CommitCheckoutError && error.missingCommit)
      throw new CliError(
        'source_unavailable',
        `Commit ${commit} is not in this checkout. Run hatch app update first.`,
        6,
      );
    throw new CliError(
      'tool_unavailable',
      `Could not check out the source: ${(error as Error).message}`,
      7,
    );
  }
}

/** How long the driver has to stop its tools before it is killed. */
const DRIVER_STOP_GRACE_MS = 10_000;

/** Kill a process and everything it started. */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already stopped */
  }
}

/**
 * Run the driver, forwarding its build output to stderr. Cancellation and
 * the timeout ask it to stop (it stops the tools it started, each in its own
 * process group), then kill what is left; the caller removes the work
 * directory only once the driver has exited.
 */
function runDriver(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  timedOut: () => CliError,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  if (signal.aborted)
    return Promise.reject(new CliError('cancelled', 'Cancelled.', 130));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stopped: 'cancelled' | 'timeout' | null = null;
    let forced: NodeJS.Timeout | undefined;
    const stop = (reason: 'cancelled' | 'timeout') => {
      if (stopped || !child.pid) return;
      stopped = reason;
      if (process.platform === 'win32') {
        // No signals to handle on Windows: end the whole tree now.
        killTree(child.pid);
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* already stopped */
      }
      forced = setTimeout(() => killTree(child.pid!), DRIVER_STOP_GRACE_MS);
    };
    const onAbort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => (stdout += data));
    child.once('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        new CliError(
          'tool_unavailable',
          `Could not start the local build: ${error.message}`,
          7,
        ),
      );
    });
    child.once('close', () => {
      clearTimeout(timer);
      clearTimeout(forced);
      signal.removeEventListener('abort', onAbort);
      // Whatever the driver's group still holds goes with it.
      if (process.platform !== 'win32' && child.pid) killTree(child.pid);
      if (stopped === 'cancelled') {
        reject(new CliError('cancelled', 'Cancelled.', 130));
        return;
      }
      if (stopped === 'timeout') {
        reject(timedOut());
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
  // One budget for the whole build: the toolchain install, the source
  // checkout and the driver each get only what is left of it.
  const deadline = Date.now() + timeoutMs;
  const timedOut = () =>
    new CliError(
      'local_build_timeout',
      `The local build did not finish within ${Math.round(timeoutMs / 1000)}s; raise --timeout, or leave out --local to build on the platform Builder.`,
      7,
    );
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw timedOut();
    return left;
  };
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
      const modules = await ensureToolchain(
        input.tooling,
        signal,
        remaining,
      ).catch((error: unknown) => {
        // An install cut off by the budget is the build running out of time.
        if (Date.now() >= deadline) throw timedOut();
        throw error;
      });
      await symlink(
        modules,
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
    await exportCommit(
      input.root,
      input.commit,
      source,
      signal,
      remaining(),
      timedOut,
    );
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
      remaining(),
      timedOut,
    );
    if (result.code === 'APP_MANIFEST_INVALID')
      // The same rejection, message and exit status as the platform's.
      throw new CliError(
        'APP_MANIFEST_INVALID',
        result.message ?? 'The App manifest is invalid.',
        2,
      );
    if (!result.ok) {
      // A missing or mismatched tool is this machine's to fix (exit 7); a
      // source the build rejects is an input error (exit 2).
      const tool =
        result.code === 'nsh_unavailable' || result.code === 'tool_unavailable';
      throw new CliError(
        tool ? (result.code as string) : 'app_build_failed',
        `The local build failed: ${result.message ?? 'unknown error'}`,
        tool ? 7 : 2,
      );
    }
    const archive = await packBuildDirectory(outDir);
    // A package packed after the deadline is as late as a build that is.
    remaining();
    return archive;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'app_build_failed',
      `The local build failed: ${error instanceof Error ? error.message : String(error)}`,
      6,
    );
  } finally {
    await removeScratch(work);
  }
}
