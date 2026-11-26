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
}): BuildHost {
  return {
    workDir: options.workDir ?? BUILD_WORK_DIR,
    toolchainContext: platformToolchainContext,
    async runBuf(args, cwd) {
      // The platform's node_modules/.bin lets buf resolve protoc-gen-es.
      const env = subprocessSandboxEnv();
      return run('buf', args, {
        cwd,
        env: { ...env, PATH: `${BIN_DIR}:${env.PATH ?? ''}` },
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
      const env = subprocessSandboxEnv(nshEnv());
      return {
        version: NSH_VERSION,
        run(args, { cwd, sandboxed, timeoutMs }) {
          const [command, commandArgs] = sandboxed
            ? sandboxedEvaluationCommand([binary, ...args])
            : [binary, args];
          return run(command, commandArgs, { cwd, env, timeoutMs });
        },
        withSandboxOwnership,
      };
    },
  };
}
