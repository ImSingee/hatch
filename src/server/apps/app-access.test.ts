import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { eq } = await import('drizzle-orm');
const { appAccessOverview, assertAppAccessTargets } =
  await import('./app-access');

async function seedApp(id: string, status: 'deployed' | 'archived') {
  await db.insert(schema.apps).values({ id, slug: id, name: id, status });
}

function grant(app: string) {
  return {
    app,
    rpc: ['*'],
    dataTables: { read: [], write: [] },
    tasks: [],
    webhook: [],
  };
}

beforeEach(async () => {
  await db.delete(schema.apps);
  await seedApp('live', 'deployed');
  await seedApp('gone', 'archived');
});

describe('deploy-time appAccess targets', () => {
  it('accepts targets that exist and are not archived', async () => {
    await expect(
      assertAppAccessTargets([grant('live')]),
    ).resolves.toBeUndefined();
    await expect(assertAppAccessTargets(undefined)).resolves.toBeUndefined();
  });

  it('names the grant whose App does not exist', async () => {
    await expect(
      assertAppAccessTargets([grant('live'), grant('missing')]),
    ).rejects.toThrow(/appAccess\[1\]\.app: .*no App with id "missing"/);
  });

  it('rejects an archived target', async () => {
    await expect(assertAppAccessTargets([grant('gone')])).rejects.toThrow(
      /appAccess\[0\]\.app: .*archived/,
    );
  });
});

describe('appAccess overview', () => {
  async function deploy(
    id: string,
    manifest: Record<string, unknown>,
    options: { dataTables?: string[]; version?: number } = {},
  ) {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        appId: id,
        version: options.version ?? 1,
        status: 'deployed',
        manifestNormalized: manifest as never,
        dataSchemaSnapshot: options.dataTables
          ? {
              version: 1,
              tables: Object.fromEntries(
                options.dataTables.map((name) => [name, {}]),
              ),
            }
          : null,
      })
      .returning({ id: schema.deployments.id });
    await db
      .update(schema.apps)
      .set({ currentDeploymentId: deployment.id })
      .where(eq(schema.apps.id, id));
  }

  const callerGrant = {
    app: 'live',
    alias: 'todos',
    rpc: ['app.v1.Todo/List', 'app.v1.Todo/Gone', 'app.v1.Admin/*', '*'],
    dataTables: { read: ['items'], write: ['missing'] },
    tasks: ['digest', 'old'],
    webhook: ['/ingest'],
  };

  beforeEach(async () => {
    await seedApp('caller', 'deployed');
    await deploy('caller', { appAccess: [callerGrant, grant('nowhere')] });
    await deploy(
      'live',
      {
        capabilities: { webhook: true },
        api: {
          services: [
            { name: 'app.v1.Todo', methods: [{ name: 'List' }] },
            { name: 'app.v1.Other', methods: [] },
          ],
        },
        tasks: { definitions: [{ name: 'digest' }] },
      },
      { dataTables: ['items'] },
    );
  });

  it('shows what each granted item finds on the target now', async () => {
    const { outgoing } = await appAccessOverview('caller');
    expect(outgoing).toEqual([
      {
        appId: 'live',
        alias: 'todos',
        slug: 'live',
        name: 'live',
        targetStatus: 'ready',
        rpc: [
          { name: 'app.v1.Todo/List', present: true },
          { name: 'app.v1.Todo/Gone', present: false },
          { name: 'app.v1.Admin/*', present: false },
          { name: '*', present: true },
        ],
        dataTables: {
          read: [{ name: 'items', present: true }],
          write: [{ name: 'missing', present: false }],
        },
        tasks: [
          { name: 'digest', present: true },
          { name: 'old', present: false },
        ],
        webhook: [{ name: '/ingest', present: true }],
      },
      {
        appId: 'nowhere',
        alias: null,
        slug: null,
        name: null,
        targetStatus: 'missing',
        rpc: [{ name: '*', present: false }],
        dataTables: { read: [], write: [] },
        tasks: [],
        webhook: [],
      },
    ]);
  });

  it('lists the Apps whose live deployment reaches this one', async () => {
    const { incoming } = await appAccessOverview('live');
    expect(incoming).toEqual([
      {
        appId: 'caller',
        alias: 'todos',
        slug: 'caller',
        name: 'caller',
        // Marked against this App's own live deployment, as outgoing is.
        rpc: [
          { name: 'app.v1.Todo/List', present: true },
          { name: 'app.v1.Todo/Gone', present: false },
          { name: 'app.v1.Admin/*', present: false },
          { name: '*', present: true },
        ],
        dataTables: {
          read: [{ name: 'items', present: true }],
          write: [{ name: 'missing', present: false }],
        },
        tasks: [
          { name: 'digest', present: true },
          { name: 'old', present: false },
        ],
        webhook: [{ name: '/ingest', present: true }],
      },
    ]);
    // Rolling the caller back to a deployment without the grant drops it.
    await deploy('caller', {}, { version: 2 });
    expect((await appAccessOverview('live')).incoming).toEqual([]);
  });

  it('ignores archived callers', async () => {
    await db
      .update(schema.apps)
      .set({ status: 'archived' })
      .where(eq(schema.apps.id, 'caller'));
    expect((await appAccessOverview('live')).incoming).toEqual([]);
  });
});
