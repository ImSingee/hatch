/** Real Deno processes: idle stop and the multi-instance drain boundary. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';

const IDLE_TIMEOUT_MS = 1000;
/** How long the fixture backend lingers after SIGTERM before exiting. */
const DRAIN_LINGER_MS = 2500;

const mocks = vi.hoisted(() => ({
  backendMode: 'serverless' as 'serverless' | 'long-running',
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hatch-instances-'));
vi.stubEnv('HATCH_DATA_DIR', dataDir);
vi.stubEnv('SECRET', 'runtime-instances-test-secret');
vi.stubEnv('HATCH_APP_IDLE_TIMEOUT_SECONDS', String(IDLE_TIMEOUT_MS / 1000));

const DEPLOYMENT_ID = 'deployment-1';

vi.mock('~/db', () => ({
  db: {
    query: {
      apps: {
        findFirst: async () => ({
          status: 'deployed',
          capabilities: { backend: true },
          backendMode: mocks.backendMode,
          signingSecret: null,
          currentDeploymentId: DEPLOYMENT_ID,
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
const { callAppBackend, getBackendRuntimeView, proxyAppRequest, stopApp } =
  await import('./runtime');

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

async function callPid(): Promise<number> {
  const response = await callAppBackend(appId, '/');
  const pid = Number(response.body);
  spawnedPids.add(pid);
  return pid;
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
  appCounter += 1;
  appId = `instances-app-${appCounter}`;
  const dir = deploymentArtifactDir(appId, DEPLOYMENT_ID);
  mkdirSync(path.join(dir, 'backend'), { recursive: true });
  writeFileSync(path.join(dir, 'backend', 'main.bundle.js'), BACKEND_SOURCE);
  writeFileSync(
    path.join(dir, 'deployment.json'),
    JSON.stringify({ deploymentId: DEPLOYMENT_ID }),
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
});

afterEach(() => {
  stopApp(appId);
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

it('stopping an app also kills its draining instances', async () => {
  const first = await callPid();
  await waitUntil(
    () => getBackendRuntimeView(appId).state === 'stopped',
    IDLE_TIMEOUT_MS + 1500,
  );
  const second = await callPid();
  expect(isAlive(first)).toBe(true);

  stopApp(appId);
  await waitUntil(() => !isAlive(first) && !isAlive(second), 2000);
  expect(getBackendRuntimeView(appId).state).toBe('stopped');
});
