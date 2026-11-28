import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from './manifest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { rpcReference } = await import('./rpc-reference');

const APP = '01rpcapp';

const PROTO = {
  path: 'proto/service.proto',
  content: '// Keeps todos.\nservice TodoService {}\n',
};

const CURRENT: AppApi = {
  services: [
    {
      name: 'app.v1.TodoService',
      description: 'Keeps todos.',
      methods: [
        {
          name: 'ListTodos',
          description: 'Lists the todos.\n\nNewest first.',
          inputType: 'app.v1.ListTodosRequest',
          outputType: 'app.v1.ListTodosResponse',
          clientStreaming: false,
          serverStreaming: false,
          idempotency: 'no_side_effects',
        },
        {
          name: 'CreateTodo',
          inputType: 'app.v1.CreateTodoRequest',
          outputType: 'app.v1.Todo',
          clientStreaming: false,
          serverStreaming: false,
          deprecated: true,
        },
        {
          name: 'WatchTodos',
          inputType: 'app.v1.ListTodosRequest',
          outputType: 'app.v1.Todo',
          clientStreaming: false,
          serverStreaming: true,
        },
      ],
    },
  ],
  types: {
    messages: [
      {
        name: 'app.v1.ListTodosRequest',
        fields: [
          {
            name: 'list_id',
            jsonName: 'listId',
            kind: 'scalar',
            type: 'string',
            label: 'single',
            description: 'The list to read.',
          },
          {
            name: 'since',
            jsonName: 'since',
            kind: 'message',
            type: 'google.protobuf.Timestamp',
            label: 'optional',
          },
        ],
      },
      {
        name: 'app.v1.ListTodosResponse',
        fields: [
          {
            name: 'tags',
            jsonName: 'tags',
            kind: 'enum',
            type: 'app.v1.Status',
            label: 'map',
            mapKey: 'string',
          },
        ],
      },
    ],
    enums: [
      {
        name: 'app.v1.Status',
        values: [
          { name: 'STATUS_UNSPECIFIED', number: 0 },
          { name: 'STATUS_OPEN', number: 1, description: 'Still to do.' },
        ],
      },
    ],
  },
  protoFiles: [PROTO],
};

async function deploy(manifest: Record<string, unknown>) {
  await db.insert(schema.deployments).values({
    id: '01dep',
    appId: APP,
    version: 3,
    status: 'deployed',
    manifestNormalized: {
      id: APP,
      capabilities: { backend: true },
      widgets: [],
      cron: [],
      ...manifest,
    },
  });
  await db.update(schema.apps).set({ currentDeploymentId: '01dep' });
}

const withRpc = (api: AppApi) => ({
  rpc: { url: '/stale', service: 'app.v1.TodoService' },
  api,
});

beforeEach(async () => {
  await db.delete(schema.deployments);
  await db.delete(schema.apps);
  await db
    .insert(schema.apps)
    .values({ id: APP, slug: 'rpc-app', name: 'RPC', status: 'deployed' });
});

describe('RPC API reference', () => {
  it('returns the structured API and a Markdown reference built from it', async () => {
    await deploy(withRpc(CURRENT));
    const ref = await rpcReference(APP);
    expect(ref).toMatchObject({
      appId: APP,
      version: 3,
      deploymentId: '01dep',
      endpoint: { url: `/api/app/${APP}/rpc`, service: 'app.v1.TodoService' },
      complete: true,
      services: CURRENT.services,
      types: CURRENT.types,
      protoFiles: [PROTO],
    });
    const md = ref.markdown;
    expect(md).toContain('Lists the todos.\n\nNewest first.');
    expect(md).toContain(`/api/app/${APP}/rpc/app.v1.TodoService/ListTodos`);
    expect(md).toContain(
      `hatch app invoke backend ${APP} app.v1.TodoService/ListTodos`,
    );
    expect(md).toMatch(/ListTodos[\s\S]*safe to retry/i);
    expect(md).toMatch(/CreateTodo[\s\S]*deprecated/i);
    expect(md).toMatch(/CreateTodo[\s\S]*may already have run/i);
    // Streaming methods are not callable as unary JSON.
    expect(md).not.toContain('app.v1.TodoService/WatchTodos --file');
    expect(md).toContain('`listId`');
    expect(md).toContain('The list to read.');
    expect(md).toContain('map<string, app.v1.Status>');
    expect(md).toContain('Still to do.');
    expect(md).toContain('google.protobuf.Timestamp');
    expect(md).toContain('RFC 3339');
    expect(md).toContain(PROTO.content);
    expect(md).not.toMatch(/redeploy/i);
  });

  it('falls back to the method list and proto source for an older deployment', async () => {
    const { types: _types, ...older } = CURRENT;
    await deploy(
      withRpc({
        ...older,
        services: [
          {
            name: 'app.v1.TodoService',
            methods: CURRENT.services[0].methods.map(
              ({ description: _d, idempotency: _i, deprecated: _x, ...m }) => m,
            ),
          },
        ],
      }),
    );
    const ref = await rpcReference(APP);
    expect(ref.complete).toBe(false);
    expect(ref.types).toBeUndefined();
    expect(ref.markdown).toMatch(/redeploy/i);
    expect(ref.markdown).toContain('ListTodos');
    expect(ref.markdown).toContain(PROTO.content);
    // Unknown retry semantics are not guessed.
    expect(ref.markdown).not.toMatch(/safe to retry|may already have run/i);
  });

  it('is not found for an App without an RPC service', async () => {
    await deploy({});
    await expect(rpcReference(APP)).rejects.toMatchObject({ status: 404 });
  });

  it('conflicts for an archived App', async () => {
    await deploy(withRpc(CURRENT));
    await db.update(schema.apps).set({ status: 'archived' });
    await expect(rpcReference(APP)).rejects.toMatchObject({ status: 409 });
  });
});
