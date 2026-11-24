import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hatchSignature } from '../../secrets';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.mock('~server/session-http-auth', () => ({
  // No browser session in these requests: same-origin evidence never holds.
  isTrustedSessionOrigin: () => false,
  sessionOriginError: () => null,
}));
vi.mock('~server/auth/credentials', () => ({
  authenticateCredential: async () => {
    throw new Error('no session');
  },
}));

const started: { appId: string; task: string; options: unknown }[] = [];
vi.mock('./service', () => ({
  MAX_TASK_INPUT_BYTES: 1_000_000,
  startTaskRun: async (appId: string, task: string, options: unknown) => {
    started.push({ appId, task, options });
    return { runId: 'run-1', status: 'queued' };
  },
}));

const { db, schema } = await import('~/db');
const { handleTaskEnqueue, handleTaskWebhook } = await import('./http');

const schemaWithLimit = {
  type: 'object',
  properties: { repo: { type: 'string' }, limit: { type: 'integer' } },
  additionalProperties: false,
};

async function app(id: string, webhook: boolean) {
  await db.insert(schema.apps).values({
    id,
    slug: id,
    name: id,
    status: 'deployed',
    capabilities: {
      database: false,
      frontend: false,
      widgets: false,
      backend: true,
      cron: false,
      webhook: false,
      kv: false,
      tasks: true,
    },
    webhookSecret: `${id}-webhook-secret`,
    signingSecret: `${id}-signing-secret`,
    currentDeploymentId: `${id}-dep`,
  });
  await db.insert(schema.deployments).values({
    id: `${id}-dep`,
    appId: id,
    version: 1,
    compatibilityVersion: 2,
    status: 'deployed',
    manifestNormalized: {
      tasks: {
        concurrency: 4,
        definitions: [
          {
            name: 'digest',
            method: 'RunDigest',
            cron: [],
            webhook,
            inputType: 'app.v1.Req',
            inputSchema: schemaWithLimit,
          },
        ],
      },
    } as never,
  });
}

beforeAll(async () => {
  await app('app-a', true);
  await app('app-b', false);
});
beforeEach(() => {
  started.length = 0;
});

const webhook = (appId: string, init: RequestInit & { query?: string } = {}) =>
  handleTaskWebhook({
    request: new Request(
      `http://platform.test/api/app/${appId}/tasks/digest/run${init.query ?? ''}`,
      init,
    ),
    params: { appId, taskName: 'digest' },
  });

function signed(body: string, secret: string): RequestInit {
  const timestamp = String(Date.now());
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hatch-timestamp': timestamp,
      'x-hatch-signature': hatchSignature(secret, timestamp, body),
    },
    body,
  };
}

describe('task webhook', () => {
  it('queues a run with the shared secret and coerces query input', async () => {
    const response = await webhook('app-a', {
      query: '?secret=app-a-webhook-secret&repo=a/b&limit=7',
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: 'run-1', status: 'queued' });
    expect(started).toEqual([
      {
        appId: 'app-a',
        task: 'digest',
        options: {
          trigger: 'webhook',
          input: { repo: 'a/b', limit: 7 },
          actor: null,
          requireWebhook: true,
        },
      },
    ]);
  });

  it('takes a JSON body on POST', async () => {
    const response = await webhook('app-a', {
      method: 'POST',
      headers: { 'x-hatch-secret': 'app-a-webhook-secret' },
      body: '{"repo":"c/d"}',
    });
    expect(response.status).toBe(202);
    expect(started[0]?.options).toMatchObject({ input: { repo: 'c/d' } });
  });

  it('rejects a wrong secret, no credential and a task without webhook runs', async () => {
    expect((await webhook('app-a', { query: '?secret=nope' })).status).toBe(
      403,
    );
    expect((await webhook('app-a', { method: 'POST' })).status).toBe(403);
    expect(
      (await webhook('app-b', { query: '?secret=app-b-webhook-secret' }))
        .status,
    ).toBe(404);
    expect(started).toHaveLength(0);
  });
});

describe('task enqueue from the App backend', () => {
  const enqueue = (appId: string, init: RequestInit) =>
    handleTaskEnqueue({
      request: new Request(
        `http://platform.test/api/app/${appId}/tasks/enqueue`,
        init,
      ),
      params: { appId },
    });

  it('queues a run of the signing App only', async () => {
    const body = JSON.stringify({ task: 'digest', input: { repo: 'a/b' } });
    expect(
      (await enqueue('app-a', signed(body, 'app-a-signing-secret'))).status,
    ).toBe(202);
    expect(started).toEqual([
      {
        appId: 'app-a',
        task: 'digest',
        options: { trigger: 'app', input: { repo: 'a/b' } },
      },
    ]);
    // Another App's key cannot start this App's tasks.
    expect(
      (await enqueue('app-a', signed(body, 'app-b-signing-secret'))).status,
    ).toBe(403);
    expect(started).toHaveLength(1);
  });

  it('requires a task name', async () => {
    const body = JSON.stringify({ input: {} });
    expect(
      (await enqueue('app-a', signed(body, 'app-a-signing-secret'))).status,
    ).toBe(400);
  });
});
