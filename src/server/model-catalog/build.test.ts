import { describe, expect, it } from 'vitest';
import {
  assertPlausibleUpdate,
  buildCatalog,
  CatalogBuildError,
} from './build';
import { CURATED_PROVIDERS } from './curation';
import { bundledCatalog } from './index';

const API_TYPES: Record<string, string> = {
  anthropic: 'anthropic-messages',
  'kimi-coding': 'anthropic-messages',
  'minimax-cn': 'anthropic-messages',
  openai: 'openai-responses',
};

/** Upstream data with every curated provider and its recommended models. */
function upstream(extra: Record<string, unknown[]> = {}) {
  const providers: Record<string, unknown> = {};
  const models: Record<string, unknown[]> = {};
  for (const curated of CURATED_PROVIDERS) {
    providers[curated.id] = {
      id: curated.id,
      name: curated.id,
      official: true,
      featured: false,
      api: API_TYPES[curated.id] ?? 'openai-completions',
      baseUrl: 'https://api.example.test/v1',
    };
    models[curated.id] = curated.recommended.map((id) => ({
      id,
      name: id,
      type: 'chat',
      abilities: { toolCall: true },
    }));
  }
  for (const [id, list] of Object.entries(extra))
    models[id] = [...(models[id] ?? []), ...list];
  return {
    _meta: { generatedAt: '2026-11-24T00:00:00.000Z' },
    providers,
    models,
  };
}

describe('bundled catalog', () => {
  it('offers only runnable models and recommends ones it contains', () => {
    const catalog = bundledCatalog();
    expect(catalog.providers.map((p) => p.id)).toEqual(
      CURATED_PROVIDERS.map((p) => p.id),
    );
    for (const provider of catalog.providers) {
      const models = catalog.models[provider.id];
      const chat = new Set(
        models.filter((m) => m.kind === 'chat').map((m) => m.id),
      );
      expect(provider.recommended.length).toBeGreaterThan(0);
      for (const id of provider.recommended) expect(chat).toContain(id);
      for (const model of models) {
        expect(model.reasoning || model.thinkingLevels.length === 0).toBe(true);
        expect([undefined, ...model.thinkingLevels]).toContain(
          model.defaultThinkingLevel,
        );
      }
    }
  });
});

describe('buildCatalog', () => {
  it('marks native web search only for chat models from curated search providers', () => {
    const searchable = {
      id: 'searchable',
      name: 'Searchable',
      abilities: { toolCall: true, search: true },
    };
    const { catalog } = buildCatalog(
      upstream({
        anthropic: [searchable],
        openai: [
          searchable,
          { ...searchable, id: 'searchable-image', type: 'image' },
        ],
        'kimi-coding': [searchable],
      }),
    );
    for (const id of ['anthropic', 'openai']) {
      expect(
        catalog.models[id]
          .filter((model) => model.nativeWebSearch)
          .map((model) => model.id),
      ).toEqual(['searchable']);
    }
    expect(
      catalog.models['kimi-coding'].find((model) => model.id === 'searchable'),
    ).toBeDefined();
    expect(
      catalog.models['kimi-coding'].some((model) => model.nativeWebSearch),
    ).toBe(false);
  });

  it('keeps chat models that call tools on the provider API', () => {
    const { catalog } = buildCatalog(
      upstream({
        anthropic: [
          {
            id: 'claude-x',
            name: 'Claude X',
            type: 'chat',
            abilities: { toolCall: true, reasoning: true, temperature: false },
            reasoningEffort: { enum: ['none', 'low', 'max'], default: 'low' },
            contextWindow: 1_000_000,
            maxOutput: 128_000,
            pricing: {
              currency: 'USD',
              unit: 'millionTokens',
              basePricing: { textInput: 4, textOutput: 20 },
            },
            compat: { anthropic: { supportsAdaptiveThinking: true } },
          },
          {
            id: 'old',
            name: 'Old',
            abilities: { toolCall: true },
            deprecated: true,
          },
          { id: 'no-tools', name: 'No tools', abilities: {} },
          {
            id: 'other-api',
            name: 'Other API',
            api: 'google-generative-ai',
            abilities: { toolCall: true },
          },
          {
            id: 'embed',
            name: 'Embed',
            type: 'embedding',
            api: null,
            abilities: {},
          },
          { id: 'draw', name: 'Draw', type: 'image', api: null, abilities: {} },
        ],
        openai: [
          {
            id: 'gpt-image-9',
            name: 'GPT Image 9',
            type: 'image',
            api: null,
            abilities: {},
          },
          { broken: true },
        ],
      }),
    );
    const anthropic = catalog.models.anthropic;
    expect(anthropic.map((m) => m.id)).not.toEqual(
      expect.arrayContaining(['old', 'no-tools', 'other-api', 'embed', 'draw']),
    );
    expect(anthropic.find((m) => m.id === 'claude-x')).toMatchObject({
      kind: 'chat',
      reasoning: true,
      thinkingLevels: ['off', 'low', 'max'],
      defaultThinkingLevel: 'low',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 4, output: 20, cacheRead: 0, cacheWrite: 0 },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    });
    // Image models only where an image driver is verified.
    expect(
      catalog.models.openai.find((m) => m.id === 'gpt-image-9')?.kind,
    ).toBe('image');
  });

  it('keeps only https links, without tracking parameters', () => {
    const raw = upstream();
    Object.assign(raw.providers.openai as object, {
      apiKeyUrl: 'https://platform.example.test/keys?utm_source=lobehub&tab=1',
      url: 'http://insecure.example.test',
    });
    const openai = buildCatalog(raw).catalog.providers.find(
      (p) => p.id === 'openai',
    );
    expect(openai?.apiKeyUrl).toBe('https://platform.example.test/keys?tab=1');
    expect(openai?.url).toBeUndefined();
  });

  it('refuses data missing a curated provider or its model list', () => {
    const missing = upstream();
    delete missing.providers.anthropic;
    expect(() => buildCatalog(missing)).toThrow(CatalogBuildError);
    const noModels = upstream();
    delete (noModels.models as Record<string, unknown>).deepseek;
    expect(() => buildCatalog(noModels)).toThrow(/no model list/);
    const malformed = upstream();
    (malformed.models as Record<string, unknown>).deepseek = { broken: true };
    expect(() => buildCatalog(malformed)).toThrow(/no model list/);
    expect(() => buildCatalog({ providers: {} })).toThrow(CatalogBuildError);
  });

  it('keeps preset endpoints from curation, whatever the feed says', () => {
    const raw = upstream();
    Object.assign(raw.providers.openai as object, {
      api: 'openai-completions',
      baseUrl: 'https://attacker.example.test/v1',
    });
    const { catalog, warnings } = buildCatalog(raw);
    expect(catalog.providers.find((p) => p.id === 'openai')).toMatchObject({
      apiType: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(warnings.join('\n')).toContain('API type "openai-completions"');
    expect(warnings.join('\n')).toContain(
      'base URL "https://attacker.example.test/v1"',
    );
  });

  it('leaves out batch-only variants', () => {
    const { catalog } = buildCatalog(
      upstream({
        openrouter: [
          { id: 'x/model', name: 'X', abilities: { toolCall: true } },
          {
            id: 'x/model:batch',
            name: 'X batch',
            abilities: { toolCall: true },
          },
          {
            id: 'x/model-batch',
            name: 'X batch',
            abilities: { toolCall: true },
          },
        ],
      }),
    );
    const ids = catalog.models.openrouter.map((m) => m.id);
    expect(ids).toContain('x/model');
    expect(ids).not.toContain('x/model:batch');
    expect(ids).not.toContain('x/model-batch');
  });

  it('drops a recommendation the data no longer has, with a warning', () => {
    const raw = upstream();
    raw.models.anthropic = [
      {
        id: 'other',
        name: 'Other',
        type: 'chat',
        abilities: { toolCall: true },
      },
    ];
    const { catalog, warnings } = buildCatalog(raw);
    expect(
      catalog.providers.find((p) => p.id === 'anthropic')?.recommended,
    ).toEqual([]);
    expect(warnings.join('\n')).toContain('anthropic');
  });

  it('rejects an update that loses most chat models', () => {
    const current = buildCatalog(
      upstream({
        openai: Array.from({ length: 40 }, (_, i) => ({
          id: `m-${i}`,
          name: `M ${i}`,
          abilities: { toolCall: true },
        })),
      }),
    ).catalog;
    const next = buildCatalog(upstream()).catalog;
    expect(() => assertPlausibleUpdate(next, current)).toThrow(/drop/);
    expect(() => assertPlausibleUpdate(current, next)).not.toThrow();
  });
});
