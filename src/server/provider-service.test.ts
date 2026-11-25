import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { bundledCatalog, catalogModel } = await import('~server/model-catalog');
const { createProvider, getModelView, getProviderView, updateProvider } =
  await import('./provider-service');
const { createProviderModel, updateProviderModel } =
  await import('./provider-models');
const { getAgentModelCatalog } = await import('./agent-model-catalog');
const { assertAgentModelAvailable } = await import('./agent-runs');

const anthropic = bundledCatalog().providers.find((p) => p.id === 'anthropic')!;
const opusId = anthropic.recommended[0];
const opus = catalogModel('anthropic', opusId)!;

beforeEach(async () => {
  await db.delete(schema.agentProviders);
  await db.delete(schema.userPreferences);
  await db.delete(schema.user);
});

describe('providers from the catalog', () => {
  it('adds a preset with its recommended models, metadata from the catalog', async () => {
    const provider = await createProvider({
      catalogProviderId: 'anthropic',
      apiKey: 'sk-test',
    });
    expect(provider).toMatchObject({
      name: anthropic.name,
      apiType: 'anthropic-messages',
      baseUrl: anthropic.baseUrl,
      catalogProviderId: 'anthropic',
      hasApiKey: true,
    });
    expect(provider).not.toHaveProperty('apiKey');
    expect(provider.models.map((m) => m.modelId)).toEqual(
      anthropic.recommended,
    );
    const model = provider.models[0];
    expect(model).toMatchObject({
      name: opus.name,
      catalogRef: `anthropic/${opusId}`,
      inCatalog: true,
      overrides: { reasoning: null, contextWindow: null, maxTokens: null },
    });
    expect(model.chat).toMatchObject({
      reasoning: true,
      contextWindow: opus.contextWindow,
      overridden: [],
    });
    expect(model.chat?.thinkingLevels).toContain(
      model.chat?.defaultThinkingLevel,
    );
  });

  it('requires connection details for a custom provider and rejects bad input', async () => {
    await expect(
      createProvider({ name: 'Mine', baseUrl: 'https://x.test', apiKey: 'k' }),
    ).rejects.toThrow(/API type/);
    await expect(
      createProvider({
        name: 'Mine',
        apiType: 'openai-completions',
        baseUrl: 'ftp://x.test',
        apiKey: 'k',
      }),
    ).rejects.toThrow(/Base URL/);
    await expect(
      createProvider({ catalogProviderId: 'nope', apiKey: 'k' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('overrides metadata per field and follows the catalog again when cleared', async () => {
    const provider = await createProvider({
      catalogProviderId: 'anthropic',
      apiKey: 'k',
      models: [{ modelId: opusId }],
    });
    const id = provider.models[0].id;
    await updateProviderModel({ id, maxTokens: 1234, reasoning: false });
    let view = await getModelView(id);
    expect(view.chat).toMatchObject({
      maxTokens: 1234,
      reasoning: false,
      thinkingLevels: [],
      defaultThinkingLevel: 'off',
    });
    expect(view.chat?.overridden.sort()).toEqual(['maxTokens', 'reasoning']);

    await updateProviderModel({ id, maxTokens: null, reasoning: null });
    view = await getModelView(id);
    expect(view.chat).toMatchObject({
      maxTokens: opus.maxTokens,
      reasoning: true,
      overridden: [],
    });
  });

  it('gives a model without catalog metadata the old defaults, and no duplicates', async () => {
    const provider = await createProvider({
      name: 'Local',
      apiType: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
      models: [{ modelId: 'local-7b' }],
    });
    expect(provider.models[0]).toMatchObject({
      catalogRef: null,
      chat: {
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 8192,
        thinkingLevels: [],
      },
    });
    await expect(
      createProviderModel({
        providerId: provider.id,
        kind: 'chat',
        modelId: 'local-7b',
      }),
    ).rejects.toThrow(/already has/);
    // A custom endpoint linked to a vendor finds that vendor's metadata.
    const linked = await createProviderModel({
      providerId: provider.id,
      kind: 'chat',
      modelId: opusId,
    });
    expect(linked.catalogRef).toBe(`anthropic/${opusId}`);
  });
});

describe('max output from the catalog', () => {
  it('leaves room for the conversation when the catalog lists a huge output', async () => {
    const { resolveModelSpec } = await import('./model-spec');
    const { bundledCatalog: catalog } = await import('~server/model-catalog');
    const [providerId, model] = Object.entries(catalog().models)
      .flatMap(([id, models]) => models.map((m) => [id, m] as const))
      .find(
        ([, m]) =>
          m.kind === 'chat' &&
          m.contextWindow !== undefined &&
          m.maxTokens !== undefined &&
          m.maxTokens > m.contextWindow / 2,
      )!;
    const row = {
      modelId: model.id,
      name: model.name,
      catalogRef: `${providerId}/${model.id}`,
      reasoning: null,
      contextWindow: null,
      maxTokens: null,
    };
    const spec = resolveModelSpec(row, 'openai-completions');
    expect(spec.maxTokens).toBe(Math.floor(model.contextWindow! / 2));
    // An explicit value is the user's call, within the context.
    expect(
      resolveModelSpec(
        { ...row, maxTokens: model.maxTokens! },
        'openai-completions',
      ).maxTokens,
    ).toBe(model.maxTokens);
  });
});

describe('a stored key stays with its endpoint', () => {
  it('requires the key again when the base URL or API type changes', async () => {
    const provider = await createProvider({
      catalogProviderId: 'anthropic',
      apiKey: 'sk-original',
      models: [],
    });
    await expect(
      updateProvider({ id: provider.id, baseUrl: 'https://evil.example.test' }),
    ).rejects.toThrow(/API key again/);
    await expect(
      updateProvider({ id: provider.id, apiType: 'openai-completions' }),
    ).rejects.toThrow(/API key again/);
    // Same endpoint (trailing slash only) or other fields: no key needed.
    await updateProvider({
      id: provider.id,
      baseUrl: `${provider.baseUrl}/`,
      name: 'Renamed',
    });
    await updateProvider({
      id: provider.id,
      baseUrl: 'https://proxy.example.test',
      apiKey: 'sk-new',
    });
    const row = await db.query.agentProviders.findFirst({
      where: { id: provider.id },
    });
    expect(row).toMatchObject({
      name: 'Renamed',
      baseUrl: 'https://proxy.example.test',
      apiKey: 'sk-new',
    });
  });
});

describe('new chats from a saved default', () => {
  it('start with the saved thinking level', async () => {
    const { insertAgentSession } = await import('./agent-session-store');
    const { id } = await insertAgentSession({
      providerId: 'p',
      modelId: 'm',
      thinkingLevel: 'xhigh',
    });
    const ignored = await insertAgentSession({ thinkingLevel: 'bogus' });
    const rows = await db.query.agentSessions.findMany({
      where: { id: { in: [id, ignored.id] } },
      columns: { id: true, thinkingLevel: true },
    });
    expect(
      Object.fromEntries(rows.map((r) => [r.id, r.thinkingLevel])),
    ).toEqual({ [id]: 'xhigh', [ignored.id]: null });
  });
});

describe('linking a provider to the catalog', () => {
  it('gives its unlinked models catalog metadata', async () => {
    const provider = await createProvider({
      name: 'Gateway',
      apiType: 'anthropic-messages',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'k',
      models: [{ modelId: 'private-model' }],
    });
    await createProviderModel({
      providerId: provider.id,
      kind: 'chat',
      modelId: opusId,
      catalogRef: null,
    });
    const linked = await updateProvider({
      id: provider.id,
      catalogProviderId: 'anthropic',
    });
    expect(
      Object.fromEntries(linked.models.map((m) => [m.modelId, m.catalogRef])),
    ).toEqual({ 'private-model': null, [opusId]: `anthropic/${opusId}` });
  });
});

describe('thinking levels and the default model', () => {
  it('rejects a level the model does not offer and defaults to the first model', async () => {
    const provider = await createProvider({
      catalogProviderId: 'anthropic',
      apiKey: 'k',
      models: [{ modelId: opusId }],
    });
    const levels = (await getProviderView(provider.id)).models[0].chat!
      .thinkingLevels;
    const unsupported = (['off', 'minimal'] as const).find(
      (level) => !levels.includes(level),
    )!;
    await expect(
      assertAgentModelAvailable(provider.id, opusId, unsupported),
    ).rejects.toThrow(/does not support/);
    await expect(
      assertAgentModelAvailable(provider.id, opusId, levels.at(-1)),
    ).resolves.toBeUndefined();

    // New chats start with the first model at its default level.
    expect((await getAgentModelCatalog()).defaultModel).toEqual({
      providerId: provider.id,
      modelId: opusId,
      thinkingLevel: (await getProviderView(provider.id)).models[0].chat!
        .defaultThinkingLevel,
    });
  });
});
