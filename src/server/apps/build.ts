/**
 * Server-only: build App source into a deployment artifact on this host, the
 * way the dedicated Builder does (src/app-build/produce.ts with the image's
 * tools), then accept the package like any other (./finalize.ts). The
 * platform never calls this for a deployment; it is the end-to-end build
 * the build tests run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BUILD_WORK_DIR, appBuildDir, appSrcDir } from '~agent/paths';
import { buildAppSource } from '../../app-build/produce';
import { AppError } from '../errors';
import { platformBuildHost } from './build-host';
import {
  BuildPackageError,
  finalizeBuild,
  type FinalizedBuild,
} from './finalize';

export type BuildResult = Omit<FinalizedBuild, 'tooling'>;

/**
 * A failed build: source validation, codegen, a deploy check or bundling.
 * Nothing has been released when it is thrown, so callers report it as a
 * definite rejection with its message (files and lines for the author)
 * instead of an internal failure with an unknown outcome.
 */
export class AppBuildError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 400);
    this.name = 'AppBuildError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export type BuildAppOptions = {
  sourceDir?: string;
  outputDir?: string;
  deploymentId?: string;
};

/** Report any failure that is not the host's own as a build rejection. */
export function asBuildError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  // A failed system call (disk full, permissions) is the platform's
  // problem, not the source's: it stays an internal error, and its message
  // (which names server paths) does not reach the caller.
  if (isSystemError(error) && !(error instanceof BuildPackageError)) {
    return error;
  }
  return new AppBuildError(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

/**
 * The SDK digest of a build this host makes and accepts itself. It runs the
 * platform's own SDK, so there is no delivery to compare it with; packages
 * from elsewhere are checked against `platformSdkDigest()`.
 */
const HOST_BUILD_SDK_DIGEST = createHash('sha256')
  .update('hatch-host-build')
  .digest('hex');

export async function buildApp(
  id: string,
  options: BuildAppOptions = {},
): Promise<BuildResult> {
  const work = path.join(BUILD_WORK_DIR, id, randomUUID());
  const packageDir = `${work}-package`;
  const stage = `${work}-out`;
  const deploymentId = options.deploymentId ?? '';
  await fs.mkdir(path.dirname(work), { recursive: true });
  const host = platformBuildHost({ sdkDigest: HOST_BUILD_SDK_DIGEST });
  try {
    await buildAppSource(host, {
      appId: id,
      deploymentId,
      commit: null,
      sourceDir: options.sourceDir ?? appSrcDir(id),
      outDir: packageDir,
    });
    const { tooling: _tooling, ...result } = await finalizeBuild({
      packageDir,
      outDir: stage,
      appId: id,
      deploymentId,
      commit: null,
      tooling: host.tooling,
      // The platform built it itself.
      trustBytecode: true,
    });
    // Deploy builds use a fresh path, while direct callers do not lose a
    // prior output when a check or a later step fails.
    await replaceDirectory(stage, options.outputDir ?? appBuildDir(id));
    return result;
  } catch (error) {
    throw asBuildError(error);
  } finally {
    // Each removal on its own; a failed one never replaces the result.
    for (const dir of [packageDir, stage]) {
      await fs.rm(dir, { recursive: true, force: true }).catch((cleanup) => {
        console.error(`[apps] could not remove ${dir}:`, cleanup);
      });
    }
  }
}

function isSystemError(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException | null;
  return (
    typeof failure?.code === 'string' &&
    typeof failure.syscall === 'string' &&
    typeof failure.errno === 'number'
  );
}

type DirectoryIo = Pick<typeof fs, 'cp' | 'mkdir' | 'rename' | 'rm'>;

/**
 * Replace `target` with the finished `staged` directory. The previous output
 * stays in place until the new one is complete beside it, and is put back if
 * the swap fails, so a failure never leaves a partial output.
 */
export async function replaceDirectory(
  staged: string,
  target: string,
  io: DirectoryIo = fs,
): Promise<void> {
  const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
  const discard = (dir: string) =>
    io.rm(dir, { recursive: true, force: true }).catch(() => {});
  await io.mkdir(path.dirname(target), { recursive: true });
  // 1) The new output, complete, next to the target (same filesystem).
  const incoming = `${target}.incoming-${randomUUID()}`;
  try {
    await io.rename(staged, incoming);
  } catch (error) {
    if (code(error) !== 'EXDEV') throw error;
    try {
      await io.cp(staged, incoming, { recursive: true });
    } catch (copyError) {
      await discard(incoming);
      throw copyError;
    }
  }
  // 2) Swap, keeping the previous output until the new one is in place.
  const previous = `${target}.previous-${randomUUID()}`;
  let hadPrevious = true;
  try {
    await io.rename(target, previous);
  } catch (error) {
    if (code(error) !== 'ENOENT') {
      await discard(incoming);
      throw error;
    }
    hadPrevious = false;
  }
  try {
    await io.rename(incoming, target);
  } catch (error) {
    await discard(incoming);
    if (!hadPrevious) throw error;
    try {
      await io.rename(previous, target);
    } catch (restoreError) {
      // Neither output is in place: say where the previous one was kept.
      // It stays a system error, so it is reported as an internal failure.
      const failure = error as NodeJS.ErrnoException;
      throw Object.assign(
        new Error(
          `Could not install the new build output (${failure.message}) ` +
            `or restore the previous one (${(restoreError as Error).message}); ` +
            `the previous output is kept at ${previous}.`,
          { cause: restoreError },
        ),
        { code: failure.code, errno: failure.errno, syscall: failure.syscall },
      );
    }
    throw error;
  }
  if (hadPrevious) await discard(previous);
}
