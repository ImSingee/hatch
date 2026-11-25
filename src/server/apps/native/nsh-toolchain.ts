/**
 * Server-only: the pinned Native Shell (NSH) CLI that builds `native` App
 * frontends. The platform runs exactly one NSH version; every native
 * deployment records it, and upgrading it is a deliberate change (see
 * docs/app-native-runtime.md).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, WORKSPACE_ROOT } from '~agent/paths';

/** The NSH release native Apps are built with and the web player serves. */
export const NSH_VERSION = '0.6.1';

/**
 * Release archives the Docker image installs, by SHA-256. Keep in sync with
 * the `nsh` stage of the Dockerfile when the pinned version changes.
 */
export const NSH_RELEASE_SHA256 = {
  'nsh-linux-x86_64.tar.gz':
    '9a7ac692f1c229df476be8ff83a3c5912d271453b644e313f02cb19d18696070',
  'nsh-linux-arm64.tar.gz':
    'd7d54b8a62aa8bd4a9fb73fcc0abce8cc565185926f226aa90f48622f3e410a3',
  'nsh-web.tar.gz':
    'e509e35fbad261a4a5e27a9225c364ff0d9ddd202a638b02bbfd13fb5cd1b9f1',
} as const;

export class NshToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NshToolchainError';
  }
}

const INSTALL_HINT =
  `Install NSH ${NSH_VERSION} with ` +
  `\`curl -fsSL https://nsh.dev/install.sh | NSH_VERSION=v${NSH_VERSION} sh\`, ` +
  'or set HATCH_NSH_BIN to the path of an nsh binary of that version. The ' +
  'published Docker image ships it.';

function executable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where to look for `nsh`, most specific first. */
function candidates(): string[] {
  const configured = process.env.HATCH_NSH_BIN?.trim();
  if (configured) return [path.resolve(configured)];
  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    // A relative PATH entry is read against this process's directory once,
    // so the cached binary path stays valid for builds run elsewhere.
    .map((dir) => path.resolve(dir, 'nsh'));
  const home = os.homedir();
  return [
    ...fromPath,
    path.join(home, '.local', 'bin', 'nsh'),
    path.join(home, '.nsh', 'bin', 'nsh'),
    '/opt/nsh/bin/nsh',
  ];
}

let resolved: string | undefined;

/**
 * The absolute path of the pinned `nsh`. Throws `NshToolchainError` naming
 * what was found and how to install the right version.
 */
export function nshBinary(): string {
  if (resolved) return resolved;
  const seen: string[] = [];
  for (const file of candidates()) {
    if (!executable(file)) continue;
    const probe = spawnSync(file, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (probe.error || probe.status !== 0) {
      // A wrapper that prints the right version but fails is not usable.
      seen.push(
        `${file} (--version failed: ${probe.error?.message ?? `exit ${probe.status ?? probe.signal}`})`,
      );
      continue;
    }
    const version = /^nsh (\S+)/.exec(probe.stdout ?? '')?.[1];
    if (version === NSH_VERSION) {
      resolved = file;
      return file;
    }
    seen.push(`${file} (${version ?? 'not an nsh binary'})`);
  }
  throw new NshToolchainError(
    `Native Apps need nsh ${NSH_VERSION}, ` +
      (seen.length
        ? `but found only ${seen.join(', ')}. `
        : 'but no nsh binary was found. ') +
      INSTALL_HINT,
  );
}

/** Forget the resolved binary (tests change HATCH_NSH_BIN). */
export function resetNshBinary(): void {
  resolved = undefined;
}

/** TypeScript the platform itself is built with; `nsh check` pins the same 7.x. */
const PLATFORM_TSC = path.join(
  REPO_ROOT,
  'node_modules',
  'typescript',
  'bin',
  'tsc',
);

/**
 * Environment for every `nsh` command. `nsh check` would otherwise download
 * TypeScript from npm at deploy time; the platform's own compiler is used
 * instead, and NSH's cache stays inside the platform data directory.
 */
export function nshEnv(): Record<string, string> {
  return {
    NSH_TSC: PLATFORM_TSC,
    NSH_CACHE: path.join(WORKSPACE_ROOT, 'cache', 'nsh'),
    NO_COLOR: '1',
  };
}
