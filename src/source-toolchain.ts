/**
 * Build toolchain selection for authored App and Workflow source.
 *
 * The toolchain is chosen from committed dependency files before anything is
 * evaluated, and is independent of the runtime a manifest declares. This file
 * has no server imports: the platform, the Agent Runner, and the CLI all call
 * it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ManifestFile, ManifestReader } from './source-manifest';

export type SourceToolchainName = 'deno' | 'node';
export type SourceKind = 'app' | 'workflow';

export const PNPM_LOCKFILE = 'pnpm-lock.yaml';
const DENO_FILES = ['deno.json', 'deno.lock'] as const;

export type SourceToolchainFile =
  | typeof PNPM_LOCKFILE
  | (typeof DENO_FILES)[number];
export type SourceToolchainReader = (
  file: SourceToolchainFile,
) => Promise<string | null>;

/** Read a root dependency file, treating a missing file as absent. */
export function sourceToolchainReader(root: string): SourceToolchainReader {
  return async (file) => {
    try {
      return await fs.readFile(path.join(root, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
}

/**
 * Select the build toolchain from the dependency files at the source root.
 *
 * | Root contains                                   | Result |
 * | ----------------------------------------------- | ------ |
 * | `pnpm-lock.yaml`, no `deno.json` / `deno.lock`  | node   |
 * | `deno.json` or `deno.lock`, no `pnpm-lock.yaml` | deno   |
 * | both families, or neither                       | reject |
 *
 * An incomplete Deno source still selects `deno`, so the Deno dependency
 * validator keeps reporting which of its files is missing.
 */
export async function detectSourceToolchain(
  reader: SourceToolchainReader,
): Promise<SourceToolchainName> {
  const [pnpmLock, ...deno] = await Promise.all([
    reader(PNPM_LOCKFILE),
    ...DENO_FILES.map((file) => reader(file)),
  ]);
  const denoFiles = DENO_FILES.filter((_, index) => deno[index] !== null);
  if (pnpmLock !== null && denoFiles.length > 0) {
    throw new Error(
      `Source mixes two build toolchains: ${PNPM_LOCKFILE} and ` +
        `${denoFiles.join(' and ')}. Remove ${denoFiles.join(' and ')} to ` +
        `build with pnpm, or remove ${PNPM_LOCKFILE} to keep building with ` +
        'Deno.',
    );
  }
  if (pnpmLock !== null) return 'node';
  if (denoFiles.length > 0) return 'deno';
  throw new Error(
    `Source has no dependency lockfile. Commit package.json and ` +
      `${PNPM_LOCKFILE}: run \`pnpm install --ignore-workspace ` +
      '--ignore-scripts` in the source root.',
  );
}

export type ToolchainRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr in arrival order. */
  output: string;
};

export type ToolchainStep =
  | 'install'
  | 'manifest'
  | 'check'
  | 'describe'
  | 'bundle';

export type ToolchainCommand = {
  tool: 'deno' | 'pnpm' | 'tsc' | 'node';
  args: string[];
  /** Lets a host choose the environment, time budget and error stage. */
  step: ToolchainStep;
  /** Defaults to the source root. */
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  /** Added to the host's sanitized environment. */
  env?: Record<string, string>;
};

/**
 * How a host runs a toolchain command. The platform returns failures as a
 * result; the Runner throws its own staged preparation error instead.
 */
export type ToolchainRunner = (
  command: ToolchainCommand,
) => Promise<ToolchainRunResult>;

export type SourceToolchainContext = {
  root: string;
  kind: SourceKind;
  run: ToolchainRunner;
  /** Reads authored files; defaults to a no-follow read below the root. */
  read?: ManifestReader;
  /** True when dependency files must be read through `read`. */
  readDependenciesThroughReader?: boolean;
  logs?: string[];
  evaluationTimeoutMs?: number;
  /** Shared pnpm store; pnpm's per-user default when omitted. */
  pnpmStoreDir?: string;
  /**
   * Where manifest and schema evaluation must be network-isolated. Node only
   * denies network from the version that has `--allow-net`; older versions
   * are refused when this is set and merely reported otherwise.
   */
  requireNetworkIsolation?: boolean;
};

/** One build pipeline. Selected by `detectSourceToolchain`. */
export interface SourceToolchain {
  readonly name: SourceToolchainName;
  /** Reject dependency files the pipeline must not act on. */
  validateDependencies(): Promise<void>;
  /** Reproduce `node_modules` from the committed lockfile. */
  install(): Promise<void>;
  /** Check, bundle and evaluate `manifest.ts` without host access. */
  evaluateManifest<T>(
    parse: (raw: unknown) => T,
  ): Promise<{ manifest: T; file: ManifestFile }>;
  /**
   * Type-check authored entries. `fetchContract` names a backend entry whose
   * default export must satisfy `Deno.ServeDefaultExport`.
   */
  check(options: { entries: string[]; fetchContract?: string }): Promise<void>;
  /** Evaluate `data/schema.ts` and return its descriptor as JSON text. */
  describe(): Promise<string>;
  /**
   * Bundle a backend or Workflow entry (relative to the source root) into the
   * single runtime file `outfile`, somewhere below `outputRoot`.
   */
  bundle(options: {
    entry: string;
    outfile: string;
    outputRoot: string;
  }): Promise<void>;
}
