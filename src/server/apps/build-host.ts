/**
 * The build host of the platform image, used by the dedicated Builder: tools
 * from the image's own install, every command with the sanitized build
 * environment, and authored code under the sandbox identity.
 */
import path from 'node:path';
import { BUILD_WORK_DIR, REPO_ROOT } from '~agent/paths';
import { materializeAppHatchSdk } from '~agent/hatch-sdk';
import { withSandboxOwnership } from '~agent/shell-sandbox';
import type { BuildHost } from '../../app-build/host';
import {
  platformToolchainContext,
  sandboxedEvaluationCommand,
  type ToolchainSandbox,
} from '../../toolchain/platform';
import { platformTooling } from '../platform-tooling';
import { subprocessSandboxEnv } from '../sandbox-env';
import { run } from '../subprocess';
import { nshBinary, nshEnv, NSH_VERSION } from './native/nsh-toolchain';

const BIN_DIR = path.join(REPO_ROOT, 'node_modules', '.bin');

export function platformBuildHost(options: {
  /** Digest of the SDK delivery the platform expects (`GetSdk` files). */
  sdkDigest: string;
  workDir?: string;
  /** Stops every tool the build runs (a Builder job being stopped). */
  signal?: AbortSignal;
  /** Runs every toolchain command, installs included, sandboxed. */
  sandbox?: ToolchainSandbox;
}): BuildHost {
  const { signal, sandbox } = options;
  return {
    workDir: options.workDir ?? BUILD_WORK_DIR,
    toolchainContext: (root, logs) =>
      platformToolchainContext(root, logs, signal, sandbox),
    async runBuf(args, cwd) {
      // The platform's node_modules/.bin lets buf resolve protoc-gen-es.
      const env = subprocessSandboxEnv();
      // Sandboxed, buf runs as the sandbox identity like every other tool.
      const [command, commandArgs] = sandbox
        ? sandboxedEvaluationCommand(['buf', ...args])
        : ['buf', args];
      return run(command, commandArgs, {
        cwd,
        env: { ...env, PATH: `${BIN_DIR}:${env.PATH ?? ''}` },
        signal,
      });
    },
    materializeSdk: materializeAppHatchSdk,
    async tooling({ native }) {
      const tooling = platformTooling();
      return {
        typescript: tooling.typescriptVersion,
        esbuild: tooling.esbuildVersion,
        pnpm: tooling.pnpmVersion,
        buf: tooling.bufVersion,
        protocGenEs: tooling.protocGenEsVersion,
        nsh: native ? NSH_VERSION : null,
        sdk: options.sdkDigest,
      };
    },
    nsh() {
      const binary = nshBinary();
      // Sandboxed, NSH's cache is the sandbox's own too.
      const env = subprocessSandboxEnv({
        ...nshEnv(),
        ...(sandbox
          ? { NSH_CACHE: `${sandbox.home}/nsh`, HOME: sandbox.home }
          : {}),
      });
      return {
        version: NSH_VERSION,
        run(args, { cwd, sandboxed, timeoutMs }) {
          // A sandboxed host runs every nsh step as the sandbox identity, not
          // only the start-up check.
          const [command, commandArgs] =
            sandboxed || sandbox
              ? sandboxedEvaluationCommand([binary, ...args])
              : [binary, args];
          return run(command, commandArgs, { cwd, env, timeoutMs, signal });
        },
        withSandboxOwnership,
      };
    },
  };
}
