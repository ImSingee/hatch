/** How the platform process runs toolchain commands during a deploy build. */
import path from 'node:path';
import { REPO_ROOT } from '../agent/paths';
import { sandboxSpawn, sandboxSwitchesIdentity } from '../agent/shell-sandbox';
import { subprocessSandboxEnv } from '../server/sandbox-env';
import { run } from '../server/subprocess';
import type {
  SourceToolchainContext,
  ToolchainRunner,
} from '../source-toolchain';

const BIN_DIR = path.join(REPO_ROOT, 'node_modules', '.bin');
// The compiler the platform itself is built with; never one from a source.
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * The command that runs authored code on the platform (manifest and schema
 * evaluation, a native App's start-up check). Node's permission model does
 * not cover signals: a process with the platform's identity could stop it,
 * or send SIGUSR1 to open its inspector on the loopback interface. The
 * sandbox identity may signal neither, so production refuses to run authored
 * code without it unless the operator accepted unsandboxed subprocesses, the
 * switch the Agent Runner honors for the same risk.
 */
export function sandboxedEvaluationCommand(
  argv: [string, ...string[]],
): [string, string[]] {
  if (
    process.env.NODE_ENV === 'production' &&
    !sandboxSwitchesIdentity() &&
    process.env.HATCH_ALLOW_UNSANDBOXED !== 'true'
  ) {
    throw new Error(
      'Cannot run authored source: the platform cannot switch to ' +
        'the sandbox identity. Run it as root on Linux with setpriv, as the ' +
        'published image does, or set HATCH_ALLOW_UNSANDBOXED=true to accept ' +
        'that evaluated source can signal the platform process.',
    );
  }
  const spawned = sandboxSpawn(argv);
  return [spawned.command, spawned.args];
}

function evaluationCommand(args: string[]): [string, string[]] {
  return sandboxedEvaluationCommand([process.execPath, ...args]);
}

/**
 * Every command gets the sanitized build environment, the shared time budget
 * and the output cap. `tsc` runs on the platform's own Node binary, and so
 * does `node`, which evaluates authored code under the sandbox identity.
 */
function platformToolchainRunner(root: string): ToolchainRunner {
  return async ({ tool, args, step, cwd, input, timeoutMs, env }) => {
    const base = subprocessSandboxEnv(env);
    const [command, commandArgs] =
      tool === 'tsc'
        ? [process.execPath, [TSC, ...args]]
        : tool === 'node'
          ? evaluationCommand(args)
          : [tool, args];
    return run(command, commandArgs, {
      cwd: cwd ?? root,
      // Build steps see the platform's node_modules/.bin; manifest
      // evaluation never does.
      env:
        step !== 'manifest'
          ? { ...base, PATH: `${BIN_DIR}:${base.PATH ?? ''}` }
          : base,
      input,
      timeoutMs,
    });
  };
}

/** Toolchain context for a deploy build of the disposable copy at `root`. */
export function platformToolchainContext(
  root: string,
  logs: string[],
): SourceToolchainContext {
  return {
    root,
    logs,
    run: platformToolchainRunner(root),
    // Set in the image so installs share one store on the cache volume.
    pnpmStoreDir: process.env.HATCH_PNPM_STORE_DIR || undefined,
  };
}
