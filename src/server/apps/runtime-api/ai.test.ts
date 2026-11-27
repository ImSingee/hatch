import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunModelConfig } from '~agent/protocol';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

// The provider is pi-ai's faux provider; everything else (auth, role and
// model resolution, conversion, streaming, usage) runs for real.
const provider = vi.hoisted(() => ({
  configs: [] as RunModelConfig[],
  seen: [] as { context: TranscriptContext; options?: SimpleStreamOptions }[],
  responses: [] as unknown[],
  tokensPerSecond: undefined as number | undefined,
}));
vi.mock('~agent/remote-models', () => ({
  buildRunModels: (config: RunModelConfig) => {
    provider.configs.push(config);
    const faux = fauxProvider({
      provider: config.providerId,
      models: [
        {
          id: config.model.id,
          maxTokens: config.model.maxTokens,
          cost: config.model.cost,
        },
      ],
      ...(provider.tokensPerSecond
        ? { tokensPerSecond: provider.tokensPerSecond }
        : {}),
    });
    // One scripted reply per platform request, consumed in order.
    faux.setResponses(
      (provider.responses.splice(0, 1) as FauxResponseStep[]).map(
        (step): FauxResponseStep =>
          (context, options, state, model) => {
            provider.seen.push({ context, options });
            return typeof step === 'function'
              ? step(context, options, state, model)
              : step;
          },
      ),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    return {
      models,
      picked: {
        providerId: config.providerId,
        providerName: config.providerName,
        apiType: config.apiType,
        model: faux.getModel(),
        thinkingLevel: config.thinkingLevel,
      },
    };
  },
}));

const sdk = await import('../../../../sdk-internal/app/src/ai');
const { db, schema } = await import('~/db');
const { hatchSignature } = await import('~server/secrets');
const { handleAiRequest } = await import('./ai');
const { setAppAiDefaults } = await import('~server/apps/ai/settings');

const APP = 'ai-app';
const SECRET = 'ai-signing-secret';
const ROLES = [
  { name: 'summarize', kind: 'chat', description: 'Summarize text.' },
  { name: 'cover', kind: 'image', description: 'Draw a cover.' },
];

async function seed(options: { ai?: boolean } = {}) {
  await db.insert(schema.agentProviders).values([
    {
      id: 'prov-a',
      name: 'Alpha',
      apiType: 'openai-completions',
      baseUrl: 'https://alpha.example.test/v1',
      apiKey: 'alpha-key',
      sortOrder: 0,
    },
    {
      id: 'prov-b',
      name: 'Beta',
      apiType: 'anthropic-messages',
      baseUrl: 'https://beta.example.test',
      apiKey: 'beta-key',
      sortOrder: 1,
    },
  ]);
  await db.insert(schema.agentModels).values([
    {
      id: 'model-a',
      providerId: 'prov-a',
      modelId: 'alpha-1',
      name: 'Alpha 1',
      maxTokens: 1000,
    },
    {
      id: 'model-b',
      providerId: 'prov-b',
      modelId: 'beta-1',
      name: 'Beta 1',
      maxTokens: 2000,
    },
  ]);
  await db.insert(schema.apps).values({
    id: APP,
    slug: APP,
    name: 'AI App',
    status: 'deployed',
    capabilities: {
      database: false,
      frontend: false,
      widgets: false,
      backend: true,
      cron: false,
      webhook: false,
      kv: false,
      ai: options.ai ?? true,
    },
    signingSecret: SECRET,
    currentDeploymentId: `${APP}-deployment`,
  });
  await db.insert(schema.deployments).values({
    id: `${APP}-deployment`,
    appId: APP,
    version: 1,
    compatibilityVersion: 2,
    status: 'deployed',
    manifestNormalized: {
      id: APP,
      name: 'AI App',
      backend: { entry: 'backend/main.ts' },
      ai: { url: `/api/app/${APP}/ai`, roles: ROLES },
    },
  });
}

function call(
  action: 'chat' | 'image',
  payload: unknown,
  { secret = SECRET, signal }: { secret?: string; signal?: AbortSignal } = {},
) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  return handleAiRequest({
    request: new Request(
      `https://hatch.example.test/api/app/${APP}/ai/${action}`,
      {
        method: 'POST',
        headers: {
          'x-hatch-timestamp': timestamp,
          'x-hatch-signature': hatchSignature(secret, timestamp, body),
        },
        body,
        ...(signal ? { signal } : {}),
      },
    ),
  });
}

const usageRows = () => db.query.appAiUsage.findMany({ where: { appId: APP } });

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

beforeEach(async () => {
  await db.delete(schema.appAiUsage);
  await db.delete(schema.appAiRoleBindings);
  await db.delete(schema.deployments);
  await db.delete(schema.apps);
  await db.delete(schema.agentModels);
  await db.delete(schema.agentProviders);
  await db.delete(schema.platformConfig);
  provider.configs = [];
  provider.seen = [];
  provider.responses = [];
  provider.tokensPerSecond = undefined;
});

describe('App AI endpoint boundary', () => {
  it('is not found without the ai capability and rejects other signatures', async () => {
    await seed({ ai: false });
    const absent = await call('chat', {
      role: 'summarize',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(absent.status).toBe(404);

    await db
      .update(schema.apps)
      .set({ capabilities: { ...(await capabilities()), ai: true } });
    const forged = await call(
      'chat',
      { role: 'summarize', messages: [{ role: 'user', content: 'hi' }] },
      { secret: 'other-secret' },
    );
    expect(forged.status).toBe(403);
    expect(provider.configs).toHaveLength(0);
  });

  it('only serves roles the live deployment declares, with their kind', async () => {
    await seed();
    const undeclared = await call('chat', {
      role: 'translate',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(undeclared.status).toBe(422);
    expect(await errorCode(undeclared)).toBe('ai_role_not_declared');

    const wrongKind = await call('image', { role: 'summarize', prompt: 'x' });
    expect(wrongKind.status).toBe(422);
    expect(await errorCode(wrongKind)).toBe('ai_role_kind_mismatch');

    const invalid = await call('chat', { role: 'summarize', messages: [] });
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe('ai_invalid_request');
    expect(provider.configs).toHaveLength(0);
  });

  it('runs a tool round-trip on the default model and records usage only', async () => {
    await seed();
    provider.responses = [
      fauxAssistantMessage(
        [
          fauxText('Checking.'),
          fauxToolCall('lookup', { q: 'x' }, { id: 't1' }),
        ],
        { stopReason: 'toolUse' },
      ),
    ];
    const response = await call('chat', {
      role: 'summarize',
      stream: false,
      system: 'Be brief.',
      maxTokens: 50_000,
      tools: [
        {
          name: 'lookup',
          description: 'Look something up.',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 't0',
              name: 'lookup',
              arguments: { q: 'a' },
            },
          ],
        },
        { role: 'tool', toolCallId: 't0', toolName: 'lookup', content: 'A' },
      ],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      message: { content: unknown[] };
      stopReason: string;
      model: { provider: string; id: string };
    };
    expect(result.stopReason).toBe('toolUse');
    expect(result.model).toEqual({ provider: 'Alpha', id: 'alpha-1' });
    expect(result.message.content).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'toolCall', id: 't1', name: 'lookup', arguments: { q: 'x' } },
    ]);

    // The default chat model served it, with the key kept server-side and
    // maxTokens capped at the model's limit.
    expect(provider.configs[0]).toMatchObject({
      providerId: 'prov-a',
      apiKey: 'alpha-key',
    });
    expect(provider.seen[0].options?.maxTokens).toBe(1000);
    const roles = provider.seen[0].context.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'toolResult']);

    const [row] = await usageRows();
    expect(row).toMatchObject({
      role: 'summarize',
      kind: 'chat',
      providerName: 'Alpha',
      modelId: 'alpha-1',
      status: 'ok',
    });
    expect(JSON.stringify(row)).not.toContain('first');
  });

  it('streams text deltas and one done event', async () => {
    await seed();
    provider.responses = [fauxAssistantMessage('Hello there')];
    const response = await call('chat', {
      role: 'summarize',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events.at(-1)).toBe('done');
    expect(events.filter((e) => e === 'done')).toHaveLength(1);
    const deltas = [...text.matchAll(/^event: text\ndata: (.*)$/gm)]
      .map((m) => (JSON.parse(m[1]) as { delta: string }).delta)
      .join('');
    expect(deltas).toBe('Hello there');
    expect(await usageRows()).toHaveLength(1);
  });

  it('uses the owner binding and fails closed when the bound model is disabled', async () => {
    await seed();
    await db
      .insert(schema.appAiRoleBindings)
      .values({ appId: APP, role: 'summarize', modelRowId: 'model-b' });
    provider.responses = [fauxAssistantMessage('ok')];
    const bound = await call('chat', {
      role: 'summarize',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(bound.status).toBe(200);
    expect(provider.configs[0].providerId).toBe('prov-b');

    await db.update(schema.agentModels).set({ enabled: false });
    const disabled = await call('chat', {
      role: 'summarize',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(disabled.status).toBe(409);
    expect(await errorCode(disabled)).toBe('ai_model_unavailable');
  });

  it('round-trips long provider tool-call ids and rejects tiny token limits', async () => {
    await seed();
    const id = `fc_${'x'.repeat(500)}`;
    provider.responses = [fauxAssistantMessage('ok')];
    const response = await call('chat', {
      role: 'summarize',
      stream: false,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id, name: 'lookup', arguments: {} }],
        },
        { role: 'tool', toolCallId: id, toolName: 'lookup', content: 'A' },
      ],
    });
    expect(response.status).toBe(200);
    const replayed = provider.seen[0].context.messages.find(
      (message) => message.role === 'toolResult',
    );
    expect(replayed).toMatchObject({ toolCallId: id });

    const tiny = await call('chat', {
      role: 'summarize',
      maxTokens: 15,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(tiny.status).toBe(400);
    expect(await errorCode(tiny)).toBe('ai_invalid_request');
  });

  it('never passes the provider key on in an error', async () => {
    await seed();
    provider.responses = [
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'Invalid API key: alpha-key',
      }),
    ];
    const response = await call('chat', {
      role: 'summarize',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('alpha-key');
  });

  it('serves unpicked roles with the default model for Apps', async () => {
    await seed();
    const chat = () =>
      call('chat', {
        role: 'summarize',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
    provider.responses = [
      fauxAssistantMessage('a'),
      fauxAssistantMessage('b'),
      fauxAssistantMessage('c'),
    ];
    // No default set: the first model in provider order.
    expect((await chat()).status).toBe(200);
    // The default for Apps wins over the order, by `<provider>/<model>` ref.
    await setAppAiDefaults({ chat: 'Beta/beta-1' });
    expect((await chat()).status).toBe(200);
    // Clearing it returns to the first model.
    await setAppAiDefaults({ chat: null });
    expect((await chat()).status).toBe(200);
    expect(provider.configs.map((config) => config.providerId)).toEqual([
      'prov-a',
      'prov-b',
      'prov-a',
    ]);

    // A disabled default fails closed instead of silently using another.
    await setAppAiDefaults({ chat: 'model-b' });
    await db
      .update(schema.agentModels)
      .set({ enabled: false })
      .where(eq(schema.agentModels.id, 'model-b'));
    const disabled = await chat();
    expect(disabled.status).toBe(409);
    expect(await errorCode(disabled)).toBe('ai_model_unavailable');
    await expect(setAppAiDefaults({ chat: 'Gamma/none' })).rejects.toThrow(
      /No usable chat model/,
    );
  });

  it('aborts the provider call when the caller disconnects', async () => {
    await seed();
    provider.tokensPerSecond = 5;
    provider.responses = [fauxAssistantMessage('word '.repeat(200))];
    const controller = new AbortController();
    const response = await call(
      'chat',
      { role: 'summarize', messages: [{ role: 'user', content: 'hi' }] },
      { signal: controller.signal },
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
    await vi.waitFor(async () => {
      const rows = await usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('aborted');
    });
  });
});

describe('App AI SDK against the endpoint', () => {
  const options = {
    url: `https://hatch.example.test/api/app/${APP}/ai`,
    signingSecret: SECRET,
  };
  beforeEach(() => {
    vi.stubGlobal('fetch', (input: string, init: RequestInit) =>
      handleAiRequest({ request: new Request(input, init) }),
    );
    return () => vi.unstubAllGlobals();
  });

  it('carries signed reasoning back through a tool round-trip', async () => {
    await seed();
    provider.responses = [
      fauxAssistantMessage(
        [
          { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig-1' },
          fauxToolCall('lookup', { q: 'x' }, { id: 't1' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('done'),
    ];
    const { result, steps } = await sdk.runTools(
      {
        role: 'summarize',
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          {
            name: 'lookup',
            description: 'Look up.',
            parameters: { type: 'object', properties: {} },
            run: () => 'found',
          },
        ],
      },
      options,
    );
    expect(steps).toBe(2);
    expect(sdk.replyText(result)).toBe('done');
    // The second request replays the thinking block with its signature.
    const replayed = provider.seen[1].context.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(replayed?.content).toContainEqual(
      expect.objectContaining({
        type: 'thinking',
        thinking: 'plan',
        thinkingSignature: 'sig-1',
      }),
    );

    const tampered = await call('chat', {
      role: 'summarize',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'reasoning', state: 'x' }] },
      ],
    });
    expect(tampered.status).toBe(400);
    expect(await errorCode(tampered)).toBe('ai_invalid_request');
  });

  it('reports an unreachable platform and a bad step limit as AiError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('connection refused');
    });
    const request = {
      role: 'summarize',
      messages: [{ role: 'user' as const, content: 'hi' }],
    };
    await expect(sdk.complete(request, options)).rejects.toMatchObject({
      name: 'AiError',
      code: 'ai_request_failed',
    });
    await expect(
      sdk.runTools({ ...request, tools: [], maxSteps: Number.NaN }, options),
    ).rejects.toMatchObject({ code: 'ai_invalid_request' });
  });

  it('stops the provider call when the App stops reading the stream', async () => {
    await seed();
    provider.tokensPerSecond = 5;
    provider.responses = [fauxAssistantMessage('word '.repeat(200))];
    for await (const event of sdk.chat(
      { role: 'summarize', messages: [{ role: 'user', content: 'hi' }] },
      options,
    )) {
      if (event.type === 'text') break;
    }
    await vi.waitFor(async () => {
      const rows = await usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('aborted');
    });
  });
});

async function capabilities() {
  const app = await db.query.apps.findFirst({ where: { id: APP } });
  return app!.capabilities!;
}
