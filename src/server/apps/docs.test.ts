import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('~agent/paths', () => ({
  deploymentArtifactDir: (id: string, deploymentId: string) =>
    `${state.root}/artifacts/${id}/${deploymentId}`,
}));

state.root = await mkdtemp(path.join(tmpdir(), 'hatch-app-docs-'));
const { db, schema } = await import('~/db');
const { listAppDocs, readAppDoc } = await import('./docs');
const { captureAppDocs, writeAppDocs, APP_DOC_MAX_BYTES } =
  await import('./docs-build');
const { sourceManifestSchema } = await import('./manifest');

const APP = '01docsapp';
const declared = (docs: unknown[]) =>
  sourceManifestSchema.parse({
    id: APP,
    name: 'Docs',
    capabilities: {},
    docs,
  }).docs;

/** Build-time capture into a deployment artifact, as a deploy would do. */
async function publish(deploymentId: string, files: Record<string, string>) {
  const src = path.join(state.root, 'src', deploymentId);
  await mkdir(path.join(src, 'docs'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(src, 'docs', `${name}.md`), body);
  }
  const captured = await captureAppDocs(
    src,
    declared(
      Object.keys(files).map((name) => ({
        id: name,
        title: `${name} title`,
        path: `docs/${name}.md`,
      })),
    ),
    'manifest.ts',
  );
  await writeAppDocs(
    path.join(state.root, 'artifacts', APP, deploymentId),
    captured,
  );
  return captured.map(({ doc }) => doc);
}

async function deployment(
  id: string,
  version: number,
  docs: Awaited<ReturnType<typeof publish>> | undefined,
) {
  await db.insert(schema.deployments).values({
    id,
    appId: APP,
    version,
    status: 'deployed',
    manifestNormalized: {
      id: APP,
      capabilities: { webhook: true },
      widgets: [],
      cron: [],
      webhook: { url: `/api/app/${APP}/hook`, auth: 'none' },
      ...(docs ? { docs } : {}),
    },
  });
}

const goLive = (currentDeploymentId: string | null) =>
  db.update(schema.apps).set({ currentDeploymentId });

beforeEach(async () => {
  await db.delete(schema.deployments);
  await db.delete(schema.apps);
  await db
    .insert(schema.apps)
    .values({ id: APP, slug: 'docs-app', name: 'Docs', status: 'deployed' });
});

afterAll(async () => {
  await rm(state.root, { recursive: true, force: true });
});

describe('App external docs', () => {
  it('serves the docs of whichever deployment is current', async () => {
    await deployment('01v1', 1, await publish('01v1', { orders: 'v1 body' }));
    await deployment(
      '01v2',
      2,
      await publish('01v2', { orders: 'v2 body', refunds: 'refunds body' }),
    );
    await goLive('01v2');

    const index = await listAppDocs(APP);
    expect(index).toMatchObject({
      version: 2,
      deploymentId: '01v2',
      endpoints: { webhook: { url: `/api/app/${APP}/hook`, auth: 'none' } },
    });
    expect(index.docs.map((doc) => doc.id)).toEqual(['orders', 'refunds']);
    await expect(readAppDoc(APP, 'orders')).resolves.toMatchObject({
      version: 2,
      content: 'v2 body',
    });

    // Rollback points the App at the older deployment and its artifact.
    await goLive('01v1');
    await expect(readAppDoc(APP, 'orders')).resolves.toMatchObject({
      version: 1,
      content: 'v1 body',
    });
    await expect(readAppDoc(APP, 'refunds')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('treats a deployment published before docs existed as having none', async () => {
    await deployment('01old', 1, undefined);
    await goLive('01old');
    await expect(listAppDocs(APP)).resolves.toMatchObject({ docs: [] });
  });

  it('rejects an App that is not live', async () => {
    await expect(listAppDocs(APP)).rejects.toMatchObject({ status: 409 });
    await deployment('01v1', 1, await publish('01v1', { orders: 'body' }));
    await goLive('01v1');
    await db.update(schema.apps).set({ status: 'archived' });
    await expect(readAppDoc(APP, 'orders')).rejects.toMatchObject({
      status: 409,
    });
    await expect(listAppDocs('missing')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('App docs manifest contract', () => {
  const pathRule = /doc path must be a \.md file under/;
  it.each([
    [[{ id: 'a', title: 'A', path: 'README.md' }], pathRule],
    [[{ id: 'a', title: 'A', path: 'docs/a.txt' }], pathRule],
    [[{ id: 'a', title: 'A', path: 'docs/../manifest.md' }], /\.\./],
    [[{ id: 'a', title: 'A', path: 'docs/.hidden.md' }], pathRule],
    [[{ id: 'A', title: 'A', path: 'docs/a.md' }], /doc id must be/],
    [[{ id: 'a', title: ' ', path: 'docs/a.md' }], /must not be blank/],
    [
      [
        { id: 'a', title: 'A', path: 'docs/a.md' },
        { id: 'a', title: 'B', path: 'docs/b.md' },
      ],
      /duplicate doc id/,
    ],
    [
      [
        { id: 'a', title: 'A', path: 'docs/a.md' },
        { id: 'b', title: 'B', path: 'docs/a.md' },
      ],
      /duplicate doc path/,
    ],
    [
      Array.from({ length: 21 }, (_, index) => ({
        id: `d${index}`,
        title: 'T',
        path: `docs/d${index}.md`,
      })),
      /at most 20|<=20/,
    ],
  ])('rejects %j', (docs, message) => {
    expect(() => declared(docs)).toThrow(message);
  });

  it('defaults to publishing nothing', () => {
    expect(declared(undefined as unknown as unknown[])).toEqual([]);
  });
});

describe('App docs capture', () => {
  const capture = async (
    files: Record<string, string | Buffer>,
    entries = Object.keys(files).map((name) => ({
      id: name,
      title: name,
      path: `docs/${name}.md`,
    })),
  ) => {
    const src = await mkdtemp(path.join(state.root, 'capture-'));
    await mkdir(path.join(src, 'docs'));
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(src, 'docs', `${name}.md`), body);
    }
    return { src, run: () => captureAppDocs(src, declared(entries), 'm.ts') };
  };

  it('records size and hash of each body', async () => {
    const { run } = await capture({ a: 'hello' });
    await expect(run()).resolves.toMatchObject([
      {
        doc: {
          id: 'a',
          bytes: 5,
          sha256:
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        },
      },
    ]);
  });

  it.each([
    ['a missing file', {}, /was not found/],
    ['an empty file', { a: '' }, /is empty/],
    ['invalid UTF-8', { a: Buffer.from([0xc3, 0x28]) }, /not valid UTF-8/],
    [
      'an oversized file',
      { a: 'x'.repeat(APP_DOC_MAX_BYTES + 1) },
      /the limit is/,
    ],
  ])('fails the build for %s', async (_label, files, message) => {
    const { run } = await capture(files, [
      { id: 'a', title: 'A', path: 'docs/a.md' },
    ]);
    await expect(run()).rejects.toThrow(message);
  });

  it('refuses a symbolic link', async () => {
    const { src, run } = await capture({}, [
      { id: 'a', title: 'A', path: 'docs/a.md' },
    ]);
    await symlink('/etc/hosts', path.join(src, 'docs', 'a.md'));
    await expect(run()).rejects.toThrow(/symbolic link/);
  });
});
