/** How the platform process runs toolchain commands during a deploy build. */
import path from 'node:path';
import { REPO_ROOT } from '../agent/paths';
import { subprocessSandboxEnv } from '../server/sandbox-env';
import { run } from '../server/subprocess';
import type {
  SourceKind,
  SourceToolchainContext,
  ToolchainRunner,
} from '../source-toolchain';

const BIN_DIR = path.join(REPO_ROOT, 'node_modules', '.bin');
// The compiler the platform itself is built with; never one from a source.
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Every command gets the sanitized build environment, the shared time budget
 * and the output cap. `tsc` and `node` run on the platform's own Node binary.
 */
function platformToolchainRunner(
  kind: SourceKind,
  root: string,
): ToolchainRunner {
  return ({ tool, args, step, cwd, input, timeoutMs, env }) => {
    const base = subprocessSandboxEnv(env);
    const [command, prefix] =
      tool === 'tsc'
        ? [process.execPath, [TSC]]
        : tool === 'node'
          ? [process.execPath, []]
          : [tool, []];
    return run(command, [...prefix, ...args], {
      cwd: cwd ?? root,
      // App build steps have always seen the platform's node_modules/.bin;
      // manifest evaluation and Workflow builds never did.
      env:
        kind === 'app' && step !== 'manifest'
          ? { ...base, PATH: `${BIN_DIR}:${base.PATH ?? ''}` }
          : base,
      input,
      timeoutMs,
    });
  };
}

/** Toolchain context for a deploy build of the disposable copy at `root`. */
export function platformToolchainContext(
  kind: SourceKind,
  root: string,
  logs: string[],
): SourceToolchainContext {
  return {
    root,
    kind,
    logs,
    run: platformToolchainRunner(kind, root),
    // Set in the image so installs share one store on the cache volume.
    pnpmStoreDir: process.env.HATCH_PNPM_STORE_DIR || undefined,
    requireNetworkIsolation: process.env.NODE_ENV === 'production',
  };
}
