/**
 * Server-only: the platform's package signing tool, `hatch-nshpkg`
 * (packages/hatch-nshpkg, built on the `nsh-package` crate of the pinned NSH
 * release). It extracts a build's package input and repacks it with an
 * activation's build number; see docs/app-native-runtime.md.
 *
 * Secret keys are passed to it as file paths, never in arguments or the
 * environment, and it never prints them.
 */
import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '~agent/paths';
import { NSH_VERSION } from './nsh-toolchain';

/** Where a native deployment's artifact keeps its unsigned package input. */
export const NATIVE_PACKAGE_INPUT_DIR = 'native-package';

const INSTALL_HINT =
  'Build it with `pnpm nshpkg:build` (needs Rust 1.97 or newer), or set ' +
  'HATCH_NSHPKG_BIN to its path. The published Docker image ships it.';

/** How long one call may run (a package is at most a few hundred MB). */
const CALL_TIMEOUT_MS = 120_000;

export class NshpkgUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NshpkgUnavailableError';
  }
}

/** The tool refused its input (exit 3): a bad package or a mismatch. */
export class NshpkgRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NshpkgRefusedError';
  }
}

function candidates(): string[] {
  const configured = process.env.HATCH_NSHPKG_BIN?.trim();
  if (configured) return [path.resolve(configured)];
  return [path.join(REPO_ROOT, 'bin', 'hatch-nshpkg')];
}

let resolved: string | undefined;

/** The absolute path of a `hatch-nshpkg` built for the pinned NSH release. */
export function nshpkgBinary(): string {
  if (resolved) return resolved;
  const seen: string[] = [];
  for (const file of candidates()) {
    try {
      accessSync(file, fsConstants.X_OK);
    } catch {
      seen.push(`${file} (missing)`);
      continue;
    }
    const probe = spawnSync(file, ['version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    let version: string | undefined;
    try {
      version = (JSON.parse(probe.stdout ?? '') as { nshPackage?: string })
        .nshPackage;
    } catch {
      version = undefined;
    }
    if (probe.status === 0 && version === NSH_VERSION) {
      resolved = file;
      return file;
    }
    seen.push(`${file} (${version ? `nsh-package ${version}` : 'unusable'})`);
  }
  throw new NshpkgUnavailableError(
    `Native App packages need hatch-nshpkg for nsh ${NSH_VERSION}; found ` +
      `${seen.join(', ')}. ${INSTALL_HINT}`,
  );
}

/** Forget the resolved binary (tests change HATCH_NSHPKG_BIN). */
export function resetNshpkgBinary(): void {
  resolved = undefined;
}

/**
 * Run one `hatch-nshpkg` command and return its JSON result. Throws
 * `NshpkgRefusedError` when it refuses the input.
 */
export function runNshpkg<T>(args: string[]): Promise<T> {
  const binary = nshpkgBinary();
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        encoding: 'utf8',
        timeout: CALL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '' },
      },
      (error, stdout) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = undefined;
        }
        const failure = (
          parsed as { error?: { code: string; message: string } }
        )?.error;
        if (!error && parsed && !failure) {
          resolve(parsed as T);
          return;
        }
        const exit = (error as { code?: unknown } | null)?.code;
        if (exit === 3 && failure) {
          reject(new NshpkgRefusedError(failure.code, failure.message));
          return;
        }
        reject(
          new Error(
            `hatch-nshpkg ${args[0]} failed: ${
              failure?.message ?? error?.message ?? 'no result'
            }`,
          ),
        );
      },
    );
  });
}
