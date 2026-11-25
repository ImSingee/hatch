import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURATED_PROVIDERS } from './curation';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { activeCatalog, bundledCatalog, setActiveCatalog } =
  await import('./index');
const { getPlatformConfig, setPlatformConfig } =
  await import('~server/platform-config');
const { loadModelCatalog, refreshModelCatalog, updateCatalogSettings } =
  await import('./refresh');

/** Upstream data generated after the bundled snapshot, with one new model. */
function newerUpstream(generatedAt = '2099-01-01T00:00:00.000Z') {
  const bundled = bundledCatalog();
  const providers: Record<string, unknown> = {};
  const models: Record<string, unknown[]> = {};
  for (const curated of CURATED_PROVIDERS) {
    const provider = bundled.providers.find((p) => p.id === curated.id)!;
    providers[curated.id] = {
      id: provider.id,
      name: provider.name,
      api: provider.apiType,
      baseUrl: provider.baseUrl,
    };
    models[curated.id] = bundled.models[curated.id]
      .filter((model) => model.kind === 'chat')
      .map((model) => ({
        id: model.id,
        name: model.name,
        abilities: { toolCall: true },
      }));
  }
  models.openai.push({
    id: 'gpt-next',
    name: 'GPT Next',
    abilities: { toolCall: true },
  });
  return { _meta: { generatedAt }, providers, models };
}

function respond(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    ...init,
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  await db.delete(schema.modelCatalogSnapshots);
  await db.delete(schema.platformConfig);
  setActiveCatalog(bundledCatalog());
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model catalog refresh', () => {
  it('switches to newer data, then asks with the ETag and keeps it on 304', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(newerUpstream(), { headers: { etag: '"v2"' } }),
    );
    const first = await refreshModelCatalog();
    expect(first.outcome).toBe('updated');
    expect(first.status.source).toBe('downloaded');
    expect(
      activeCatalog().models.openai.some((model) => model.id === 'gpt-next'),
    ).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const second = await refreshModelCatalog();
    expect(second.outcome).toBe('unchanged');
    expect(
      new Headers(fetchMock.mock.calls[1][1]?.headers).get('if-none-match'),
    ).toBe('"v2"');
    expect(await db.$count(schema.modelCatalogSnapshots)).toBe(1);

    // Another process (or a restart) loads the stored copy.
    setActiveCatalog(bundledCatalog());
    await loadModelCatalog();
    expect(activeCatalog().source.generatedAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('keeps the catalog in use and records why when the data is bad', async () => {
    for (const body of [
      'not json',
      {
        _meta: { generatedAt: '2099-01-01T00:00:00.000Z' },
        providers: {},
        models: {},
      },
    ]) {
      fetchMock.mockResolvedValueOnce(respond(body));
      const result = await refreshModelCatalog();
      expect(result.outcome).toBe('failed');
      expect(result.status.lastError).toBeTruthy();
      expect(activeCatalog()).toBe(bundledCatalog());
    }
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect((await refreshModelCatalog()).status.lastError).toMatch(/reached/);
    expect(await db.$count(schema.modelCatalogSnapshots)).toBe(0);
  });

  it('ignores a stored catalog another Hatch version built, and rebuilds it despite the ETag', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(newerUpstream(), { headers: { etag: '"v2"' } }),
    );
    await refreshModelCatalog();
    // Simulate an upgrade: the stored copy was built with an older curation.
    const [row] = await db.select().from(schema.modelCatalogSnapshots);
    const data = row.data as { source: { curation: string } };
    data.source.curation = 'v0-old';
    await db.update(schema.modelCatalogSnapshots).set({ data: data as never });
    const status = await getPlatformConfig('models.catalogStatus');
    await setPlatformConfig('models.catalogStatus', {
      ...status,
      etagSourceUrl: status.etagSourceUrl!.replace(/#.*$/, '#v0-old'),
    });
    await loadModelCatalog();
    expect(activeCatalog()).toBe(bundledCatalog());

    fetchMock.mockResolvedValueOnce(respond(newerUpstream()));
    expect((await refreshModelCatalog()).outcome).toBe('updated');
    // The stale ETag was not sent, so the file was rebuilt.
    expect(
      new Headers(fetchMock.mock.calls[1][1]?.headers).get('if-none-match'),
    ).toBeNull();
  });

  it('prefers the bundled snapshot over older downloaded data', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(newerUpstream('2020-01-01T00:00:00.000Z')),
    );
    await refreshModelCatalog();
    await loadModelCatalog();
    expect(activeCatalog()).toBe(bundledCatalog());
  });

  it('fetches the configured mirror and accepts only https', async () => {
    await expect(
      updateCatalogSettings({ sourceUrl: 'http://mirror.example.test/m.json' }),
    ).rejects.toThrow(/https/);
    const status = await updateCatalogSettings({
      sourceUrl: 'https://mirror.example.test/m.json',
      autoUpdate: false,
    });
    expect(status).toMatchObject({
      autoUpdate: false,
      effectiveSourceUrl: 'https://mirror.example.test/m.json',
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await refreshModelCatalog();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://mirror.example.test/m.json',
    );
  });
});
