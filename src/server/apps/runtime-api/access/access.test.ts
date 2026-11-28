import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCapabilities, JsonObject } from '~/db/schema';

const mocks = vi.hoisted(() => ({
  proxyAppRequest:
    vi.fn<
      (
        id: string,
        request: Request,
        stripPrefix: string,
        prependPath: string,
        options: unknown,
      ) => Promise<Response>
    >(),
  queryDataTable: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mutateDataTable: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  startTaskRun: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getTaskRun: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('~server/apps/runtime', () => ({
  BackendDeploymentChangedError: class extends Error {},
  proxyAppRequest: mocks.proxyAppRequest,
}));
vi.mock('~server/apps/data-table/service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  queryDataTable: mocks.queryDataTable,
  mutateDataTable: mocks.mutateDataTable,
}));
vi.mock('~server/apps/tasks/service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startTaskRun: mocks.startTaskRun,
  getTaskRun: mocks.getTaskRun,
}));

vi.stubEnv('APP_URL', 'https://hatch.test');
vi.stubEnv('SECRET', 'platform-secret');

const { db, schema } = await import('~/db');
const { eq } = await import('drizzle-orm');
const {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  appAccessSignaturePayload,
  hatchSignature,
} = await import('~server/secrets');
const { handleAppAccessRequest } = await import('./index');

const NO_CAPABILITIES: AppCapabilities = {
  database: false,
  frontend: false,
  widgets: false,
  backend: false,
  cron: false,
  webhook: false,
  kv: false,
};

const CALLER_SECRET = 'caller-secret';
const TARGET_SECRET = 'target-secret';

const grants = [
  {
    app: 'target',
    alias: 'todos',
    rpc: ['app.v1.TodoService/ListTodos'],
    dataTables: { read: ['items'], write: ['notes'] },
    tasks: ['digest'],
    webhook: ['/ingest', '/media/*'],
  },
];

async function seed(
  id: string,
  options: {
    secret: string;
    capabilities: Partial<AppCapabilities>;
    appAccess?: unknown;
    status?: 'deployed' | 'archived';
  },
) {
  await db.insert(schema.apps).values({
    id,
    slug: `${id}-slug`,
    name: id,
    status: options.status ?? 'deployed',
    signingSecret: options.secret,
    capabilities: { ...NO_CAPABILITIES, ...options.capabilities },
  });
  const [deployment] = await db
    .insert(schema.deployments)
    .values({
      appId: id,
      status: 'deployed',
      manifestNormalized: (options.appAccess
        ? { appAccess: options.appAccess }
        : {}) as JsonObject,
    })
    .returning({ id: schema.deployments.id });
  await db
    .update(schema.apps)
    .set({ currentDeploymentId: deployment.id })
    .where(eq(schema.apps.id, id));
  return deployment.id;
}

/** A request the caller's backend signs as the SDK does. */
function signed(
  relative: string,
  init: RequestInit & { secret?: string; caller?: string } = {},
) {
  const url = new URL(
    `https://hatch.test/api/app/${init.caller ?? 'caller'}/access/${relative}`,
  );
  const method = init.method ?? 'POST';
  const timestamp = String(Date.now());
  const pathAndQuery = `${url.pathname.slice(
    `/api/app/${init.caller ?? 'caller'}/access`.length,
  )}${url.search}`;
  const headers = new Headers(init.headers);
  headers.set(HATCH_TIMESTAMP_HEADER, timestamp);
  headers.set(
    HATCH_SIGNATURE_HEADER,
    hatchSignature(
      init.secret ?? CALLER_SECRET,
      timestamp,
      appAccessSignaturePayload(init.caller ?? 'caller', method, pathAndQuery),
    ),
  );
  return new Request(url, { ...init, method, headers });
}

async function call(request: Request) {
  const response = await handleAppAccessRequest({ request });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain-text bodies stay as text.
  }
  return { status: response.status, body };
}

let targetDeploymentId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.apps);
  await seed('caller', {
    secret: CALLER_SECRET,
    capabilities: { backend: true },
    appAccess: grants,
  });
  targetDeploymentId = await seed('target', {
    secret: TARGET_SECRET,
    capabilities: {
      backend: true,
      dataTable: true,
      tasks: true,
      webhook: true,
    },
  });
  mocks.proxyAppRequest.mockImplementation(async () => new Response('proxied'));
});

describe('caller authentication', () => {
  it('rejects a bad signature before anything else is read', async () => {
    const result = await call(
      signed('todos/rpc/app.v1.TodoService/ListTodos', {
        secret: 'wrong',
        body: '{}',
      }),
    );
    expect(result).toMatchObject({
      status: 401,
      body: { code: 'unauthenticated' },
    });
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });

  it('binds the signature to the method and path', async () => {
    const original = signed('todos/rpc/app.v1.TodoService/ListTodos');
    const moved = new Request(
      'https://hatch.test/api/app/caller/access/todos/rpc/app.v1.TodoService/DeleteTodo',
      { method: 'POST', headers: original.headers },
    );
    const otherMethod = new Request(original.url, {
      method: 'GET',
      headers: original.headers,
    });
    expect((await call(moved)).status).toBe(401);
    expect((await call(otherMethod)).status).toBe(401);
  });

  it('rejects a signature that names another caller', async () => {
    const result = await call(
      signed('todos/rpc/app.v1.TodoService/ListTodos', {
        caller: 'target',
        secret: CALLER_SECRET,
      }),
    );
    expect(result.status).toBe(401);
  });

  it('refuses browser and platform credentials outright', async () => {
    for (const header of ['cookie', 'authorization', 'x-api-key']) {
      const result = await call(
        signed('todos/rpc/app.v1.TodoService/ListTodos', {
          headers: { [header]: 'value' },
        }),
      );
      expect(result).toMatchObject({
        status: 403,
        body: { code: 'permission_denied' },
      });
    }
  });
});

describe('authorization', () => {
  it('rejects a target the caller did not declare', async () => {
    const result = await call(signed('elsewhere/rpc/a.B/C'));
    expect(result).toMatchObject({
      status: 403,
      body: { code: 'permission_denied' },
    });
  });

  it('follows the caller deployment, so a rollback drops the grant', async () => {
    const [plain] = await db
      .insert(schema.deployments)
      .values({
        appId: 'caller',
        version: 2,
        status: 'deployed',
        manifestNormalized: {},
      })
      .returning({ id: schema.deployments.id });
    await db
      .update(schema.apps)
      .set({ currentDeploymentId: plain.id })
      .where(eq(schema.apps.id, 'caller'));
    const result = await call(signed('todos/rpc/app.v1.TodoService/ListTodos'));
    expect(result.status).toBe(403);
  });

  it('reports an archived target as not found', async () => {
    await db
      .update(schema.apps)
      .set({ status: 'archived' })
      .where(eq(schema.apps.id, 'target'));
    const result = await call(signed('todos/rpc/app.v1.TodoService/ListTodos'));
    expect(result).toMatchObject({
      status: 404,
      body: { code: 'not_found' },
    });
  });
});

describe('rpc', () => {
  it('forwards a granted method with the caller identity, by alias or id', async () => {
    for (const target of ['todos', 'target']) {
      const request = signed(`${target}/rpc/app.v1.TodoService/ListTodos`, {
        body: '{}',
      });
      expect((await call(request)).status).toBe(200);
      expect(mocks.proxyAppRequest).toHaveBeenLastCalledWith(
        'target',
        request,
        `/api/app/caller/access/${target}/rpc`,
        '',
        {
          expectedDeploymentId: targetDeploymentId,
          caller: { appId: 'caller', secret: TARGET_SECRET },
        },
      );
    }
  });

  it('rejects an undeclared method and a malformed one', async () => {
    expect(
      (await call(signed('todos/rpc/app.v1.TodoService/DeleteTodo'))).status,
    ).toBe(403);
    expect((await call(signed('todos/rpc/not-a-method'))).status).toBe(404);
  });
});

describe('webhook', () => {
  it('forwards a granted path to the target webhook', async () => {
    const request = signed('todos/hook/media/a.png', { method: 'PUT' });
    expect((await call(request)).status).toBe(200);
    expect(mocks.proxyAppRequest).toHaveBeenCalledWith(
      'target',
      request,
      '/api/app/caller/access/todos/hook',
      '/__webhook',
      {
        expectedDeploymentId: targetDeploymentId,
        caller: { appId: 'caller', secret: TARGET_SECRET },
      },
    );
  });

  it('rejects paths outside the grant', async () => {
    expect((await call(signed('todos/hook/ingest/more'))).status).toBe(403);
    expect((await call(signed('todos/hook'))).status).toBe(403);
  });

  it('needs the target webhook capability', async () => {
    await db
      .update(schema.apps)
      .set({ capabilities: { ...NO_CAPABILITIES, backend: true } })
      .where(eq(schema.apps.id, 'target'));
    const result = await call(signed('todos/hook/ingest'));
    expect(result).toMatchObject({
      status: 503,
      body: { code: 'unavailable' },
    });
  });
});

describe('data', () => {
  it('queries a readable table on the target', async () => {
    mocks.queryDataTable.mockResolvedValue({ items: [], nextCursor: null });
    const result = await call(
      signed('todos/data/query', {
        body: JSON.stringify({ table: 'items' }),
      }),
    );
    expect(result).toEqual({
      status: 200,
      body: { items: [], nextCursor: null },
    });
    expect(mocks.queryDataTable).toHaveBeenCalledWith(
      'target',
      { table: 'items' },
      { expectedDeploymentId: targetDeploymentId },
    );
  });

  it('never lets a read grant mutate', async () => {
    const result = await call(
      signed('todos/data/mutate', {
        body: JSON.stringify({
          operations: [{ type: 'insert', table: 'items', value: {} }],
        }),
      }),
    );
    expect(result.status).toBe(403);
    expect(mocks.mutateDataTable).not.toHaveBeenCalled();
  });

  it('rejects the whole batch when one operation is outside the grant', async () => {
    const result = await call(
      signed('todos/data/mutate', {
        body: JSON.stringify({
          operations: [
            { type: 'insert', table: 'notes', value: {} },
            { type: 'delete', table: 'secrets', id: '1' },
          ],
        }),
      }),
    );
    expect(result.status).toBe(403);
    expect(mocks.mutateDataTable).not.toHaveBeenCalled();
  });

  it('mutates a writable table and reads it too', async () => {
    mocks.mutateDataTable.mockResolvedValue({ results: [] });
    mocks.queryDataTable.mockResolvedValue({ items: [] });
    const body = {
      operations: [{ type: 'insert', table: 'notes', value: {} }],
    };
    expect(
      (await call(signed('todos/data/mutate', { body: JSON.stringify(body) })))
        .status,
    ).toBe(200);
    expect(mocks.mutateDataTable).toHaveBeenCalledWith('target', body, {
      expectedDeploymentId: targetDeploymentId,
    });
    expect(
      (
        await call(
          signed('todos/data/query', {
            body: JSON.stringify({ table: 'notes' }),
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe('tasks', () => {
  it('starts a granted task as the calling App', async () => {
    mocks.startTaskRun.mockResolvedValue({ runId: 'run-1', status: 'queued' });
    const result = await call(
      signed('todos/tasks/digest/runs', {
        body: JSON.stringify({ repo: 'x' }),
      }),
    );
    expect(result).toEqual({
      status: 202,
      body: { runId: 'run-1', status: 'queued' },
    });
    expect(mocks.startTaskRun).toHaveBeenCalledWith('target', 'digest', {
      trigger: 'app',
      actor: 'app:caller',
      input: { repo: 'x' },
    });
  });

  it('rejects an undeclared task', async () => {
    expect((await call(signed('todos/tasks/other/runs'))).status).toBe(403);
    expect(mocks.startTaskRun).not.toHaveBeenCalled();
  });

  it('reads only runs this App started', async () => {
    mocks.getTaskRun.mockResolvedValueOnce({
      id: 'run-1',
      taskName: 'digest',
      actor: 'app:caller',
    });
    expect(
      await call(signed('todos/tasks/runs/run-1', { method: 'GET' })),
    ).toMatchObject({ status: 200, body: { id: 'run-1' } });
    mocks.getTaskRun.mockResolvedValueOnce({
      id: 'run-2',
      taskName: 'digest',
      actor: 'user-1',
    });
    expect(
      (await call(signed('todos/tasks/runs/run-2', { method: 'GET' }))).status,
    ).toBe(404);
  });
});

describe('SDK contract', () => {
  const sdk = () => import('../../../../../sdk-internal/app/src/apps');

  function stubBackendEnv(env: Record<string, string>) {
    vi.stubGlobal('Deno', { env: { get: (name: string) => env[name] } });
  }

  it('signs relay requests the platform accepts', async () => {
    stubBackendEnv({
      HATCH_APP_ACCESS_URL: 'https://hatch.test/api/app/caller/access',
      HATCH_SIGNING_SECRET: CALLER_SECRET,
    });
    vi.stubGlobal('fetch', (request: Request) =>
      handleAppAccessRequest({ request }),
    );
    mocks.proxyAppRequest.mockImplementation(async () =>
      Response.json({ todos: [] }),
    );
    mocks.queryDataTable.mockResolvedValue({ items: [{ id: '1' }] });
    mocks.startTaskRun.mockResolvedValue({ runId: 'run-1', status: 'queued' });
    try {
      const { connectApp, AppAccessError } = await sdk();
      const todos = connectApp('todos');
      await expect(
        todos.call('app.v1.TodoService/ListTodos', { limit: 1 }),
      ).resolves.toEqual({ todos: [] });
      await expect(
        todos.data().query({ table: 'items' } as never),
      ).resolves.toMatchObject({ items: [{ id: '1' }] });
      await expect(todos.tasks.start('digest', { a: 1 })).resolves.toEqual({
        runId: 'run-1',
        status: 'queued',
      });
      expect((await todos.webhook('/ingest', { method: 'POST' })).ok).toBe(
        true,
      );
      const denied = await todos
        .call('app.v1.TodoService/DeleteTodo')
        .catch((error: unknown) => error);
      expect(denied).toBeInstanceOf(AppAccessError);
      expect(denied).toMatchObject({ code: 'permission_denied', status: 403 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('verifies the caller signature the platform adds when forwarding', async () => {
    stubBackendEnv({ HATCH_SIGNING_SECRET: TARGET_SECRET });
    try {
      const { appCaller, verifyPlatformRequest } = await sdk();
      const timestamp = String(Date.now());
      const forwarded = (path: string, caller = 'caller') =>
        new Request(`http://127.0.0.1:9999${path}`, {
          method: 'POST',
          headers: {
            'x-hatch-timestamp': timestamp,
            'x-hatch-caller-app': caller,
            'x-hatch-caller-signature': hatchSignature(
              TARGET_SECRET,
              timestamp,
              appAccessSignaturePayload('caller', 'POST', path),
            ),
          },
        });
      const request = forwarded('/__webhook/ingest?x=1');
      expect(await appCaller(request)).toEqual({ appId: 'caller' });
      expect(await verifyPlatformRequest(request)).toEqual({
        via: 'app',
        appId: 'caller',
      });
      // A spoofed caller id does not match the signature.
      expect(
        await appCaller(forwarded('/__webhook/ingest?x=1', 'someone-else')),
      ).toBeNull();
      // Nor does the same signature on another path.
      const moved = new Request('http://127.0.0.1:9999/__webhook/other', {
        method: 'POST',
        headers: request.headers,
      });
      expect(await appCaller(moved)).toBeNull();

      const body = 'raw-body';
      const platform = new Request('http://127.0.0.1:9999/__webhook/ingest', {
        method: 'POST',
        body,
        headers: {
          'x-hatch-timestamp': timestamp,
          'x-hatch-signature': hatchSignature(TARGET_SECRET, timestamp, body),
        },
      });
      expect(await verifyPlatformRequest(platform)).toEqual({
        via: 'platform',
      });
      expect(await platform.text()).toBe(body);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
