/**
 * Server-only: a minimal, allowlisted shell environment for the Agent's
 * {@link NodeExecutionEnv}.
 *
 * The execution env builds each command's environment as
 * `{ ...process.env, ...shellEnv, ...perCallEnv }`, so handing it an allowlist
 * alone would NOT drop the server's secrets — process.env is always the base.
 * Instead we explicitly set every NON-allowlisted process.env key to
 * `undefined`; Node's `spawn` omits env entries whose value is `undefined`, so
 * the spawned shell only ever sees allowlisted variables.
 *
 * This keeps deployment secrets (DATABASE_URL, SECRET, BETTER_AUTH_SECRET,
 * provider API keys, …) out of every command the model runs — including ones
 * injected via a malicious project file telling the agent to run `env`.
 *
 * The env allowlist does NOT stop a command from reading private files by path
 * (e.g. `cat <repo>/.env.local`); shell-sandbox.ts closes that gap on macOS
 * with a seatbelt deny-list while still allowing this session's work-root
 * `.env`, and containerized deployments rely on the container boundary.
 */

import {
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { nshBinary, nshEnv } from '~server/apps/native/nsh-toolchain';
import {
  AGENT_HOME_DIR,
  agentHomeDir,
  REPO_ROOT,
  WORKSPACE_ROOT,
} from './paths';

/**
 * A platform-owned directory holding one entry, `nsh`: a link to the pinned
 * binary the platform builds native Apps with (`HATCH_NSH_BIN` may name it
 * `nsh-0.7.0`, and its own directory may hold other tools). The Agent checks
 * a native App (`nsh check`, `nsh test`, `nsh build`) with the same release a
 * deploy uses. Empty where none is installed.
 */
const NSH_LINK_DIR = path.join(WORKSPACE_ROOT, 'cache', 'nsh-bin');

function nshBinDir(): string[] {
  let binary: string;
  try {
    binary = nshBinary();
  } catch {
    return [];
  }
  const link = path.join(NSH_LINK_DIR, 'nsh');
  try {
    if (readlinkSync(link) === binary) return [NSH_LINK_DIR];
  } catch {
    // Not made yet, or not a link: replace it below.
  }
  mkdirSync(NSH_LINK_DIR, { recursive: true, mode: 0o755 });
  const next = `${link}.${process.pid}.${Date.now()}`;
  symlinkSync(binary, next);
  renameSync(next, link);
  return [NSH_LINK_DIR];
}

/** Author and committer of every commit the Agent makes. */
const AGENT_GIT_NAME = 'Hatch Agent';
const AGENT_GIT_EMAIL = 'agent@hatch.local';

/** Platform-provided CLI shims used by App codegen and Agent instructions. */
const PLATFORM_NODE_BIN_DIR = path.join(REPO_ROOT, 'node_modules', '.bin');
/**
 * This checkout's `hatch` CLI shim. Production images install the CLI as
 * /usr/local/bin/hatch; a development Runner gets it from here once
 * `pnpm build:cli` has produced the build the shim runs.
 */
const PLATFORM_CLI_BIN_DIR = path.join(
  REPO_ROOT,
  'packages',
  'hatch-cli',
  'bin',
);
const PLATFORM_CLI_BUILD = path.join(
  REPO_ROOT,
  'packages',
  'hatch-cli',
  'dist',
  'main.mjs',
);

/**
 * Variables a dev shell legitimately needs (git / pnpm / deno / node / tools).
 *
 * NOTE: HOME / USERPROFILE / XDG_* / DENO_DIR / PNPM_HOME are deliberately NOT
 * here — they are redirected to a sandbox home below so the model's shell can't
 * read the server user's real home directory (credentials, ssh keys, …).
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // Locating binaries + shells, and basic identity.
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  // Temp dirs.
  'TMPDIR',
  'TMP',
  'TEMP',
  // Locale / text handling.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Toolchain niceties that don't point at the host home.
  'DENO_INSTALL_ROOT',
  'COREPACK_HOME',
  // TLS trust so network tooling behaves like the host.
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Windows essentials (harmless no-ops on POSIX).
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
]);

// Env var names are case-insensitive on Windows (Node often exposes the search
// path as `Path`, not `PATH`), so match the allowlist case-insensitively to
// avoid dropping it — which would leave run_command children with no PATH.
const ALLOWLIST_LOWER: ReadonlySet<string> = new Set(
  [...ALLOWLIST].map((key) => key.toLowerCase()),
);

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function inheritedPath(): string {
  const entry = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === 'path',
  );
  return entry?.[1] ?? '';
}

/**
 * Preserve the runner's toolchain PATH while excluding every Agent-writable
 * workspace directory (and relative entries such as `node_modules/.bin`).
 * The repository's installed CLI shims always win, which keeps manual
 * `buf generate` aligned with platform preparation in production images.
 */
export function agentTrustedPath(): string {
  let canonicalWorkspaceRoot = WORKSPACE_ROOT;
  try {
    canonicalWorkspaceRoot = realpathSync(WORKSPACE_ROOT);
  } catch {
    // The data root may not exist yet on first startup.
  }
  let platformBin: string | null = null;
  try {
    const resolved = realpathSync(PLATFORM_NODE_BIN_DIR);
    if (statSync(resolved).isDirectory()) platformBin = resolved;
  } catch {
    // A dependency install may not have populated the platform CLI bin yet.
  }
  let cliBin: string[] = [];
  try {
    if (statSync(PLATFORM_CLI_BUILD).isFile()) cliBin = [PLATFORM_CLI_BIN_DIR];
  } catch {
    // No development CLI build: rely on an installed `hatch` (production).
  }
  const nshDir = nshBinDir();
  // Platform-owned, inside the data directory the filter below excludes.
  const nshLinkDir = nshDir.length ? realpathSync(NSH_LINK_DIR) : null;
  const entries = [
    PLATFORM_NODE_BIN_DIR,
    ...cliBin,
    ...nshDir,
    ...inheritedPath().split(path.delimiter),
  ];
  const seen = new Set<string>();
  return entries
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .map((entry) => {
      try {
        const resolved = realpathSync(entry);
        return statSync(resolved).isDirectory() ? resolved : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is string => entry !== null)
    .filter(
      (entry) =>
        entry === platformBin ||
        entry === nshLinkDir ||
        !isInside(canonicalWorkspaceRoot, entry),
    )
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(path.delimiter);
}

/**
 * Build the `shellEnv` for NodeExecutionEnv:
 * 1. neutralize every non-allowlisted server variable (set to `undefined`) so
 *    the merged child environment is effectively an allowlist, then
 * 2. redirect HOME and the toolchain cache/config dirs to a sandbox directory so
 *    the model's shell can neither read the host user's home (~/.npmrc, ~/.ssh,
 *    ~/.aws, …) nor write into it.
 *
 * Allowlisted keys keep their original casing (left untouched in process.env).
 */
export function agentShellEnv(sessionId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (!ALLOWLIST_LOWER.has(key.toLowerCase())) env[key] = undefined;
    // Normalize PATH casing and replace it with the trusted value below.
    if (key.toLowerCase() === 'path') env[key] = undefined;
  }

  // Production Agent turns always provide a session id. The fallback is kept
  // for isolated preparation tests over non-Agent temporary roots.
  const home = sessionId ? agentHomeDir(sessionId) : path.join(AGENT_HOME_DIR);
  mkdirSync(home, { recursive: true });
  // Point home + caches at the sandbox (these override the host values that
  // were just neutralized). Tools create the subdirs lazily on first use.
  env.HOME = home;
  env.USERPROFILE = home; // Windows
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.DENO_DIR = path.join(home, '.cache', 'deno');
  env.PNPM_HOME = path.join(home, '.local', 'share', 'pnpm');
  env.PATH = agentTrustedPath();
  // `nsh check` uses the platform's TypeScript, as deploys do, instead of
  // downloading one from npm.
  env.NSH_TSC = nshEnv().NSH_TSC;
  // The sandbox home has no Git identity, and a container host name gives Git
  // nothing to derive one from, so every Agent commit names the Agent.
  env.GIT_AUTHOR_NAME = AGENT_GIT_NAME;
  env.GIT_AUTHOR_EMAIL = AGENT_GIT_EMAIL;
  env.GIT_COMMITTER_NAME = AGENT_GIT_NAME;
  env.GIT_COMMITTER_EMAIL = AGENT_GIT_EMAIL;
  return env;
}
