/**
 * Server-only: Deno backend instance manager + Connect reverse proxy.
 *
 * An app owns a set of backend *instances* (one Deno process each). At most
 * one instance per app is routable — the one new requests are sent to; any
 * number of others may be draining, i.e. already retired and on their way
 * out. A retired instance is never routed to again and never revived: a
 * request that arrives while one drains boots a fresh instance beside it.
 *
 * Deploy, rollback and manual stop retire instances instead of killing them:
 * a retired instance keeps serving the requests it already holds and exits
 * once they finish or the drain timeout elapses. Old code cannot reach a
 * migrated Data schema meanwhile — the Data API checks the deployment each
 * backend was built for. Only archive, delete and an explicit force stop kill
 * every instance at once.
 *
 * Serverless backends start on the first request and are retired once they
 * have had no in-flight request for the idle timeout. Long-running backends
 * are never idle-stopped and restart automatically after an unexpected exit.
 *
 * Task runs use *run* instances: each run boots its own instance of the
 * active deployment, sends it exactly one request and retires it. Run
 * instances are never routable, idle-stopped or restarted, and they stay out
 * of the backend's lifecycle snapshot, but they are members of the App's
 * instance set: a deploy, rollback or stop drains them like any instance and
 * a force stop, archive or delete kills them.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
} from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  appBuildDir,
  appStorageDir,
  deploymentArtifactDir,
  deploymentBuildDir,
} from '~agent/paths';
import { HATCH_SDK_IMPORT_MAP } from '~agent/hatch-sdk';
import { db, schema } from '~/db';
import { getPlatformEnv } from '~/env';
import {
  effectiveNetworkAllowlist,
  type NetworkPolicy,
  networkDestinationFromUrl,
  networkPolicySchema,
} from '~/network-policy';
import {
  extraPermissionsSchema,
  mergeDenoPermissionFlags,
} from '~/extra-permissions';
import { readTextPrefix } from '../http-body';
import { internalPlatformUrl } from '../internal-platform-url';
import { subprocessSandboxEnv } from '../sandbox-env';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  hatchSignature,
} from '../secrets';
import {
  buildMatchesDeployment,
  readBuildDeploymentMarker,
} from './build-identity';
import {
  AppDeploymentCompatibilityError,
  assertSupportedDeployment,
} from './compatibility';
import { appDatabaseRuntimeEnv } from './runtime-database';
import {
  backendRuntimeSchema,
  type BackendRuntime,
  dataTableUrl,
  notificationsUrl,
  kvUrl,
  taskEnqueueUrl,
} from './manifest';
import {
  type BackendRuntimeSnapshot,
  getBackendSnapshot,
  recordBackendAutoRestart,
  recordBackendExit,
  recordBackendReady,
  recordBackendSpawn,
  recordBackendStartFailure,
  recordBackendStopped,
} from './runtime-state';

export type BackendArtifact = {
  /** Validated absolute path to the runtime entry inside artifact/backend/. */
  entryPath: string;
  /** Absent on historical deployments, which use deno run. */
  runtime?: BackendRuntime;
  format?: 'bundle-v1';
  /** Absent when no policy was declared, which runs unrestricted. */
  network?: NetworkPolicy;
  extraPermissions?: string[];
};

const LEGACY_BACKEND_ENTRY = 'backend/main.ts';
const NORMALIZED_MANIFEST = 'manifest.normalized.json';

function invalidBackendArtifact(message: string): Error {
  return new Error(`Invalid backend artifact: ${message}`);
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function validateBackendEntryPath(buildDir: string, entry: string): string {
  if (
    entry.length === 0 ||
    entry.includes('\0') ||
    entry.includes('\\') ||
    path.posix.isAbsolute(entry) ||
    entry.split('/').includes('..')
  ) {
    throw invalidBackendArtifact(
      `backend.entry must be a relative path inside "backend/": ${JSON.stringify(entry)}`,
    );
  }

  const normalized = path.posix.normalize(entry);
  if (normalized === 'backend' || !normalized.startsWith('backend/')) {
    throw invalidBackendArtifact(
      `backend.entry must be a relative path inside "backend/": ${JSON.stringify(entry)}`,
    );
  }

  const backendRoot = path.resolve(buildDir, 'backend');
  const absoluteEntry = path.resolve(buildDir, ...normalized.split('/'));
  const relativeToBackend = path.relative(backendRoot, absoluteEntry);
  if (
    relativeToBackend === '' ||
    relativeToBackend === '..' ||
    relativeToBackend.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToBackend)
  ) {
    throw invalidBackendArtifact(
      `backend.entry escapes the artifact backend directory: ${JSON.stringify(entry)}`,
    );
  }

  let cursor = path.resolve(buildDir);
  const segments = normalized.split('/');
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (isMissingPath(error)) {
        throw invalidBackendArtifact(
          `backend.entry does not exist: ${JSON.stringify(normalized)}`,
        );
      }
      throw invalidBackendArtifact(
        `cannot inspect backend.entry ${JSON.stringify(normalized)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw invalidBackendArtifact(
        `backend.entry must not traverse symbolic links: ${JSON.stringify(normalized)}`,
      );
    }
    const finalSegment = index === segments.length - 1;
    if (!finalSegment && !stat.isDirectory()) {
      throw invalidBackendArtifact(
        `backend.entry parent is not a directory: ${JSON.stringify(normalized)}`,
      );
    }
    if (finalSegment && !stat.isFile()) {
      throw invalidBackendArtifact(
        `backend.entry is not a regular file: ${JSON.stringify(normalized)}`,
      );
    }
  }

  return absoluteEntry;
}

function readBackendArtifactMetadata(buildDir: string): {
  entry: string;
  runtime?: BackendRuntime;
  format?: 'bundle-v1';
  network?: NetworkPolicy;
  extraPermissions?: string[];
} {
  const manifestPath = path.join(buildDir, NORMALIZED_MANIFEST);
  let manifestStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch (error) {
    if (isMissingPath(error)) {
      throw invalidBackendArtifact(`${NORMALIZED_MANIFEST} does not exist`);
    }
    throw invalidBackendArtifact(
      `cannot inspect ${NORMALIZED_MANIFEST}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw invalidBackendArtifact(
      `${NORMALIZED_MANIFEST} must be a regular file and not a symbolic link`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw invalidBackendArtifact(
      `${NORMALIZED_MANIFEST} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidBackendArtifact(
      `${NORMALIZED_MANIFEST} must contain an object`,
    );
  }

  const manifest = parsed as Record<string, unknown>;
  if (!Object.hasOwn(manifest, 'backend')) {
    return { entry: LEGACY_BACKEND_ENTRY };
  }
  const backend = manifest.backend;
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) {
    throw invalidBackendArtifact('backend metadata must be an object');
  }

  const metadata = backend as Record<string, unknown>;
  if (typeof metadata.entry !== 'string' || metadata.entry.length === 0) {
    throw invalidBackendArtifact('backend.entry must be a non-empty string');
  }
  const entry = metadata.entry;

  let runtime: BackendRuntime | undefined;
  if (Object.hasOwn(metadata, 'runtime')) {
    const parsedRuntime = backendRuntimeSchema.safeParse(metadata.runtime);
    if (!parsedRuntime.success) {
      throw invalidBackendArtifact(
        `unsupported backend runtime: ${JSON.stringify(metadata.runtime)}`,
      );
    }
    runtime = parsedRuntime.data;
  }

  let network: NetworkPolicy | undefined;
  if (Object.hasOwn(metadata, 'network')) {
    const parsedNetwork = networkPolicySchema.safeParse(metadata.network);
    if (!parsedNetwork.success) {
      throw invalidBackendArtifact(
        `backend.network is invalid: ${parsedNetwork.error.issues[0]?.message ?? 'unknown policy error'}`,
      );
    }
    network = parsedNetwork.data;
  }
  let extraPermissions: string[] | undefined;
  if (Object.hasOwn(metadata, 'extraPermissions')) {
    const parsedPermissions = extraPermissionsSchema.safeParse(
      metadata.extraPermissions,
    );
    if (!parsedPermissions.success) {
      throw invalidBackendArtifact(
        `backend.extraPermissions is invalid: ${parsedPermissions.error.issues[0]?.message}`,
      );
    }
    extraPermissions = parsedPermissions.data;
  }
  const base = {
    entry,
    ...(extraPermissions === undefined ? {} : { extraPermissions }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(network === undefined ? {} : { network }),
  };

  if (!Object.hasOwn(metadata, 'format')) return base;
  if (metadata.format !== 'bundle-v1') {
    throw invalidBackendArtifact(
      `unsupported backend format: ${JSON.stringify(metadata.format)}`,
    );
  }
  return { ...base, format: 'bundle-v1' };
}

export function backendArtifactEnv(
  buildDir: string,
  artifact: BackendArtifact,
): Record<string, string> {
  if (artifact.format !== 'bundle-v1') return {};
  return {
    HATCH_ASSETS_DIR: path.resolve(buildDir, 'backend', 'assets'),
  };
}

/** Expose persistent storage only when the capability selected a directory. */
export function backendStorageEnv(
  storageDir: string | null,
): Record<string, string> {
  return storageDir ? { STORAGE_DIR: storageDir } : {};
}

/**
 * Resolve the backend artifact recorded in the staged normalized manifest.
 * Falls back to the scaffold convention (`backend/main.ts`) for older
 * artifacts whose manifest predates the recorded `backend.entry`.
 */
export function resolveBackendArtifact(buildDir: string): BackendArtifact {
  const metadata = readBackendArtifactMetadata(buildDir);
  const entryPath = validateBackendEntryPath(buildDir, metadata.entry);
  const network =
    metadata.network === undefined ? {} : { network: metadata.network };
  const runtime =
    metadata.runtime === undefined ? {} : { runtime: metadata.runtime };
  const permissions =
    metadata.extraPermissions === undefined
      ? {}
      : { extraPermissions: metadata.extraPermissions };
  return metadata.format === 'bundle-v1'
    ? { entryPath, format: 'bundle-v1', ...network, ...runtime, ...permissions }
    : { entryPath, ...network, ...runtime, ...permissions };
}

/** Prefer immutable deployment bytes; fall back only for legacy artifacts. */
function runtimeBuildDir(id: string, deploymentId: string): string {
  const artifact = deploymentArtifactDir(id, deploymentId);
  if (existsSync(artifact)) return artifact;
  const legacy = deploymentBuildDir(id, deploymentId);
  if (existsSync(legacy)) return legacy;
  return appBuildDir(id);
}

/**
 * Resolve Deno's module cache directory (`DENO_DIR` or the platform default).
 * Legacy source artifacts load npm/jsr deps from here at runtime, and some
 * packages read their own cached files, so that compatibility path needs access.
 */
function denoCacheDir(): string | null {
  if (process.env.DENO_DIR) return process.env.DENO_DIR;
  const home = os.homedir();
  if (!home) return null;
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'deno');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return local ? path.join(local, 'deno') : null;
  }
  const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(home, '.cache');
  return path.join(xdgCache, 'deno');
}

type BackendDenoArgsOptions = {
  artifact: BackendArtifact;
  buildDir: string;
  port: number;
  storageDir: string | null;
  cacheDir: string | null;
  certPaths: readonly string[];
  automaticNetworkDestinations?: readonly string[];
  importMap?: string | null;
  hasLock: boolean;
};

/** Build the sandboxed Deno invocation for a staged backend artifact. */
export function buildBackendDenoArgs({
  artifact,
  buildDir,
  port,
  storageDir,
  cacheDir,
  certPaths,
  automaticNetworkDestinations = [],
  importMap,
  hasLock,
}: BackendDenoArgsOptions): string[] {
  const bundled = artifact.format === 'bundle-v1';
  const allowRead = bundled
    ? [path.resolve(buildDir, 'backend', 'assets')]
    : [buildDir];
  if (storageDir) allowRead.push(storageDir);
  if (!bundled && cacheDir) allowRead.push(cacheDir);
  allowRead.push(...certPaths);

  const denoArgs =
    artifact.runtime === 'deno-serve'
      ? ['serve', '--host=127.0.0.1', `--port=${port}`]
      : ['run'];
  if (bundled) {
    denoArgs.push(
      '--no-config',
      '--no-lock',
      '--no-npm',
      '--no-remote',
      '--cached-only',
    );
  } else {
    // Legacy source artifacts resolve dependencies from the build-time cache.
    denoArgs.push('--node-modules-dir=none');
  }
  const permissionFlags = [`--allow-read=${allowRead.join(',')}`];
  if (storageDir) permissionFlags.push(`--allow-write=${storageDir}`);
  const allowNet = effectiveNetworkAllowlist(
    artifact.network,
    automaticNetworkDestinations,
  );
  if (allowNet === null) {
    permissionFlags.push('--allow-net');
  } else if (allowNet.length > 0) {
    permissionFlags.push(`--allow-net=${allowNet.join(',')}`);
  }
  permissionFlags.push('--allow-env');
  denoArgs.push(
    ...mergeDenoPermissionFlags(permissionFlags, artifact.extraPermissions),
    '--no-prompt',
  );
  if (!bundled && importMap) {
    denoArgs.push(`--import-map=${importMap}`);
  }
  if (!bundled && hasLock) {
    denoArgs.push('--lock=deno.lock', '--frozen');
  }
  denoArgs.push(artifact.entryPath);
  return denoArgs;
}

/** Inject PORT only for self-listening backends, including historical artifacts. */
export function backendPortEnv(
  runtime: BackendRuntime | undefined,
  port: number,
): Record<string, string> {
  return runtime === 'deno-serve' ? {} : { PORT: String(port) };
}

type BackendInstance = {
  appId: string;
  /**
   * `serve` instances take routed requests; a `run` instance serves exactly
   * one task run and is invisible to routing and the lifecycle snapshot.
   */
  role: 'serve' | 'run';
  proc: ChildProcess;
  port: number;
  deploymentId: string;
  startedAt: number;
  ready: Promise<void>;
  getLog: () => string;
  /**
   * Whether this instance is stopped after sitting idle. Fixed at spawn from
   * the app's backend mode: long-running backends hold in-memory state and
   * are never idle-stopped, whether or not their keep-alive mark is armed.
   */
  idleStop: boolean;
  /** Requests currently being served, including their streaming bodies. */
  activeRequests: number;
  idleTimer: NodeJS.Timeout | null;
  /**
   * Retired: no longer routable and expected to exit. Set once, never
   * cleared — a draining instance is not handed new requests even if it is
   * still alive, and its exit is neither a crash nor a restart trigger.
   */
  draining: boolean;
  /** Set once the exit signal was sent; a terminating instance is past drain. */
  terminating: boolean;
  /** Drain deadline while requests are in flight, then the SIGKILL grace. */
  drainTimer: NodeJS.Timeout | null;
  /** Why the platform ended the process early, for the run that used it. */
  endedBy: 'kill' | 'drain-timeout' | null;
};

type StartingBackend = {
  /**
   * The deployment being booted: the caller's expectation at first, then the
   * one the start resolved from the platform row. Undefined only while a
   * start without an expectation (an automatic restart) has not resolved it.
   */
  deploymentId: string | undefined;
  promise: Promise<BackendInstance>;
};

type RuntimeGlobal = typeof globalThis & {
  __hatchAppInstances__?: Map<string, Set<BackendInstance>>;
  __hatchAppStarting__?: Map<string, StartingBackend>;
  __hatchAppStopEpoch__?: Map<string, number>;
  __hatchAppKillEpoch__?: Map<string, number>;
  __hatchAppKeepAlive__?: Set<string>;
  __hatchAppRestarts__?: Map<string, number>;
  __hatchAppCleanup__?: boolean;
};

/** Every live instance per app: at most one routable, the rest draining. */
function instanceRegistry(): Map<string, Set<BackendInstance>> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppInstances__ ??= new Map<string, Set<BackendInstance>>();
  return g.__hatchAppInstances__;
}

/** The instance new requests go to, if the app has one. */
function routableInstance(id: string): BackendInstance | undefined {
  for (const instance of instanceRegistry().get(id) ?? []) {
    if (instance.role !== 'run' && !instance.draining) return instance;
  }
  return undefined;
}

function addInstance(instance: BackendInstance): void {
  const reg = instanceRegistry();
  let set = reg.get(instance.appId);
  if (!set) {
    set = new Set<BackendInstance>();
    reg.set(instance.appId, set);
  }
  set.add(instance);
}

function removeInstance(instance: BackendInstance): void {
  const reg = instanceRegistry();
  const set = reg.get(instance.appId);
  if (!set) return;
  set.delete(instance);
  if (set.size === 0) reg.delete(instance.appId);
}

function isLive(instance: BackendInstance): boolean {
  return instance.proc.exitCode === null && instance.proc.signalCode === null;
}

function clearInstanceTimers(instance: BackendInstance): void {
  if (instance.idleTimer) clearTimeout(instance.idleTimer);
  if (instance.drainTimer) clearTimeout(instance.drainTimer);
  instance.idleTimer = null;
  instance.drainTimer = null;
}

/**
 * Kill an instance immediately, in-flight requests included (archive, delete,
 * force stop, a superseded cold start). It leaves the registry at once, so
 * the app can boot a replacement without waiting for the exit event.
 */
function killInstance(instance: BackendInstance): void {
  instance.draining = true;
  if (isLive(instance)) instance.endedBy ??= 'kill';
  clearInstanceTimers(instance);
  try {
    instance.proc.kill('SIGKILL');
  } catch {
    /* best-effort */
  }
  removeInstance(instance);
}

/** How long a draining instance gets to exit on SIGTERM before SIGKILL. */
const DRAIN_GRACE_MS = 5000;

/**
 * Ask an instance with nothing left to serve to exit: SIGTERM, then SIGKILL
 * after the grace. Every graceful shutdown ends this way, including one whose
 * drain timeout elapsed, so a backend's SIGTERM handler always gets the
 * chance to stop background work and release what it holds.
 */
function terminateInstance(instance: BackendInstance): void {
  if (instance.terminating) return;
  instance.terminating = true;
  clearInstanceTimers(instance);
  try {
    instance.proc.kill('SIGTERM');
  } catch {
    /* best-effort */
  }
  instance.drainTimer = setTimeout(() => {
    instance.drainTimer = null;
    if (!isLive(instance)) return;
    try {
      instance.proc.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
  }, DRAIN_GRACE_MS);
  instance.drainTimer.unref();
}

/**
 * Retire an instance gracefully (deploy, rollback, stop, restart). Marking it
 * draining is synchronous, so from this point the app has no routable
 * instance and the next request boots a new one instead of waiting for (or
 * reviving) this one. Requests it already holds run to completion: the
 * instance is terminated once nothing is in flight, or when the drain timeout
 * elapses for requests that never end (long-lived streams). The instance
 * stays registered until it actually exits so platform shutdown still reaps
 * it.
 *
 * A drain timeout of 0 opts out of draining altogether and kills the instance
 * at once, as the platform did before graceful retirement.
 */
function retireInstance(instance: BackendInstance): void {
  if (instance.draining) return;
  const drainTimeoutMs = getPlatformEnv().appBackendDrainTimeoutSeconds * 1000;
  if (drainTimeoutMs === 0) {
    killInstance(instance);
    return;
  }
  instance.draining = true;
  clearInstanceTimers(instance);
  if (instance.activeRequests === 0) {
    terminateInstance(instance);
    return;
  }
  instance.drainTimer = setTimeout(() => {
    instance.drainTimer = null;
    instance.endedBy ??= 'drain-timeout';
    terminateInstance(instance);
  }, drainTimeoutMs);
  instance.drainTimer.unref();
}

/**
 * (Re)arm the idle timer of an instance that has nothing in flight. The
 * timer callback and {@link leaseInstance} both run synchronously on the
 * event loop, so an instance is either leased or retired, never both.
 */
function scheduleIdleStop(instance: BackendInstance): void {
  if (!instance.idleStop || instance.draining || instance.activeRequests > 0) {
    return;
  }
  if (instance.idleTimer) clearTimeout(instance.idleTimer);
  instance.idleTimer = setTimeout(() => {
    instance.idleTimer = null;
    if (instance.draining || instance.activeRequests > 0) return;
    // An idle instance has nothing to drain, whatever the drain timeout.
    recordBackendStopped(instance.appId, instance.proc.pid ?? null);
    instance.draining = true;
    terminateInstance(instance);
  }, getPlatformEnv().appBackendIdleTimeoutSeconds * 1000);
  instance.idleTimer.unref();
}

/**
 * Count a request against an instance so it cannot be idle-stopped while the
 * request is in flight. Returns the (idempotent) release callback.
 */
function leaseInstance(instance: BackendInstance): () => void {
  instance.activeRequests += 1;
  if (instance.idleTimer) {
    clearTimeout(instance.idleTimer);
    instance.idleTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    instance.activeRequests -= 1;
    // The last request of a retired instance just finished: let it exit now
    // rather than hold the process until the drain timeout.
    if (instance.draining && instance.activeRequests === 0) {
      if (isLive(instance)) terminateInstance(instance);
      return;
    }
    scheduleIdleStop(instance);
  };
}

/** In-flight cold starts, so concurrent callers coalesce onto one process. */
function startingRegistry(): Map<string, StartingBackend> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppStarting__ ??= new Map<string, StartingBackend>();
  return g.__hatchAppStarting__;
}

/**
 * Monotonic per-app counter bumped by {@link stopApp}. A cold start captures the
 * epoch when it begins and refuses to register (and kills) its process if the
 * epoch changed meanwhile — i.e. a stop/redeploy happened during startup — so a
 * stale build is never left serving or orphaned.
 */
function stopEpoch(id: string): number {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppStopEpoch__ ??= new Map<string, number>();
  return g.__hatchAppStopEpoch__.get(id) ?? 0;
}

function bumpStopEpoch(id: string): void {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppStopEpoch__ ??= new Map<string, number>();
  g.__hatchAppStopEpoch__.set(id, (g.__hatchAppStopEpoch__.get(id) ?? 0) + 1);
}

/**
 * Per-app counter bumped only by a force stop ({@link killApp}), so a task run
 * can tell "stopped for good" from a graceful stop or deploy it may survive.
 */
function killEpoch(id: string): number {
  return (globalThis as RuntimeGlobal).__hatchAppKillEpoch__?.get(id) ?? 0;
}

function bumpKillEpoch(id: string): void {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppKillEpoch__ ??= new Map<string, number>();
  g.__hatchAppKillEpoch__.set(id, killEpoch(id) + 1);
}

function keepAliveSet(): Set<string> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppKeepAlive__ ??= new Set<string>();
  return g.__hatchAppKeepAlive__;
}

/** Consecutive fast-crash count per app, driving the restart backoff. */
function restartCounts(): Map<string, number> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppRestarts__ ??= new Map<string, number>();
  return g.__hatchAppRestarts__;
}

/** A process that stayed up this long is considered healthy: backoff resets. */
const RESTART_HEALTHY_UPTIME_MS = 30_000;
const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 60_000;

/**
 * Persist a backend lifecycle event to the `logs` table so a crash leaves a
 * durable trace (the in-memory log ring dies with the process). Best-effort.
 */
async function recordBackendLog(
  id: string,
  level: 'info' | 'error',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(schema.logs).values({
      appId: id,
      source: 'backend',
      level,
      message,
      data: (data ?? null) as never,
    });
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Mark an app's backend as long-running. While marked, the platform restarts
 * it automatically if the process exits unexpectedly.
 */
export function setKeepAlive(id: string, on: boolean): void {
  const set = keepAliveSet();
  if (on) set.add(id);
  else set.delete(id);
}

/**
 * Boot every deployed long-running backend and re-arm its keep-alive mark.
 * The keep-alive registry is in-memory, so after a server restart these
 * backends would otherwise stay down (and stop self-healing) until the first
 * request happens to hit them. Called once at server startup; each app's boot
 * is independent and best-effort.
 */
export async function warmLongRunningBackends(): Promise<void> {
  const apps = await db.query.apps.findMany({
    where: { status: 'deployed' },
    columns: {
      id: true,
      backendMode: true,
      capabilities: true,
      currentDeploymentId: true,
    },
  });
  for (const app of apps) {
    if (
      app.backendMode !== 'long-running' ||
      !app.capabilities?.backend ||
      !app.currentDeploymentId
    ) {
      continue;
    }
    setKeepAlive(app.id, true);
    void ensureAppRunning(app.id, app.currentDeploymentId).catch((error) => {
      console.error(
        `[runtime] warm start of long-running backend "${app.id}" failed:`,
        error instanceof Error ? error.message : error,
      );
    });
  }
}

function installCleanup(): void {
  const g = globalThis as RuntimeGlobal;
  if (g.__hatchAppCleanup__) return;
  g.__hatchAppCleanup__ = true;
  const killAll = () => {
    for (const set of instanceRegistry().values()) {
      for (const instance of set) {
        try {
          instance.proc.kill('SIGKILL');
        } catch {
          /* best-effort */
        }
      }
    }
  };
  process.on('exit', killAll);
  process.once('SIGINT', () => {
    killAll();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    killAll();
    process.exit(0);
  });
}

installCleanup();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('could not allocate a port')));
      }
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await delay(150);
  }
  throw new Error(`backend did not become reachable on port ${port}`);
}

/**
 * The deployment a caller resolved is no longer the app's active one: a
 * deploy or rollback committed in between. Nothing was sent to a backend, so
 * the caller can resolve the active deployment again and retry.
 */
export class BackendDeploymentChangedError extends Error {
  constructor(id: string) {
    super(
      `App "${id}" deployment changed before its backend started. Retry ` +
        'against the active deployment.',
    );
    this.name = 'BackendDeploymentChangedError';
  }
}

/** A cold start was cancelled by a stop, deploy or rollback that landed meanwhile. */
class BackendStartSupersededError extends Error {
  constructor(id: string) {
    super(`App "${id}" start was superseded by a stop/redeploy.`);
    this.name = 'BackendStartSupersededError';
  }
}

/**
 * Tell a caller holding a superseded deployment id apart from a local
 * instance that is the stale one (another platform process activated a
 * deployment, or this process has not finalized its own cutover yet).
 */
async function assertActiveDeployment(
  id: string,
  expectedDeploymentId: string,
): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { currentDeploymentId: true },
  });
  if (app?.currentDeploymentId !== expectedDeploymentId) {
    throw new BackendDeploymentChangedError(id);
  }
}

/** Start (or reuse) the Deno backend for an app and return its local port. */
export async function ensureAppRunning(
  id: string,
  expectedDeploymentId?: string,
): Promise<number> {
  return (await ensureInstance(id, expectedDeploymentId)).port;
}

/** Resolve the app's routable instance, booting one when it has none. */
async function ensureInstance(
  id: string,
  expectedDeploymentId?: string,
): Promise<BackendInstance> {
  const starting = startingRegistry();
  for (;;) {
    const existing = routableInstance(id);
    if (existing && !isLive(existing)) {
      removeInstance(existing);
      continue;
    }
    if (existing) {
      if (
        !expectedDeploymentId ||
        existing.deploymentId === expectedDeploymentId
      ) {
        try {
          await existing.ready;
        } catch (error) {
          // A stop or deploy retired this instance before it became ready,
          // which is what failed its readiness. The request is still wanted:
          // resolve again, as the caller that started the boot does.
          if (existing.draining) continue;
          throw error;
        }
        return existing;
      }
      // Never retire an instance on a caller's word alone: a request that
      // resolved its deployment just before a cutover must not take down the
      // instance of the deployment that replaced it.
      await assertActiveDeployment(id, expectedDeploymentId);
      // The local instance is the stale one. Retire it, preserving keep-alive
      // intent; the next iteration boots the active deployment beside it.
      invalidateLocalBackend(id, {
        preserveKeepAlive: true,
        keepDeploymentId: expectedDeploymentId,
      });
      continue;
    }

    // Coalesce concurrent cold starts. Without this, two requests that both
    // find no routable instance each spawn a backend and the app ends up with
    // two routable instances. The first caller records a pending-start
    // promise that later callers await instead of starting again.
    const pending = starting.get(id);
    if (pending) {
      if (
        !expectedDeploymentId ||
        pending.deploymentId === expectedDeploymentId
      ) {
        return pending.promise;
      }
      await assertActiveDeployment(id, expectedDeploymentId);
      invalidateLocalBackend(id, {
        preserveKeepAlive: true,
        keepDeploymentId: expectedDeploymentId,
      });
      continue;
    }

    const start: StartingBackend = {
      deploymentId: expectedDeploymentId,
      // startBackend resolves the deployment only after its first await, by
      // which point `start` is assigned.
      promise: startBackend(id, expectedDeploymentId, (resolved) => {
        start.deploymentId = resolved;
      }),
    };
    const startPromise = start.promise;
    starting.set(id, start);
    try {
      return await startPromise;
    } finally {
      // Only clear our own entry: a stop during startup deletes this entry
      // and a later ensureAppRunning() may register a fresh one we must not
      // drop.
      if (starting.get(id) === start) starting.delete(id);
    }
  }
}

/**
 * Resolve a ready instance and lease it for one request. The lease is taken
 * in the same tick the instance is confirmed routable, which is what keeps
 * the idle timer from retiring an instance a request was just routed to.
 */
async function acquireInstance(
  id: string,
  expectedDeploymentId?: string,
): Promise<{ port: number; release: () => void }> {
  for (let attempt = 0; ; attempt += 1) {
    let instance: BackendInstance;
    try {
      instance = await ensureInstance(id, expectedDeploymentId);
    } catch (error) {
      // The cold start this request was waiting on was cancelled by a stop
      // or deploy. The request itself is still wanted: resolve again.
      if (error instanceof BackendStartSupersededError && attempt < 2) continue;
      throw error;
    }
    if (!instance.draining) {
      return { port: instance.port, release: leaseInstance(instance) };
    }
    // Retired between becoming ready and this continuation (a stop or
    // redeploy landed). Resolve again rather than revive it.
    if (attempt >= 2) {
      throw new Error(`App "${id}" backend was stopped while starting.`);
    }
  }
}

type SpawnedBackend = {
  proc: ChildProcess;
  port: number;
  deploymentId: string;
  backendMode: 'serverless' | 'long-running' | null;
  epoch: number;
  getLog: () => string;
  spawnFailure: Promise<never>;
};

/**
 * Resolve the App's active deployment, check it can run, and spawn one
 * backend process for it. Shared by routable (`serve`) and task (`run`)
 * instances; the caller registers the process and waits for readiness.
 */
async function spawnBackendProcess(
  id: string,
  expectedDeploymentId: string | undefined,
  onDeploymentResolved: (deploymentId: string) => void,
  extraEnv: Record<string, string> = {},
): Promise<SpawnedBackend> {
  // Snapshot the stop epoch: if stopApp() runs while we're spawning, we abort
  // instead of registering/serving a build the caller has since superseded.
  const epoch = stopEpoch(id);
  const initialApp = await db.query.apps.findFirst({
    where: { id },
    columns: {
      status: true,
      capabilities: true,
      currentDeploymentId: true,
    },
  });
  if (!initialApp || initialApp.status === 'archived') {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" is not available.`);
  }
  if (!initialApp.capabilities?.backend) {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" has no active backend.`);
  }
  const targetDeploymentId = initialApp.currentDeploymentId;
  if (!targetDeploymentId) {
    throw new Error(`App "${id}" has no active deployment.`);
  }
  if (expectedDeploymentId && targetDeploymentId !== expectedDeploymentId) {
    throw new BackendDeploymentChangedError(id);
  }
  // From here a deploy that keeps this deployment (its finalization, which
  // retires only replaced builds) no longer cancels this start.
  onDeploymentResolved(targetDeploymentId);
  try {
    await assertSupportedDeployment(targetDeploymentId);
  } catch (error) {
    if (error instanceof AppDeploymentCompatibilityError) {
      setKeepAlive(id, false);
    }
    throw error;
  }
  const buildDir = runtimeBuildDir(id, targetDeploymentId);
  const buildMarker = readBuildDeploymentMarker(buildDir);
  if (buildMarker.kind === 'invalid') {
    throw new Error(
      `App "${id}" build has an invalid deployment marker. Redeploy or ` +
        'restore a valid deployment before starting its backend.',
    );
  }
  if (
    buildMarker.kind === 'deployment' &&
    buildMarker.id !== targetDeploymentId
  ) {
    throw new Error(
      `App "${id}" build belongs to deployment ${buildMarker.id}, not active ` +
        `${targetDeploymentId}. Retry after deployment finalization.`,
    );
  }
  if (
    buildMarker.kind === 'missing' &&
    !(await buildMatchesDeployment(id, targetDeploymentId, buildDir))
  ) {
    throw new Error(
      `App "${id}" build has no deployment marker and is not a verified ` +
        'legacy artifact. Redeploy or restore a valid deployment before ' +
        'starting its backend.',
    );
  }
  let backendArtifact: BackendArtifact;
  try {
    backendArtifact = resolveBackendArtifact(buildDir);
  } catch (error) {
    throw new Error(
      `App "${id}" has an invalid backend artifact. Redeploy or restore a ` +
        `valid deployment before starting it: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
  // Per-app HMAC key so the backend can verify platform-originated requests
  // (cron RPC calls) AND sign its own calls into platform APIs (KV). Absent for
  // apps deployed before this column existed; such backends simply can't verify
  // and the cron call still reaches them.
  const appRow = await db.query.apps.findFirst({
    where: { id },
    columns: {
      status: true,
      signingSecret: true,
      capabilities: true,
      backendMode: true,
      currentDeploymentId: true,
    },
  });
  if (!appRow || appRow.status === 'archived') {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" is not available.`);
  }
  if (!appRow.capabilities?.backend) {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" has no active backend.`);
  }
  const activeDeploymentId = appRow.currentDeploymentId ?? null;
  if (!activeDeploymentId) {
    throw new Error(`App "${id}" has no active deployment.`);
  }
  if (
    activeDeploymentId !== targetDeploymentId ||
    (buildMarker.kind === 'deployment' && buildMarker.id !== activeDeploymentId)
  ) {
    throw new BackendDeploymentChangedError(id);
  }
  const backendDeploymentId = targetDeploymentId;
  const signingSecret = appRow.signingSecret ?? null;
  const storageDir = appRow.capabilities.storage ? appStorageDir(id) : null;
  if (storageDir) mkdirSync(storageDir, { recursive: true });
  const databaseEnv = await appDatabaseRuntimeEnv(
    id,
    appRow.capabilities.database,
  );
  const port = await freePort();

  // KV is stored in the platform DB (not reachable from the sandboxed
  // subprocess), so a KV-capable backend talks to it over HTTP at an absolute
  // URL, signing each request with HATCH_SIGNING_SECRET. Inject the endpoint so
  // the app doesn't hardcode the platform origin. Relative URLs have no host
  // inside the subprocess, so use the platform's loopback HTTP endpoint.
  const kvBaseUrl = appRow.capabilities?.kv
    ? internalPlatformUrl(kvUrl(id))
    : null;
  const dataBaseUrl = appRow.capabilities?.dataTable
    ? internalPlatformUrl(dataTableUrl(id))
    : null;
  const notificationsBaseUrl = appRow.capabilities?.notifications
    ? internalPlatformUrl(notificationsUrl(id))
    : null;
  // Signed endpoint the backend calls to enqueue one of its own tasks.
  const tasksEnqueueUrl = appRow.capabilities?.tasks
    ? internalPlatformUrl(taskEnqueueUrl(id))
    : null;
  const automaticNetworkDestinations = [
    `127.0.0.1:${port}`,
    ...(databaseEnv.DATABASE_URL
      ? [networkDestinationFromUrl(databaseEnv.DATABASE_URL)]
      : []),
    ...(kvBaseUrl ? [networkDestinationFromUrl(kvBaseUrl)] : []),
    ...(dataBaseUrl ? [networkDestinationFromUrl(dataBaseUrl)] : []),
    ...(notificationsBaseUrl
      ? [networkDestinationFromUrl(notificationsBaseUrl)]
      : []),
    ...(tasksEnqueueUrl ? [networkDestinationFromUrl(tasksEnqueueUrl)] : []),
  ];

  // Bundles may read only their fixed asset directory and, when enabled, the
  // app's persistent storage. Legacy source artifacts retain build/cache access
  // for source imports and dependency resolution. TLS trust stores are included
  // when configured.
  const cacheDir = denoCacheDir();
  const certPaths: string[] = [];
  for (const certVar of [
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    const certPath = process.env[certVar];
    if (certPath) certPaths.push(certPath);
  }

  const denoArgs = buildBackendDenoArgs({
    artifact: backendArtifact,
    buildDir,
    port,
    storageDir,
    cacheDir,
    certPaths,
    automaticNetworkDestinations,
    importMap: existsSync(path.join(buildDir, HATCH_SDK_IMPORT_MAP))
      ? HATCH_SDK_IMPORT_MAP
      : null,
    hasLock: existsSync(path.join(buildDir, 'deno.lock')),
  });

  const proc = spawn('deno', denoArgs, {
    cwd: buildDir,
    // Never inherit the platform's process.env (DATABASE_URL, auth secrets,
    // provider keys); hand over only the sandbox allowlist plus the app's own
    // runtime variables.
    env: subprocessSandboxEnv({
      ...backendPortEnv(backendArtifact.runtime, port),
      ...databaseEnv,
      ...backendStorageEnv(storageDir),
      ...backendArtifactEnv(buildDir, backendArtifact),
      ...(signingSecret ? { HATCH_SIGNING_SECRET: signingSecret } : {}),
      ...(kvBaseUrl ? { HATCH_KV_URL: kvBaseUrl } : {}),
      ...(dataBaseUrl ? { HATCH_DATA_URL: dataBaseUrl } : {}),
      ...(notificationsBaseUrl
        ? { HATCH_NOTIFICATIONS_URL: notificationsBaseUrl }
        : {}),
      ...(tasksEnqueueUrl ? { HATCH_TASKS_URL: tasksEnqueueUrl } : {}),
      HATCH_DEPLOYMENT_ID: backendDeploymentId,
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const appendLog = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-4000);
  };
  proc.stdout?.on('data', appendLog);
  proc.stderr?.on('data', appendLog);

  // A ChildProcess 'error' with no listener is an uncaught exception that
  // would crash the whole server (e.g. deno missing from PATH). Capture it —
  // and an exit that happens before the port ever opens — as a fast readiness
  // failure instead of burning the full 20s port-wait.
  const spawnFailure = new Promise<never>((_, reject) => {
    proc.once('error', (err) => {
      reject(new Error(`backend process failed to start: ${err.message}`));
    });
    proc.once('exit', (code, signal) => {
      reject(
        new Error(
          `backend process exited before becoming ready (${signal ?? code})`,
        ),
      );
    });
  });
  // Pre-attach a no-op handler: the rejection also fires when nothing is
  // racing against it (a normal stop after ready, or the epoch-superseded
  // kill below) and must not surface as an unhandled rejection.
  spawnFailure.catch(() => {});

  // A stop/redeploy landed while we were awaiting db/port allocation: abort
  // before registering this now-stale process (which a concurrent warm start
  // could otherwise pick up and serve). This check runs *before* we create
  // `backend.ready` on purpose — creating the readiness promise and then
  // throwing would leave it rejected-but-unawaited (~20s later), an unhandled
  // rejection that can crash the server. Kill the process; the caller boots the
  // current build instead.
  if (stopEpoch(id) !== epoch) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    throw new BackendStartSupersededError(id);
  }

  return {
    proc,
    port,
    deploymentId: backendDeploymentId,
    backendMode: appRow.backendMode ?? null,
    epoch,
    getLog: () => log,
    spawnFailure,
  };
}

async function startBackend(
  id: string,
  expectedDeploymentId: string | undefined,
  onDeploymentResolved: (deploymentId: string) => void,
): Promise<BackendInstance> {
  const spawned = await spawnBackendProcess(
    id,
    expectedDeploymentId,
    onDeploymentResolved,
  );
  const { proc, port, epoch, spawnFailure } = spawned;
  const backendDeploymentId = spawned.deploymentId;
  const log = () => spawned.getLog();
  const backend: BackendInstance = {
    appId: id,
    role: 'serve',
    proc,
    port,
    deploymentId: backendDeploymentId,
    startedAt: Date.now(),
    ready: Promise.resolve(),
    getLog: log,
    idleStop: spawned.backendMode !== 'long-running',
    activeRequests: 0,
    idleTimer: null,
    drainTimer: null,
    draining: false,
    terminating: false,
    endedBy: null,
  };
  backend.ready = Promise.race([waitForPort(port, 20000), spawnFailure]);
  addInstance(backend);
  recordBackendSpawn(id, {
    pid: proc.pid ?? null,
    port,
    startedAt: backend.startedAt,
  });
  proc.on('exit', (code, signal) => {
    recordBackendExit(id, { pid: proc.pid ?? null, code, signal });
    // A retired instance exiting is the expected end of its drain, whatever
    // code its own shutdown handler chose.
    const retired = backend.draining;
    clearInstanceTimers(backend);
    removeInstance(backend);
    const uptimeMs = Date.now() - backend.startedAt;
    // Restart only on an *unexpected* exit. A stop, restart or redeploy
    // retires the instance before its exit event lands — often after the
    // caller has already re-armed keep-alive for the replacement — so a
    // retired instance never schedules a restart or logs a phantom crash.
    // This is deliberately per instance, not per app: an instance of the
    // newly active deployment that a deploy left running must keep
    // self-healing after that deploy retired its predecessors.
    const willRestart = !retired && keepAliveSet().has(id);
    // A self-exit (no signal) is always unexpected — backends are servers.
    // Signal kills are usually our own stop/redeploy SIGKILL, so don't log
    // those; a keep-alive crash is logged by the restart branch below.
    if (
      !retired &&
      !willRestart &&
      signal === null &&
      code !== null &&
      code !== 0
    ) {
      void recordBackendLog(id, 'error', `backend exited with code ${code}`, {
        uptimeMs,
        log: log().slice(-2000),
      });
    }
    // Long-running backends self-heal: if still marked keep-alive (i.e. not
    // intentionally stopped), restart with exponential backoff so a build
    // that crashes on boot doesn't hot-loop a restart every second forever.
    if (willRestart) {
      recordBackendAutoRestart(id);
      const counts = restartCounts();
      const attempt =
        uptimeMs >= RESTART_HEALTHY_UPTIME_MS ? 0 : (counts.get(id) ?? 0);
      counts.set(id, attempt + 1);
      const delayMs = Math.min(
        RESTART_BASE_DELAY_MS * 2 ** attempt,
        RESTART_MAX_DELAY_MS,
      );
      void recordBackendLog(
        id,
        'error',
        `long-running backend exited (${signal ?? code}); restarting in ${delayMs}ms`,
        { uptimeMs, attempt: attempt + 1, log: log().slice(-2000) },
      );
      const timer = setTimeout(() => {
        if (keepAliveSet().has(id) && !routableInstance(id)) {
          // Resolve the currently active deployment afresh. Another platform
          // process may have deployed while this backend was running.
          void ensureAppRunning(id).catch(() => {
            /* will retry on next exit / request */
          });
        }
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    } else {
      restartCounts().delete(id);
    }
  });

  try {
    await backend.ready;
  } catch (error) {
    // A failed boot is not a retirement: kill and unregister the process but
    // leave it un-retired, so the exit of a keep-alive backend that stalled
    // past the readiness window still schedules its automatic restart.
    clearInstanceTimers(backend);
    try {
      proc.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    removeInstance(backend);
    const message = error instanceof Error ? error.message : String(error);
    // Only record a *real* boot failure. If the epoch moved, an intentional
    // stop/restart/redeploy killed this start mid-boot — the resulting
    // SIGKILL/timeout rejection is expected, not a crash, and recording it
    // would show a phantom "failed to start" on the Backends page.
    if (stopEpoch(id) !== epoch) throw new BackendStartSupersededError(id);
    recordBackendStartFailure(id, proc.pid ?? null, message);
    throw new Error(`Failed to start app "${id}": ${message}\n${log()}`);
  }

  // Stop/redeploy landed during the readiness wait: drop this stale backend so
  // the next request boots the current build rather than reusing this one.
  if (stopEpoch(id) !== epoch) {
    killInstance(backend);
    throw new BackendStartSupersededError(id);
  }

  recordBackendReady(id, proc.pid ?? null);
  // Covers an instance nobody ends up calling (e.g. an explicit Start); a
  // request waiting on this boot leases it right after and disarms the timer.
  scheduleIdleStop(backend);
  return backend;
}

/**
 * Cap on how long a backend may take to answer a platform-initiated request.
 * Backends are untrusted code; without a bound, one hung handler pins the
 * platform-side request (a cron slot, a proxied client connection) forever.
 * Applied fully to `callAppBackend` (which buffers the body) and to
 * `proxyAppRequest` only until response headers arrive, so long-lived
 * streaming responses keep working.
 */
const BACKEND_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Server-initiated call into an app backend (cron jobs, notification delivery).
 * Lazily starts the backend, then issues a direct HTTP request to `pathAndQuery`.
 */
export async function callAppBackend(
  id: string,
  pathAndQuery: string,
  init?: RequestInit,
  expectedDeploymentId?: string,
): Promise<{ status: number; body: string; contentType: string | null }> {
  const { port, release } = await acquireInstance(id, expectedDeploymentId);
  try {
    const path = pathAndQuery.startsWith('/')
      ? pathAndQuery
      : `/${pathAndQuery}`;
    const timeout = AbortSignal.timeout(BACKEND_RESPONSE_TIMEOUT_MS);
    const upstream = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      // A caller signal (e.g. a shorter delivery timeout) can only tighten the
      // platform-wide backend response limit.
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    const body = await upstream.text();
    return {
      status: upstream.status,
      body,
      contentType: upstream.headers.get('content-type'),
    };
  } finally {
    release();
  }
}

/** A request sent to a task's dedicated instance. */
export type DedicatedRunRequest = {
  /** Path on the backend, e.g. `/app.v1.DigestService/RunDigest`. */
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type DedicatedRunHandle = {
  /** The deployment whose artifact the instance runs. */
  deploymentId: string;
  pid: number | null;
  /** Kill the instance at once (cancel or timeout). */
  kill: () => void;
};

export type DedicatedRunOptions = {
  request: DedicatedRunRequest;
  /**
   * The deployment the run was prepared for (its input was validated against
   * this deployment's task definition). Only this deployment serves the run:
   * if another one became active before the request was sent, the result is
   * `superseded` and nothing ran.
   */
  deploymentId: string;
  /** Response bytes kept; the rest of a longer body is never read. */
  maxResponseBytes: number;
  /** Extra environment for the instance, e.g. `HATCH_RUN_ID`. */
  env: Record<string, string>;
  /** Output of the instance from the run's request until it exits. */
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  /** Called once the instance is spawned, before readiness. */
  onSpawn?: (handle: DedicatedRunHandle) => void;
  /** Aborting it ends the request and kills the instance. */
  signal?: AbortSignal;
};

export type DedicatedRunResult = {
  /** The deployment that served the run; null if no instance started. */
  deploymentId: string | null;
  /**
   * The backend's answer, when the request got one. `truncated` means the
   * body exceeded `maxResponseBytes` and only its first bytes are in `body`.
   */
  response: { status: number; body: string; truncated: boolean } | null;
  /** Why there is no response: boot failure, kill, timeout. */
  error: string | null;
  /**
   * The pinned deployment is no longer active and no request was sent: the
   * caller may prepare the run again for the new deployment.
   */
  superseded?: boolean;
};

/** Boots of a run instance retried after a deploy or stop superseded them. */
const MAX_RUN_BOOT_ATTEMPTS = 3;

/**
 * Run one request in a fresh instance of `options.deploymentId`, then retire
 * the instance and resolve once it has exited and closed its output.
 *
 * The instance joins the App's instance set as a `run` instance, so a deploy,
 * rollback or stop drains it (the request runs to completion) while a force
 * stop, archive or delete kills it. A stop that lands before the request is
 * sent boots the same deployment again; a deploy or rollback that activated
 * another deployment by then resolves `superseded` without sending it.
 */
export async function runInDedicatedInstance(
  id: string,
  options: DedicatedRunOptions,
): Promise<DedicatedRunResult> {
  let lastDeploymentId: string | null = null;
  // A force stop, archive or delete ends the run for good: every retry below
  // passes through this check, so a killed boot is never replaced.
  const killMark = killEpoch(id);
  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) {
      return {
        deploymentId: lastDeploymentId,
        response: null,
        error: 'aborted',
      };
    }
    if (killEpoch(id) !== killMark) {
      return {
        deploymentId: lastDeploymentId,
        response: null,
        error: 'the App was force-stopped before the run started',
      };
    }
    let spawned: SpawnedBackend;
    try {
      spawned = await spawnBackendProcess(
        id,
        options.deploymentId,
        () => {},
        options.env,
      );
    } catch (error) {
      if (error instanceof BackendDeploymentChangedError) {
        return {
          deploymentId: lastDeploymentId,
          response: null,
          error: 'another deployment became active before the run started',
          superseded: true,
        };
      }
      if (
        error instanceof BackendStartSupersededError &&
        attempt < MAX_RUN_BOOT_ATTEMPTS
      ) {
        continue;
      }
      return {
        deploymentId: lastDeploymentId,
        response: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    lastDeploymentId = spawned.deploymentId;
    const { proc, port } = spawned;
    // A stop that landed after the spawn's own epoch check would miss this
    // still-unregistered process: kill it and decide again above.
    if (stopEpoch(id) !== spawned.epoch) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      if (attempt < MAX_RUN_BOOT_ATTEMPTS) continue;
      return {
        deploymentId: lastDeploymentId,
        response: null,
        error: 'the App was stopped or redeployed before the run started',
      };
    }
    const instance: BackendInstance = {
      appId: id,
      role: 'run',
      proc,
      port,
      deploymentId: spawned.deploymentId,
      startedAt: Date.now(),
      ready: Promise.resolve(),
      getLog: spawned.getLog,
      idleStop: false,
      activeRequests: 0,
      idleTimer: null,
      drainTimer: null,
      draining: false,
      terminating: false,
      endedBy: null,
    };
    addInstance(instance);
    const closed = new Promise<void>((resolve) => {
      // `close` fires after `exit` and after stdout/stderr have ended, so
      // every byte the run wrote has been delivered by then.
      proc.once('close', () => resolve());
    });
    proc.once('exit', () => {
      clearInstanceTimers(instance);
      removeInstance(instance);
    });
    const kill = () => killInstance(instance);
    options.onSpawn?.({
      deploymentId: spawned.deploymentId,
      pid: proc.pid ?? null,
      kill,
    });
    const onAbort = () => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // An abort while the process was spawning fired before the listener.
    if (options.signal?.aborted) onAbort();

    try {
      try {
        await Promise.race([waitForPort(port, 20000), spawned.spawnFailure]);
      } catch (error) {
        const retired = instance.draining;
        if (isLive(instance)) killInstance(instance);
        await closed;
        if (retired && !options.signal?.aborted) {
          if (attempt < MAX_RUN_BOOT_ATTEMPTS) continue;
        }
        return {
          deploymentId: spawned.deploymentId,
          response: null,
          error: options.signal?.aborted
            ? 'aborted'
            : instance.endedBy === 'kill'
              ? 'the instance was stopped while starting'
              : `${error instanceof Error ? error.message : String(error)}\n${spawned.getLog()}`.trim(),
        };
      }
      // A deploy or stop retired the instance before it received the
      // request: nothing ran yet, so boot again. The pinned boot reports
      // `superseded` when a deploy activated another deployment.
      if (instance.draining) {
        killInstance(instance);
        await closed;
        if (attempt < MAX_RUN_BOOT_ATTEMPTS && !options.signal?.aborted) {
          continue;
        }
        return {
          deploymentId: spawned.deploymentId,
          response: null,
          error: 'the App was stopped or redeployed before the run started',
        };
      }

      // Output before readiness is the runtime's own startup chatter
      // ("Listening on …"); the run's log starts with the request. A boot
      // failure still reports the startup output through `error`.
      proc.stdout?.on('data', options.onStdout);
      proc.stderr?.on('data', options.onStderr);
      const release = leaseInstance(instance);
      let response: DedicatedRunResult['response'] = null;
      let error: string | null = null;
      try {
        const upstream = await fetch(
          `http://127.0.0.1:${port}${options.request.path}`,
          {
            method: 'POST',
            headers: options.request.headers,
            body: options.request.body,
            signal: options.signal,
          },
        );
        const { text, truncated } = await readTextPrefix(
          upstream.body,
          options.maxResponseBytes,
        );
        response = { status: upstream.status, body: text, truncated };
      } catch (fetchError) {
        error = options.signal?.aborted
          ? 'aborted'
          : instance.endedBy === 'kill'
            ? 'the instance was stopped during the run'
            : instance.endedBy === 'drain-timeout'
              ? 'the instance was stopped when the drain timeout elapsed'
              : fetchError instanceof Error
                ? fetchError.message
                : String(fetchError);
      } finally {
        release();
      }
      // The one request is done: retire the instance (SIGTERM, then SIGKILL
      // after the grace) unless a drain already did.
      if (!instance.draining) {
        instance.draining = true;
        terminateInstance(instance);
      }
      await closed;
      return { deploymentId: spawned.deploymentId, response, error };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Whether an app has a live backend instance that accepts new requests. */
export function isAppRunning(id: string): boolean {
  const backend = routableInstance(id);
  return Boolean(backend && isLive(backend));
}

/**
 * Point-in-time runtime view of one app backend, merging the live process
 * registry (is it running/starting right now?) with the memory-only lifecycle
 * snapshot (when did it last start/stop, how did it exit). Everything here
 * describes the current platform process only — nothing is read from or
 * persisted to the database.
 */
export type BackendRuntimeView = {
  state: 'running' | 'starting' | 'stopped';
  /** pid/port of the live process; null unless `state === 'running'`. */
  pid: number | null;
  port: number | null;
  /** Start of the current run when running, else of the most recent one. */
  startedAt: number | null;
  stoppedAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  restartCount: number;
  /** Whether the platform auto-restarts this backend if it exits. */
  keepAlive: boolean;
  /**
   * Retired instances still finishing the requests they hold (after a
   * deploy, rollback or stop). They receive no new requests.
   */
  drainingInstances: number;
};

export function getBackendRuntimeView(id: string): BackendRuntimeView {
  const snap: BackendRuntimeSnapshot | null = getBackendSnapshot(id);
  // Draining instances do not define the state: they are already retired,
  // so the app is `stopped` (or `starting` its replacement). They are only
  // counted, in `drainingInstances`.
  const backend = routableInstance(id);
  const live = Boolean(backend && isLive(backend));
  // Check the in-flight start first: a cold start registers its process
  // before the readiness wait completes, so "in registry" alone would report
  // `running` for a backend that isn't reachable yet.
  const state = startingRegistry().has(id)
    ? 'starting'
    : live
      ? 'running'
      : 'stopped';
  const running = state === 'running';
  return {
    state,
    pid: running ? (backend?.proc.pid ?? null) : null,
    port: running ? (backend?.port ?? null) : null,
    startedAt: running
      ? (backend?.startedAt ?? null)
      : (snap?.startedAt ?? null),
    stoppedAt: snap?.stoppedAt ?? null,
    lastExitCode: snap?.lastExitCode ?? null,
    lastExitSignal: snap?.lastExitSignal ?? null,
    lastError: snap?.lastError ?? null,
    restartCount: snap?.restartCount ?? 0,
    keepAlive: keepAliveSet().has(id),
    drainingInstances: [...(instanceRegistry().get(id) ?? [])].filter(
      (instance) =>
        instance.role !== 'run' && instance.draining && isLive(instance),
    ).length,
  };
}

/**
 * Explicitly start an app backend (Backends page). `keepAlive` re-arms the
 * auto-restart mark for long-running apps — set before the boot (matching
 * deploy/warm-start behavior) so a backend that crashes right after becoming
 * ready still self-heals.
 */
export async function startAppBackend(
  id: string,
  opts: { keepAlive: boolean; expectedDeploymentId?: string },
): Promise<void> {
  if (opts.keepAlive) setKeepAlive(id, true);
  await ensureAppRunning(id, opts.expectedDeploymentId);
}

/**
 * Stop-then-start an app backend (Backends page restart action). The previous
 * instance drains beside the new one unless `force` kills it outright.
 */
export async function restartAppBackend(
  id: string,
  opts: { keepAlive: boolean; expectedDeploymentId?: string; force?: boolean },
): Promise<void> {
  if (opts.force) killApp(id);
  else stopApp(id);
  await startAppBackend(id, opts);
}

/**
 * Stop an app backend gracefully (no-op if not running): every instance is
 * retired at once, so none receives another request, and each exits when the
 * requests it already holds finish or the drain timeout elapses. Clears the
 * keep-alive mark so long-running backends are not auto-restarted by an
 * intentional stop.
 *
 * A deploy or rollback passes the deployment it just activated as
 * `keepDeploymentId`: an instance already booted from that deployment (a
 * request raced the finalization) is the current one and is left alone.
 */
export function stopApp(
  id: string,
  opts: { keepDeploymentId?: string } = {},
): void {
  invalidateLocalBackend(id, {
    preserveKeepAlive: false,
    keepDeploymentId: opts.keepDeploymentId,
  });
}

/**
 * Kill every instance of an app immediately, in-flight requests included.
 * For archive and delete, where nothing of the app may keep running, and for
 * an explicit force stop.
 */
export function killApp(id: string): void {
  invalidateLocalBackend(id, { preserveKeepAlive: false, kill: true });
}

function invalidateLocalBackend(
  id: string,
  opts: {
    preserveKeepAlive: boolean;
    /** SIGKILL instead of draining; also takes draining instances down. */
    kill?: boolean;
    /** Leave instances and cold starts of this deployment untouched. */
    keepDeploymentId?: string;
  },
): void {
  if (!opts.preserveKeepAlive) keepAliveSet().delete(id);
  if (opts.kill) bumpKillEpoch(id);
  const keep = opts.kill ? undefined : opts.keepDeploymentId;
  // Invalidate any in-flight cold start so a subsequent ensureAppRunning() (e.g.
  // the long-running warm start right after a deploy/rollback) boots the current
  // build instead of coalescing onto a start for the build we're replacing.
  // A start that has not resolved its deployment yet is cancelled too: it may
  // be booting the replaced build, and its caller retries.
  const starting = startingRegistry();
  if (!keep || starting.get(id)?.deploymentId !== keep) {
    bumpStopEpoch(id);
    starting.delete(id);
  }
  const instances = [...(instanceRegistry().get(id) ?? [])];
  let stopped: BackendInstance | undefined;
  for (const instance of instances) {
    if (opts.kill) {
      if (instance.role !== 'run' && !instance.draining) stopped = instance;
      killInstance(instance);
    } else if (!instance.draining && instance.deploymentId !== keep) {
      if (instance.role !== 'run') stopped = instance;
      retireInstance(instance);
    }
  }
  // The exit event (matching pid) fills in the exit signal moments later;
  // record the stop itself so the moment is never lost.
  if (stopped) recordBackendStopped(id, stopped.proc.pid ?? null);
}

/**
 * Cap (bytes) on a webhook body the platform buffers in order to HMAC-sign it.
 * Signed webhooks ('platform' auth) must be read fully to compute the signature,
 * so we bound them; the unsigned passthrough path still streams without a limit.
 */
const MAX_SIGNED_BODY_BYTES = 1024 * 1024;

/**
 * Headers copied from an app backend onto the platform response.
 *
 * `node:http` does not decode `Content-Encoding`, so `Content-Length` and
 * `Content-Range` describe the bytes the client actually receives. Players
 * need that for Range (206/416), HEAD, and downloads. Connect/gRPC framing
 * headers stay so RPC streams are unchanged.
 *
 * Every other response header is dropped. A backend must not be able to set
 * cookies, widen CORS, or override CSP, HSTS, COOP/COEP/CORP, framing, or
 * clear site data on the platform origin. `Location` and `Refresh` are
 * dropped so a proxied URL cannot become an open redirect. Hop-by-hop
 * headers (`Transfer-Encoding`, `Connection`, and so on) are dropped because
 * chunked framing is already decoded before the body is streamed.
 */
const PROXY_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'vary',
  'connect-accept-encoding',
  'connect-content-encoding',
  'connect-protocol-version',
  'grpc-accept-encoding',
  'grpc-encoding',
  'grpc-message',
  'grpc-status',
] as const;

/** Statuses whose Fetch response is required to have a null body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

type BackendUpstream = {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  message: IncomingMessage;
};

function setSafeHeader(headers: Headers, name: string, value: string): void {
  try {
    headers.set(name, value);
  } catch {
    // A backend value the Fetch Headers API rejects (for example a raw
    // newline) is omitted. One bad header must not fail the response.
  }
}

function proxyResponseHeaders(upstream: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const name of PROXY_RESPONSE_HEADERS) {
    const raw = upstream[name];
    if (name === 'content-length') {
      // Only a single decimal length is safe. A duplicate or non-numeric
      // value would disagree with the unmodified body stream.
      if (typeof raw === 'string' && /^\d+$/.test(raw)) {
        setSafeHeader(headers, name, raw);
      }
      continue;
    }
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (value) setSafeHeader(headers, name, value);
  }
  // `nosniff` only tightens MIME handling. Any other value is ignored.
  const sniff = upstream['x-content-type-options'];
  if (typeof sniff === 'string' && sniff.trim().toLowerCase() === 'nosniff') {
    setSafeHeader(headers, 'x-content-type-options', 'nosniff');
  }
  return headers;
}

function responseStatusText(value: string): string {
  return /^[\t\x20-\x7E]*$/.test(value) ? value : '';
}

function proxiedResponseBody(
  method: string,
  status: number,
  upstream: IncomingMessage,
): ReadableStream<Uint8Array> | null {
  // HEAD and 204/205/304 must not carry a body. Resume so a keep-alive
  // backend socket is not stuck, and so Content-Length stays the length the
  // backend declared instead of the length of an empty stream.
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    upstream.resume();
    return null;
  }
  return Readable.toWeb(upstream) as ReadableStream<Uint8Array>;
}

function forwardToAppBackend(
  target: string,
  method: string,
  headers: Headers,
  body: Buffer | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<BackendUpstream> {
  return new Promise((resolve, reject) => {
    const outgoing: Record<string, string> = {};
    for (const [name, value] of headers) outgoing[name] = value;
    // Frame every forwarded body explicitly. Node only frames implicitly for
    // methods it expects to carry one: DELETE and OPTIONS bodies would go out
    // with neither Content-Length nor chunked encoding, so the backend reads
    // an empty body and the bytes corrupt the next request on the pooled
    // keep-alive socket.
    if (Buffer.isBuffer(body))
      outgoing['content-length'] = String(body.byteLength);
    else if (body) outgoing['transfer-encoding'] = 'chunked';
    let settled = false;
    let source: Readable | undefined;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      source?.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const req = httpRequest(
      target,
      { method, headers: outgoing, signal },
      (message) => {
        if (settled) {
          message.resume();
          return;
        }
        settled = true;
        resolve({
          status: message.statusCode ?? 502,
          statusText: message.statusMessage ?? '',
          headers: message.headers,
          message,
        });
      },
    );
    req.on('error', fail);
    if (Buffer.isBuffer(body)) {
      req.end(body);
      return;
    }
    if (!body) {
      req.end();
      return;
    }
    // DOM ReadableStream and Node's stream/web types disagree in this
    // tsconfig; the runtime value is the request body stream.
    source = Readable.fromWeb(
      body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    source.on('error', (error) => {
      req.destroy(error);
      fail(error);
    });
    source.pipe(req);
  });
}

/**
 * Reverse-proxy a platform request to the app's Deno backend.
 * `stripPrefix` is removed from the pathname before forwarding (e.g. the
 * `/api/app/<id>/rpc` Connect base path).
 *
 * When `signWithSecret` is set the body is buffered and signed with the per-app
 * key (HMAC over `<timestamp>.<body>`), forwarding `x-hatch-timestamp` +
 * `x-hatch-signature` so the backend can verify the platform vetted the call.
 *
 * Request `Range` and conditional validators are forwarded. The response status
 * (including 206, 304, and 416) and the media/cache headers listed in
 * {@link PROXY_RESPONSE_HEADERS} are copied through unchanged.
 */
export async function proxyAppRequest(
  id: string,
  request: Request,
  stripPrefix: string,
  prependPath = '',
  options: {
    stripSecretParam?: boolean;
    signWithSecret?: string;
    expectedDeploymentId?: string;
  } = {},
): Promise<Response> {
  const { port, release } = await acquireInstance(
    id,
    options.expectedDeploymentId,
  );
  // The lease covers the whole exchange. Once response headers arrive it is
  // handed to the upstream body, so a streaming response keeps its instance
  // from being idle-stopped until the stream ends or the client goes away.
  let leaseHandedOff = false;
  try {
    const upstream = await forwardProxiedRequest(
      port,
      request,
      stripPrefix,
      prependPath,
      options,
    );
    if (upstream instanceof Response) return upstream;
    upstream.message.once('close', release);
    leaseHandedOff = true;
    // Stream the upstream response body through instead of buffering it.
    return new Response(
      proxiedResponseBody(request.method, upstream.status, upstream.message),
      {
        status: upstream.status,
        statusText: responseStatusText(upstream.statusText),
        headers: proxyResponseHeaders(upstream.headers),
      },
    );
  } finally {
    if (!leaseHandedOff) release();
  }
}

/**
 * Sanitize and forward one proxied request to a backend port. Resolves with
 * the upstream once its response headers arrive, or with a platform-made
 * rejection (`Response`) when the request never reaches the backend.
 */
async function forwardProxiedRequest(
  port: number,
  request: Request,
  stripPrefix: string,
  prependPath: string,
  options: { stripSecretParam?: boolean; signWithSecret?: string },
): Promise<BackendUpstream | Response> {
  const url = new URL(request.url);
  const stripped = url.pathname.startsWith(stripPrefix)
    ? url.pathname.slice(stripPrefix.length)
    : url.pathname;
  const rest = `${prependPath}${stripped}` || '/';
  // Only the webhook proxy path strips `?secret=` (the verified shared secret);
  // for the authenticated RPC/app routes `secret` is a legitimate app parameter.
  let search = url.search;
  if (options.stripSecretParam) {
    const params = new URLSearchParams(url.search);
    params.delete('secret');
    const qs = params.toString();
    search = qs ? `?${qs}` : '';
  }
  const target = `http://127.0.0.1:${port}${rest}${search}`;

  const headers = new Headers(request.headers);
  // One policy for every App proxy, including public auth:none webhooks.
  // Connection can nominate additional hop-by-hop headers. Snapshot names
  // before deletion so adjacent reserved fields cannot escape sanitization.
  for (const name of (headers.get('connection') ?? '').split(',')) {
    if (name.trim()) headers.delete(name.trim());
  }
  const reservedHeaders = [...headers.keys()].filter(
    (name) => name.startsWith('x-hatch-') || name.startsWith('x-forwarded-'),
  );
  for (const name of reservedHeaders) headers.delete(name);

  // Strip platform credentials and client-controlled routing/secret headers so a
  // deployed app can neither read the platform's Better Auth session nor the
  // webhook secret, nor spoof forwarding headers. Also drop hop-by-hop headers.
  for (const header of [
    'host',
    'cookie',
    'authorization',
    'x-api-key',
    'x-real-ip',
    'proxy-connection',
    'x-hatch-secret',
    // Platform→backend signature headers. Strip them from inbound requests so
    // a client can never present forged signing headers; the platform re-signs
    // below (signWithSecret) or via the direct callAppBackend path.
    'x-hatch-timestamp',
    'x-hatch-signature',
    'x-hatch-cron',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'via',
    'content-length',
  ]) {
    headers.delete(header);
  }
  // Always request the identity representation. Connect unary treats
  // Accept-Encoding as response-compression negotiation; `identity` keeps
  // that response uncompressed while a gzip request body (Content-Encoding)
  // can still be decompressed by the backend. Media ranges then describe the
  // same bytes as Content-Length and Content-Range. This proxy does not
  // decode the response: a backend that compresses anyway has Content-Encoding
  // and those exact bytes forwarded.
  headers.set('accept-encoding', 'identity');
  let backendBody: Buffer | ReadableStream<Uint8Array> | null = null;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (options.signWithSecret) {
    // Signed forward (platform webhook): buffer the (bounded) body so we can
    // HMAC it, then attach the platform signature headers. GET/HEAD sign over an
    // empty payload. Reject oversize bodies rather than buffer unbounded memory.
    // Sign the RAW bytes (not a UTF-8 decode) so binary/non-UTF-8 webhook bodies
    // verify correctly against the exact forwarded bytes.
    let payload = Buffer.alloc(0);
    if (hasBody) {
      // Reject early when Content-Length already declares an oversize body...
      const declared = Number(request.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_SIGNED_BODY_BYTES) {
        return new Response('Payload too large', { status: 413 });
      }
      // ...but a missing/incorrect Content-Length (e.g. chunked transfer) can't
      // be trusted, so read the stream incrementally and abort the moment the
      // running total exceeds the cap rather than buffering it all first.
      const reader = request.body?.getReader();
      if (reader) {
        const parts: Buffer[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_SIGNED_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            return new Response('Payload too large', { status: 413 });
          }
          parts.push(Buffer.from(value));
        }
        payload = Buffer.concat(parts, total);
      }
      backendBody = payload;
    }
    const timestamp = String(Date.now());
    headers.set(HATCH_TIMESTAMP_HEADER, timestamp);
    headers.set(
      HATCH_SIGNATURE_HEADER,
      hatchSignature(options.signWithSecret, timestamp, payload),
    );
  } else if (hasBody && request.body) {
    // Stream the request body straight through rather than buffering the whole
    // upload in memory, so a large body can't exhaust the server process.
    backendBody = request.body;
  }

  // Bound only the time to response headers: abort if the backend never
  // answers, but clear the timer once headers arrive so streaming bodies
  // (server-streaming RPCs, long downloads) are not cut off mid-flight.
  const headerTimeout = new AbortController();
  const headerTimer = setTimeout(
    () => headerTimeout.abort(new Error('app backend response timed out')),
    BACKEND_RESPONSE_TIMEOUT_MS,
  );
  if (typeof headerTimer.unref === 'function') headerTimer.unref();
  const signal = AbortSignal.any([request.signal, headerTimeout.signal]);
  try {
    return await forwardToAppBackend(
      target,
      request.method,
      headers,
      backendBody,
      signal,
    );
  } finally {
    clearTimeout(headerTimer);
  }
}
