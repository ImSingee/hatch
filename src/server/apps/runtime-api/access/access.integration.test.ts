/**
 * Two real sandboxed Deno backends reaching each other through the App access
 * relay over HTTP, with network policies that allow only what the platform
 * adds automatically.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';
import type { AppCapabilities, JsonObject } from '~/db/schema';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.stubEnv('SECRET', 'app-access-fixture-secret-at-least-32-characters');
vi.stubEnv('APP_URL', 'https://app-access.test');
const root = await mkdtemp(join(tmpdir(), 'hatch-app-access-'));
vi.stubEnv('HATCH_DATA_DIR', root);

const { db, schema } = await import('~/db');
const { handleAppAccessRequest } = await import('./index');
const { proxyAppRequest, stopApp } = await import('../../runtime');
const { deploymentArtifactDir } = await import('~agent/paths');

function requestHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((v) => out.append(name, v));
    else if (value !== undefined) out.set(name, value);
  }
  return out;
}

// The platform's loopback HTTP endpoint, serving only the relay route.
const platform = createServer(async (req, res) => {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: requestHeaders(req.headers),
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: 'half',
  } as RequestInit);
  const response = await handleAppAccessRequest({ request });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
});

const capabilities: AppCapabilities = {
  backend: true,
  webhook: true,
  database: false,
  frontend: false,
  widgets: false,
  cron: false,
  kv: false,
};

async function deployFixture(
  id: string,
  fixture: string,
  manifest: JsonObject,
) {
  const deploymentId = `${id}-deployment`;
  await db.insert(schema.apps).values({
    id,
    slug: id,
    name: id,
    status: 'deployed',
    currentDeploymentId: deploymentId,
    capabilities,
    signingSecret: `${id}-signing-secret`,
  });
  await db.insert(schema.deployments).values({
    id: deploymentId,
    appId: id,
    status: 'deployed',
    compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION,
    manifestNormalized: manifest,
  });
  const artifact = deploymentArtifactDir(id, deploymentId);
  await mkdir(join(artifact, 'backend'), { recursive: true });
  await writeFile(
    join(artifact, 'deployment.json'),
    JSON.stringify({ deploymentId }),
  );
  await writeFile(
    join(artifact, 'manifest.normalized.json'),
    JSON.stringify({
      ...manifest,
      backend: {
        entry: 'backend/main.mjs',
        runtime: 'deno-serve',
        format: 'bundle-v1',
        network: [],
      },
    }),
  );
  await build({
    entryPoints: [`src/server/apps/test-fixtures/${fixture}`],
    outfile: join(artifact, 'backend/main.mjs'),
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
  });
  return deploymentId;
}

let callerDeployment: string;

/** Ask the caller backend to do something, as its own RPC route would. */
async function askCaller(path: string): Promise<unknown> {
  const response = await proxyAppRequest(
    'caller',
    new Request(`https://app-access.test/api/app/caller/rpc${path}`, {
      method: 'POST',
    }),
    '/api/app/caller/rpc',
    '',
    { expectedDeploymentId: callerDeployment },
  );
  return response.json();
}

beforeAll(async () => {
  platform.listen(0, '127.0.0.1');
  await new Promise((resolve) => platform.once('listening', resolve));
  vi.stubEnv('PORT', String((platform.address() as AddressInfo).port));
  callerDeployment = await deployFixture('caller', 'app-access-caller.ts', {
    appAccess: [
      {
        app: 'target',
        alias: 'target',
        rpc: ['fixture.v1.Who/Get'],
        dataTables: { read: [], write: [] },
        tasks: [],
        webhook: ['/upload/*'],
      },
    ],
  } as JsonObject);
  await deployFixture('target', 'app-access-target.ts', {
    webhook: { auth: 'platform' },
  } as JsonObject);
}, 30_000);

afterAll(async () => {
  stopApp('caller');
  stopApp('target');
  platform.close();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('App access between real backends', () => {
  it('relays a granted RPC call and the target learns the calling App', async () => {
    expect(await askCaller('/rpc')).toEqual({
      caller: { appId: 'caller' },
      input: { hello: 'there' },
    });
  }, 60_000);

  it('rejects a method the caller did not declare', async () => {
    expect(await askCaller('/denied')).toEqual({
      error: 'permission_denied',
      status: 403,
    });
  }, 60_000);

  it('streams a webhook body far above the signed-body limit', async () => {
    const size = 20 * 1024 * 1024;
    expect(await askCaller(`/upload?size=${size}`)).toEqual({
      origin: { via: 'app', appId: 'caller' },
      path: '/__webhook/upload/clip.bin',
      bytes: size,
    });
  }, 120_000);
});
