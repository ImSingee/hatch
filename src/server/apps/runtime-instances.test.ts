/**
 * Real Deno processes: idle stop, the multi-instance drain boundary, and the
 * graceful retirement a deploy, rollback or stop performs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';

const IDLE_TIMEOUT_MS = 1000;
/** How long the fixture backend lingers after SIGTERM before exiting. */
const DRAIN_LINGER_MS = 2500;

/** How long a retired instance may keep finishing in-flight requests. */
const DRAIN_TIMEOUT_MS = 2000;

const mocks = vi.hoisted(() => ({
  backendMode: 'serverless' as 'serverless' | 'long-running',
  currentDeploymentId: 'deployment-1',
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hatch-instances-'));
vi.stubEnv('HATCH_DATA_DIR', dataDir);
vi.stubEnv('SECRET', 'runtime-instances-test-secret');
vi.stubEnv('HATCH_APP_IDLE_TIMEOUT_SECONDS', String(IDLE_TIMEOUT_MS / 1000));
vi.stubEnv('HATCH_APP_DRAIN_TIMEOUT_SECONDS', String(DRAIN_TIMEOUT_MS / 1000));

const DEPLOYMENT_ID = 'deployment-1';
const NEXT_DEPLOYMENT_ID = 'deployment-2';

vi.mock('~/db', () => ({
  db: {
    query: {
      apps: {
        findFirst: async () => ({
          status: 'deployed',
          capabilities: { backend: true },
          backendMode: mocks.backendMode,
          signingSecret: null,
          currentDeploymentId: mocks.currentDeploymentId,
        }),
      },
      deployments: {
        findFirst: async () => ({
          compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION,
        }),
      },
    },
  },
  schema: {},
}));

const { deploymentArtifactDir } = await import('~agent/paths');
const {
  BackendDeploymentChangedError,
  callAppBackend,
  ensureAppRunning,
  getBackendRuntimeView,
  killApp,
  proxyAppRequest,
  setKeepAlive,
  startAppBackend,
  stopApp,
} = await import('./runtime');

const BACKEND_SOURCE = `
Deno.addSignalListener('SIGTERM', () => {
  setTimeout(() => Deno.exit(0), ${DRAIN_LINGER_MS});
});
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/stream') return new Response(String(Deno.pid));
    const holdMs = Number(url.searchParams.get('ms'));
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(String(Deno.pid)));
          setTimeout(() => controller.close(), holdMs);
        },
      }),
    );
  },
};
`;

let appId = '';
let appCounter = 0;
const spawnedPids = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function callPid(expectedDeploymentId?: string): Promise<number> {
  const response = await callAppBackend(
    appId,
    '/',
    undefined,
    expectedDeploymentId,
  );
  const pid = Number(response.body);
  spawnedPids.add(pid);
  return pid;
}

/** Open a request whose response body stays in flight for `holdMs`. */
async function openStream(holdMs: number) {
  const response = await proxyAppRequest(
    appId,
    new Request(`http://platform.test/rpc/stream?ms=${holdMs}`),
    '/rpc',
  );
  const reader = response.body!.getReader();
  const pid = Number(new TextDecoder().decode((await reader.read()).value));
  spawnedPids.add(pid);
  return { pid, reader };
}

/** Make the next deployment the active one, as a committed deploy does. */
function activateNextDeployment(): void {
  mocks.currentDeploymentId = NEXT_DEPLOYMENT_ID;
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not reached');
    await delay(25);
  }
}

beforeEach(() => {
  mocks.backendMode = 'serverless';
  mocks.currentDeploymentId = DEPLOYMENT_ID;
  appCounter += 1;
  appId = `instances-app-${appCounter}`;
  for (const deploymentId of [DEPLOYMENT_ID, NEXT_DEPLOYMENT_ID]) {
    const dir = deploymentArtifactDir(appId, deploymentId);
    mkdirSync(path.join(dir, 'backend'), { recursive: true });
    writeFileSync(path.join(dir, 'backend', 'main.bundle.js'), BACKEND_SOURCE);
    writeFileSync(
      path.join(dir, 'deployment.json'),
      JSON.stringify({ deploymentId }),
    );
    writeFileSync(
      path.join(dir, 'manifest.normalized.json'),
      JSON.stringify({
        backend: {
          entry: 'backend/main.bundle.js',
          format: 'bundle-v1',
          runtime: 'deno-serve',
          network: [],
        },
      }),
    );
  }
});

afterEach(() => {
  setKeepAlive(appId, false);
  killApp(appId);
  for (const pid of spawnedPids) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  spawnedPids.clear();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

it('stops an idle serverless backend and serves the next request from a new instance without waiting for the drain', async () => {
  const first = await callPid();
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid: first,
  });

  // Idle timeout passes: the instance is retired but still exiting.
  await waitUntil(
    () => getBackendRuntimeView(appId).state === 'stopped',
    IDLE_TIMEOUT_MS + 1500,
  );
  expect(isAlive(first)).toBe(true);

  // Hold a streaming request open so the replacement stays busy for the
  // whole drain of its predecessor.
  const response = await proxyAppRequest(
    appId,
    new Request(`http://platform.test/rpc/stream?ms=${DRAIN_LINGER_MS + 1500}`),
    '/rpc',
  );
  const reader = response.body!.getReader();
  const second = Number(new TextDecoder().decode((await reader.read()).value));
  spawnedPids.add(second);
  expect(second).not.toBe(first);
  // The request neither waited for the old instance to exit nor revived it.
  expect(isAlive(first)).toBe(true);
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid: second,
  });

  // The old instance finishes its drain without disturbing the new one.
  await waitUntil(() => !isAlive(first), DRAIN_LINGER_MS + 2000);
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid: second,
    stoppedAt: expect.any(Number),
  });
  expect(await callPid()).toBe(second);
  await reader.cancel();
});

it('keeps an instance alive while a streaming response is in flight', async () => {
  const holdMs = IDLE_TIMEOUT_MS * 2;
  const response = await proxyAppRequest(
    appId,
    new Request(`http://platform.test/rpc/stream?ms=${holdMs}`),
    '/rpc',
  );
  const startedAt = Date.now();
  const pid = Number(await response.text());
  spawnedPids.add(pid);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(holdMs - 100);
  // Only now does the idle clock start.
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid,
  });
  await waitUntil(
    () => getBackendRuntimeView(appId).state === 'stopped',
    IDLE_TIMEOUT_MS + 1500,
  );
});

it('never idle-stops a long-running backend', async () => {
  mocks.backendMode = 'long-running';
  const pid = await callPid();
  await delay(IDLE_TIMEOUT_MS * 2);
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid,
  });
  expect(await callPid()).toBe(pid);
});

it('lets a request in flight across a deploy finish while the new deployment serves new requests', async () => {
  // Long-running, so the idle timer never retires the instances under test.
  mocks.backendMode = 'long-running';
  const holdMs = 1500;
  const inFlight = await openStream(holdMs);
  const openedAt = Date.now();

  // The deploy commits, then retires every instance of the previous build.
  activateNextDeployment();
  stopApp(appId, { keepDeploymentId: NEXT_DEPLOYMENT_ID });
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'stopped',
    drainingInstances: 1,
  });

  // New requests are served by the new deployment beside the retired one.
  const next = await callPid(NEXT_DEPLOYMENT_ID);
  expect(next).not.toBe(inFlight.pid);
  expect(isAlive(inFlight.pid)).toBe(true);
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid: next,
    drainingInstances: 1,
  });

  // The old request runs to its natural end instead of being cut off.
  expect((await inFlight.reader.read()).done).toBe(true);
  expect(Date.now() - openedAt).toBeGreaterThanOrEqual(holdMs - 200);

  // A later finalization of the same deploy leaves the new instance alone.
  stopApp(appId, { keepDeploymentId: NEXT_DEPLOYMENT_ID });
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid: next,
  });

  // With nothing left in flight the retired instance exits on its own.
  await waitUntil(() => !isAlive(inFlight.pid), DRAIN_LINGER_MS + 2000);
  expect(getBackendRuntimeView(appId).drainingInstances).toBe(0);
});

it('terminates a stopped instance whose request outlives the drain timeout', async () => {
  const inFlight = await openStream(60_000);

  stopApp(appId);
  expect(getBackendRuntimeView(appId).state).toBe('stopped');
  // Still serving the request it holds for the whole drain window.
  await delay(DRAIN_TIMEOUT_MS - 500);
  expect(isAlive(inFlight.pid)).toBe(true);

  await waitUntil(() => !isAlive(inFlight.pid), 500 + DRAIN_LINGER_MS + 2000);
  await inFlight.reader.cancel().catch(() => {});
});

it('does not take down the active instance for a caller holding a superseded deployment', async () => {
  activateNextDeployment();
  const current = await callPid(NEXT_DEPLOYMENT_ID);

  await expect(callPid(DEPLOYMENT_ID)).rejects.toBeInstanceOf(
    BackendDeploymentChangedError,
  );
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid: current,
    drainingInstances: 0,
  });
  expect(await callPid(NEXT_DEPLOYMENT_ID)).toBe(current);
});

it('does not auto-restart a long-running instance retired by a deploy', async () => {
  mocks.backendMode = 'long-running';
  await startAppBackend(appId, { keepAlive: true });
  const previous = await callPid();

  // Deploy: retire the old build, then re-arm keep-alive and warm the new one.
  activateNextDeployment();
  stopApp(appId, { keepDeploymentId: NEXT_DEPLOYMENT_ID });
  setKeepAlive(appId, true);
  await ensureAppRunning(appId, NEXT_DEPLOYMENT_ID);
  const next = await callPid(NEXT_DEPLOYMENT_ID);
  expect(next).not.toBe(previous);

  await waitUntil(() => !isAlive(previous), DRAIN_LINGER_MS + 2000);
  // Give a spurious restart timer (1s backoff) the chance to fire.
  await delay(1500);
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'running',
    pid: next,
    restartCount: 0,
    keepAlive: true,
  });
});

it('kills every instance at once, draining and in-flight ones included', async () => {
  const draining = await openStream(60_000);
  stopApp(appId);
  const routable = await openStream(60_000);
  expect(routable.pid).not.toBe(draining.pid);

  killApp(appId);
  await waitUntil(() => !isAlive(draining.pid) && !isAlive(routable.pid), 2000);
  expect(getBackendRuntimeView(appId)).toMatchObject({
    state: 'stopped',
    drainingInstances: 0,
  });
  await draining.reader.cancel().catch(() => {});
  await routable.reader.cancel().catch(() => {});
});
