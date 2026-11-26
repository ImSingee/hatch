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

/**
 * Where a sandboxed toolchain keeps its own state. Both directories must be
 * owned by the sandbox identity while it runs.
 */
export type ToolchainSandbox = {
  /** HOME and XDG roots of every command. */
  home: string;
  /** A pnpm store of its own, never the shared one. */
  pnpmStoreDir: string;
};

/**
 * The home and XDG roots of a sandboxed tool, all below `sandbox.home`,
 * which the sandbox identity owns: no tool reads or writes the host user's
 * own configuration or caches.
 */
export function toolchainSandboxHome(
  sandbox: ToolchainSandbox,
): Record<string, string> {
  return {
    HOME: sandbox.home,
    XDG_CONFIG_HOME: `${sandbox.home}/config`,
    XDG_CACHE_HOME: `${sandbox.home}/cache`,
    XDG_DATA_HOME: `${sandbox.home}/data`,
    XDG_STATE_HOME: `${sandbox.home}/state`,
    DENO_DIR: `${sandbox.home}/deno`,
  };
}

/**
 * Every command gets the sanitized build environment, the shared time budget
 * and the output cap. `tsc` runs on the platform's own Node binary, and so
 * does `node`, which evaluates authored code under the sandbox identity.
 */
function platformToolchainRunner(
  root: string,
  signal?: AbortSignal,
  sandbox?: ToolchainSandbox,
): ToolchainRunner {
  return async ({ tool, args, step, cwd, input, timeoutMs, env }) => {
    // Sandboxed, every tool gets its own home and an empty configuration,
    // all below `sandbox.home`, which the sandbox identity owns.
    const base = subprocessSandboxEnv(
      sandbox ? { ...env, ...toolchainSandboxHome(sandbox) } : env,
    );
    const argv: [string, ...string[]] =
      tool === 'tsc'
        ? [process.execPath, TSC, ...args]
        : tool === 'node'
          ? [process.execPath, ...args]
          : [tool, ...args];
    const [command, commandArgs] =
      sandbox || tool === 'node'
        ? sandboxedEvaluationCommand(argv)
        : [argv[0], argv.slice(1)];
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
      signal,
    });
  };
}

/** Toolchain context for a deploy build of the disposable copy at `root`. */
export function platformToolchainContext(
  root: string,
  logs: string[],
  /** Stops every command it runs (each in its own process group). */
  signal?: AbortSignal,
  /** Runs every command, installs included, under the sandbox identity. */
  sandbox?: ToolchainSandbox,
): SourceToolchainContext {
  return {
    root,
    logs,
    run: platformToolchainRunner(root, signal, sandbox),
    // Set in the image so installs share one store on the cache volume; a
    // sandboxed toolchain never writes to it.
    pnpmStoreDir: sandbox
      ? sandbox.pnpmStoreDir
      : process.env.HATCH_PNPM_STORE_DIR || undefined,
  };
}
