/**
 * What a build of App source needs from the machine it runs on. The
 * dedicated Builder runs tools from its image under the sandbox identity;
 * the CLI runs the platform's pinned tools on the author's machine. Both
 * produce the same build package (./format.ts).
 */
import type { SourceToolchainContext } from '../source-toolchain';
import type { BuildTooling } from './format';

export type BuildHostRunResult = {
  code: number;
  /** stdout + stderr interleaved in arrival order. */
  output: string;
};

export type BuildHost = {
  /** Scratch directory for disposable copies; removed by the caller. */
  workDir: string;
  /** The toolchain context for the disposable source copy at `root`. */
  toolchainContext(root: string, logs: string[]): SourceToolchainContext;
  /** Run the pinned `buf` with the platform `protoc-gen-es` plugin on PATH. */
  runBuf(args: string[], cwd: string): Promise<BuildHostRunResult>;
  /** Write the platform SDK and import map into `root/.hatch/`. */
  materializeSdk(root: string): Promise<void>;
  /** Versions of the tools above, recorded in the package. */
  tooling(options: { native: boolean }): Promise<BuildTooling>;
  /** The pinned NSH CLI, for a native frontend. */
  nsh(): BuildNshHost;
  /**
   * Run the whole build of the disposable copy at `src` inside `task`, for
   * a host that hands the copy to the sandbox identity (the Builder).
   */
  withSource?<T>(src: string, task: () => Promise<T>): Promise<T>;
};

export type BuildNshHost = {
  version: string;
  /** Run `nsh <args>`; `sandboxed` runs App code (the start-up check). */
  run(
    args: string[],
    options: { cwd: string; sandboxed?: boolean; timeoutMs?: number },
  ): Promise<BuildHostRunResult>;
  /** Give the sandbox identity ownership of `targets` while `task` runs. */
  withSandboxOwnership<T>(
    targets: readonly string[],
    task: () => Promise<T>,
  ): Promise<T>;
};
