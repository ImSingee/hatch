import { Buffer } from 'node:buffer';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  createModels,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type JsonObject,
} from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxModelDefinition,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  composerModelText,
  type AgentComposerContentPart,
} from './composer-content';
import type { AgentStreamEvent } from './events';
import type { SteerMessage } from './protocol';
import type { PlatformClient } from './platform-client';
import type { ResolvedModel } from './remote-models';
import { nextUserTurn } from './user-turns';
import type { EnvBridge } from './tools';
import { MAX_EDIT_DETAILS_BYTES } from './tools/edit-diff';
import { MAX_WEB_SEARCH_CONTENT_CHARS } from './tools/web';

// runtime.ts resolves its workspace paths at module load, so point it at an
// isolated temporary root before importing it.
const originalDataDir = process.env.HATCH_DATA_DIR;
const dataDir = await mkdtemp(path.join(tmpdir(), 'hatch-agent-runtime-test-'));
process.env.HATCH_DATA_DIR = dataDir;
const { runAgentTurn } = await import('./runtime');
const { agentWorkDir } = await import('./paths');
const { agentShellEnv } = await import('./shell-env');
const { writeEnvFile } = await import('./env-file');

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.HATCH_DATA_DIR;
  else process.env.HATCH_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const stubPlatform = new Proxy({} as PlatformClient, {
  get(_target, prop) {
    return () => {
      throw new Error(`Unexpected PlatformClient.${String(prop)} call.`);
    };
  },
});

const ARTICLE_URL = 'https://example.com/article';

/** A Tavily extract response for the `web_fetch` tool. */
function extractResponse(url: string, rawContent: string): Response {
  return Response.json({
    results: [{ url, raw_content: rawContent }],
    failed_results: [],
  });
}

async function runWithResponse(
  response: ReturnType<typeof fauxAssistantMessage>,
  sessionId: string,
) {
  return runWithResponses([response], sessionId);
}

async function runWithResponses(
  responses: FauxResponseStep[],
  sessionId: string,
  emit: (event: AgentStreamEvent) => void = () => {},
  platform: PlatformClient = stubPlatform,
  requestEnv?: EnvBridge,
  priorMessages: AgentMessage[] = [],
  composerInput?: {
    userText: string;
    composerContent: AgentComposerContentPart[];
  },
  modelOptions?: Omit<FauxModelDefinition, 'id'>,
  signal: AbortSignal = new AbortController().signal,
) {
  const providerId = `runtime-test-${sessionId}`;
  const faux = fauxProvider({
    provider: providerId,
    ...(modelOptions === undefined
      ? {}
      : { models: [{ id: 'test-model', ...modelOptions }] }),
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const picked: ResolvedModel = {
    providerId,
    providerName: 'Runtime Test',
    apiType: 'openai-responses',
    model: faux.getModel() as ResolvedModel['model'],
    thinkingLevel: 'medium',
    nativeWebSearch: false,
  };

  return runAgentTurn({
    appUrl: 'https://hatch.example.test',
    priorMessages,
    sessionId,
    userText: composerInput?.userText ?? 'hello',
    ...(composerInput
      ? { composerContent: composerInput.composerContent }
      : {}),
    models,
    picked,
    platform,
    signal,
    ...(requestEnv ? { requestEnv } : {}),
    emit,
  });
}

describe('runAgentTurn terminal outcomes', () => {
  it.each([
    [true, 'pause_turn'],
    [true, 'tool_use'],
    [undefined, undefined],
  ] as const)(
    'uses the right web tools and persists hosted search steps (native: %s, stop: %s)',
    async (enabled, stop) => {
      const models = createModels();
      const model = {
        ...fauxProvider({ provider: 'native-test' }).getModel(),
        api: 'anthropic-messages' as const,
      };
      const startBlock = (index: number, content_block: unknown) => ({
        type: 'content_block_start',
        index,
        content_block,
      });
      const requests: unknown[] = [];
      const stream = vi
        .spyOn(models, 'streamSimple')
        .mockImplementation((_model, context, options) => {
          const output = createAssistantMessageEventStream();
          void (async () => {
            const tools = getCurrentTools(context.messages).map((tool) => ({
              ...tool,
              type: 'function',
            }));
            const messages = context.messages
              .filter((message) => message.role === 'assistant')
              .map((message) => ({
                role: message.role,
                content: message.content,
              }));
            const clientResults = context.messages.filter(
              (message) => message.role === 'toolResult',
            );
            const payload = { tools, messages, clientResults };
            requests.push(
              (await options?.onPayload?.(payload, model)) ?? payload,
            );
            const startingSearch = enabled && requests.length === 1;
            const receivingSearch = enabled && requests.length === 2;
            const clientCall = {
              type: 'tool_use',
              name: 'write_file',
              id: requests.length === 1 ? 'toolu_write' : 'toolu_write_after',
              input: { path: 'search.txt', content: 'Searching' },
            };
            const usesClientTool =
              stop === 'tool_use' && (startingSearch || receivingSearch);
            if (startingSearch) {
              for (const raw of [
                startBlock(0, {
                  type: 'server_tool_use',
                  name: 'web_search',
                  id: 'srvtoolu_test',
                  input: {},
                }),
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: '{"query":"Hatch"}',
                  },
                },
                { type: 'content_block_stop', index: 0 },
              ])
                await options?.onProviderStreamEvent?.(raw, model);
            } else if (receivingSearch) {
              await options?.onProviderStreamEvent?.(
                startBlock(0, {
                  type: 'web_search_tool_result',
                  tool_use_id: 'srvtoolu_test',
                  content: [
                    {
                      type: 'web_search_result',
                      url: 'https://hatch.example.test',
                      title: 'Hatch',
                      encrypted_content: 'opaque',
                      page_age: null,
                    },
                  ],
                }),
                model,
              );
            }
            if (usesClientTool) {
              await options?.onProviderStreamEvent?.(
                startBlock(1, clientCall),
                model,
              );
              await options?.onProviderStreamEvent?.(
                { type: 'content_block_stop', index: 1 },
                model,
              );
            }
            const stopReason = usesClientTool ? 'toolUse' : 'stop';
            const message: AssistantMessage = {
              role: 'assistant',
              content: usesClientTool
                ? [
                    fauxToolCall(clientCall.name, clientCall.input, {
                      id: clientCall.id,
                    }),
                  ]
                : startingSearch
                  ? []
                  : [{ type: 'text', text: 'Search complete' }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              stopReason,
              ...(startingSearch || usesClientTool
                ? { rawStopReason: stop }
                : {}),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            };
            output.push({
              type: 'done',
              reason: stopReason,
              message,
            });
          })();
          return output;
        });
      const events: AgentStreamEvent[] = [];
      const picked = {
        providerId: model.provider,
        providerName: 'Native Test',
        apiType: model.api,
        model,
        thinkingLevel: 'off',
        ...(enabled ? { nativeWebSearch: true } : {}),
      } as ResolvedModel;
      const result = await runAgentTurn({
        appUrl: 'https://hatch.example.test',
        priorMessages: [],
        sessionId: `native-test-${enabled}-${stop}`,
        userText: 'Look up Hatch',
        models,
        picked,
        platform: stubPlatform,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      });
      expect(result.error).toBeUndefined();
      expect(requests[0]).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'web_fetch', type: 'function' }),
        ]),
      });
      const clientSearch = expect.arrayContaining([
        expect.objectContaining({ name: 'web_search', type: 'function' }),
      ]);
      const noClientSearch = expect.not.arrayContaining([
        expect.objectContaining({ name: 'web_search', type: 'function' }),
      ]);
      expect(stream).toHaveBeenCalledTimes(
        stop === 'tool_use' ? 3 : enabled ? 2 : 1,
      );
      expect(stream.mock.calls[1]?.[2]?.disableContinuation).toBe(
        enabled ? true : undefined,
      );
      expect(requests[0]).toMatchObject({
        tools: enabled ? noClientSearch : clientSearch,
      });
      const replayed = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'server_tool_use', input: { query: 'Hatch' } },
              ...(stop === 'tool_use'
                ? [{ type: 'tool_use', id: 'toolu_write' }]
                : []),
            ],
          },
        ],
        clientResults:
          stop === 'tool_use'
            ? [
                {
                  role: 'toolResult',
                  toolCallId: 'toolu_write',
                  isError: false,
                },
              ]
            : [],
      };
      const replayedResult = {
        messages: [
          ...replayed.messages,
          {
            role: 'assistant',
            content: [
              {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_test',
                content: [
                  {
                    url: 'https://hatch.example.test',
                    encrypted_content: 'opaque',
                  },
                ],
              },
              { type: 'tool_use', id: 'toolu_write_after' },
            ],
          },
        ],
        clientResults: [
          ...replayed.clientResults,
          {
            role: 'toolResult',
            toolCallId: 'toolu_write_after',
            isError: false,
          },
        ],
      };
      expect(requests.slice(1)).toMatchObject(
        stop === 'tool_use'
          ? [replayed, replayedResult]
          : enabled
            ? [replayed]
            : [],
      );
      const nativeEvents = [
        { type: 'tool_start', name: 'web_search', args: { query: 'Hatch' } },
        {
          type: 'tool_end',
          name: 'web_search',
          isError: false,
          output: expect.stringContaining('https://hatch.example.test'),
        },
      ];
      expect(
        events.filter(
          (event) =>
            (event.type === 'tool_start' || event.type === 'tool_end') &&
            event.name === 'web_search',
        ),
      ).toMatchObject(enabled ? nativeEvents : []);
      const pausedMessages = enabled
        ? [
            {
              role: 'assistant',
              content:
                stop === 'tool_use'
                  ? [{ type: 'toolCall', id: 'toolu_write' }]
                  : [],
              nativeWebSearches: [
                {
                  contentIndex: 0,
                  name: 'web_search',
                  args: { query: 'Hatch' },
                  sources: [{ url: 'https://hatch.example.test' }],
                },
              ],
            },
            ...(stop === 'tool_use'
              ? [
                  { role: 'toolResult', toolCallId: 'toolu_write' },
                  {
                    role: 'assistant',
                    content: [{ type: 'toolCall', id: 'toolu_write_after' }],
                  },
                  { role: 'toolResult', toolCallId: 'toolu_write_after' },
                ]
              : []),
          ]
        : [];
      expect(result.messages).toMatchObject([
        { role: 'user' },
        ...pausedMessages,
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Search complete' }],
        },
      ]);
      expect(result.messages.at(-1)).not.toHaveProperty('nativeWebSearches');
    },
  );

  it.each([
    ...['search_depth', 'topic', 'time_range'].map((field) => ({
      name: 'web_search',
      args: { query: 'battery research', [field]: '0' },
      field,
    })),
    {
      name: 'web_fetch',
      args: { url: 'https://example.com/article', extract_depth: '0' },
      field: 'extract_depth',
    },
  ])(
    'rejects nonempty enum $field before coercion or external calls',
    async ({ name, args, field }) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json({ query: 'battery research', results: [] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const events: AgentStreamEvent[] = [];
      const original = structuredClone(args);
      const result = await runWithResponses(
        [
          fauxAssistantMessage(fauxToolCall(name, args as JsonObject)),
          fauxAssistantMessage('done'),
        ],
        `invalid-enum-${field}`,
        (event) => events.push(event),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(events.find((event) => event.type === 'tool_end')).toMatchObject({
        isError: true,
        output: expect.stringContaining(field),
      });
      expect(events.find((event) => event.type === 'tool_start')).toMatchObject(
        {
          args: original,
        },
      );
      expect(result.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: expect.arrayContaining([
              expect.objectContaining({
                type: 'toolCall',
                arguments: original,
              }),
            ]),
          }),
        ]),
      );
      expect(args).toEqual(original);
    },
  );

  it.each([null, '', [], {}, 0])(
    'executes empty optional fields %j like omission while events and history keep the raw call',
    async (empty) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        extractResponse('https://example.com/article', 'article body'),
      );
      vi.stubGlobal('fetch', fetchMock);
      const omitted = { url: 'https://example.com/article' };
      const filled = { ...omitted, query: empty, extract_depth: empty };
      const events: AgentStreamEvent[] = [];
      const result = await runWithResponses(
        [
          fauxAssistantMessage(fauxToolCall('web_fetch', omitted)),
          fauxAssistantMessage(fauxToolCall('web_fetch', filled)),
          fauxAssistantMessage('done'),
        ],
        `empty-web-fetch-${JSON.stringify(empty)}`,
        (event) => events.push(event),
      );

      const bodies = fetchMock.mock.calls.map(([, init]) =>
        JSON.parse(String(init?.body)),
      );
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(events.filter((event) => event.type === 'tool_end')).toEqual([
        expect.objectContaining({ isError: false }),
        expect.objectContaining({ isError: false }),
      ]);
      expect(
        events.filter((event) => event.type === 'tool_start').at(-1),
      ).toMatchObject({ args: filled });
      expect(result.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: expect.arrayContaining([
              expect.objectContaining({ type: 'toolCall', arguments: filled }),
            ]),
          }),
        ]),
      );
    },
  );

  it('keeps resource snapshot metadata while exposing inline text to the model', async () => {
    const composerContent: AgentComposerContentPart[] = [
      { type: 'text', text: 'Review ' },
      {
        type: 'app',
        id: 'app-stable',
        name: 'Original Name',
        slug: 'original-slug',
      },
      { type: 'text', text: ' now.' },
    ];
    const userText =
      'Review @APP{name="Original Name" id="app-stable" slug="original-slug"}' +
      ' now.';
    const result = await runWithResponses(
      [
        (context) => {
          expect(JSON.stringify(context)).toContain(userText);
          return fauxAssistantMessage('Reviewed.');
        },
      ],
      'app-reference',
      () => {},
      stubPlatform,
      undefined,
      [],
      { userText, composerContent },
    );

    expect(result.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ composerContent })]),
    );
  });

  it('reveals only browser-classified non-secret values to the model', async () => {
    const sessionId = 'secret-canary';
    const canary = 'canary-secret-93b7f7c8-never-in-context';
    const visible = 'account-123';
    const events: AgentStreamEvent[] = [];
    const requestEnv: EnvBridge = async (_reason, variables) => {
      expect(variables).toEqual([
        {
          key: 'SERVICE_TOKEN',
          description: 'Read-only service token.',
          secret: true,
        },
        {
          key: 'ACCOUNT_ID',
          description: 'Public account identifier.',
          secret: true,
        },
      ]);
      await writeEnvFile(agentWorkDir(sessionId), [
        { key: variables[0].key, value: canary, secret: true },
        { key: variables[1].key, value: visible, secret: false },
      ]);
      return [
        { key: 'SERVICE_TOKEN', secret: true },
        { key: 'ACCOUNT_ID', value: visible, secret: false },
      ];
    };

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('request_env', {
            reason: 'Verify the private service.',
            variables: [
              {
                key: 'SERVICE_TOKEN',
                description: 'Read-only service token.',
                secret: true,
              },
              {
                key: 'ACCOUNT_ID',
                description: 'Public account identifier.',
                secret: true,
              },
            ],
          }),
        ),
        (context) => {
          expect(JSON.stringify(context)).not.toContain(canary);
          expect(JSON.stringify(context)).toContain(visible);
          return fauxAssistantMessage('Credentials are ready.');
        },
      ],
      sessionId,
      (event) => events.push(event),
      stubPlatform,
      requestEnv,
    );

    await expect(
      readFile(path.join(agentWorkDir(sessionId), '.env'), 'utf8'),
    ).resolves.toContain(canary);
    expect(JSON.stringify(events)).not.toContain(canary);
    expect(JSON.stringify(result.messages)).not.toContain(canary);
    expect(JSON.stringify(result.messages)).toContain(visible);
    expect(result.error).toBeUndefined();
  });

  it('propagates a resolved provider error with its transcript', async () => {
    const result = await runWithResponse(
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: 'OpenAI API error (402): no body',
      }),
      'provider-error',
    );

    expect(result.error).toBe('OpenAI API error (402): no body');
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'OpenAI API error (402): no body',
    });
  });

  it('propagates an aborted result without dropping partial content', async () => {
    const result = await runWithResponse(
      fauxAssistantMessage([fauxText('partial reply')], {
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
      }),
      'aborted',
    );

    expect(result.error).toBe('Request was aborted');
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial reply' }],
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
    });
  });

  it('does not stream details from tools that did not opt in', async () => {
    const sessionId = 'non-streamed-tool-details';
    const appIds = Array.from({ length: 20 }, (_, index) => `app-${index}`);
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('report_deployed_apps', { app_ids: appIds }),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );

    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'report_deployed_apps',
    );
    expect(toolEnd).toMatchObject({ isError: false });
    expect(toolEnd).not.toHaveProperty('details');

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolName === 'report_deployed_apps',
    ) as { details?: { appIds?: unknown[] } } | undefined;
    expect(toolResult?.details?.appIds).toEqual(appIds);
  });

  it('registers web search, clips its event, and bounds each result field', async () => {
    const sessionId = 'web-search-output';
    const events: AgentStreamEvent[] = [];
    const results = Array.from({ length: 5 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      content: 'x'.repeat(10_000),
      score: 1 - index / 10,
    }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ query: 'web query', results }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('web_search', {
            query: 'web query',
            max_results: 5,
          }),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );

    const toolStart = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start' && event.name === 'web_search',
    );
    expect(toolStart).toMatchObject({
      label: 'Web search',
      args: { query: 'web query', max_results: 5 },
    });
    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'web_search',
    );
    const streamedOutput = toolEnd?.output;
    expect(streamedOutput).toHaveLength(4_014);
    expect(streamedOutput?.endsWith('\n… (truncated)')).toBe(true);

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolName === 'web_search',
    ) as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const fullOutput = toolResult?.content?.[0]?.text;
    expect(fullOutput).toBeDefined();
    const output = JSON.parse(fullOutput ?? '{}') as {
      query?: string;
      results?: Array<{ content?: string; content_truncated?: boolean }>;
    };
    expect(output.query).toBe('web query');
    expect(output.results).toHaveLength(5);
    expect(output.results?.[0]).toMatchObject({
      content: 'x'.repeat(MAX_WEB_SEARCH_CONTENT_CHARS),
      content_truncated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get('X-Tavily-Access-Mode')).toBe(
      'keyless',
    );
  });

  it('keeps the Tavily key out of the model shell environment', () => {
    const original = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'tvly-shell-secret';
    try {
      expect(agentShellEnv('tavily-shell-env').TAVILY_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = original;
    }
  });

  it('streams only canonical path details for a successful write', async () => {
    const sessionId = 'streamed-write-details';
    const cwd = agentWorkDir(sessionId);
    const content = '  first line\n\nlast line\n';
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('write_file', {
            path: './nested/file.txt',
            content,
          }),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );

    const toolStart = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start' && event.name === 'write_file',
    );
    expect(toolStart?.args).toEqual({
      path: './nested/file.txt',
      content,
    });
    const absolutePath = await realpath(path.join(cwd, 'nested/file.txt'));
    expect(toolStart?.details).toEqual({
      relativePath: 'nested/file.txt',
      absolutePath,
    });

    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'write_file',
    );
    expect(toolEnd?.details).toEqual({
      path: 'nested/file.txt',
      relativePath: 'nested/file.txt',
      absolutePath,
    });

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolName === 'write_file',
    ) as { details?: unknown } | undefined;
    expect(toolResult?.details).toEqual({
      path: 'nested/file.txt',
      relativePath: 'nested/file.txt',
      absolutePath,
    });
    await expect(
      readFile(path.join(cwd, 'nested/file.txt'), 'utf8'),
    ).resolves.toBe(content);
  });

  it('persists the attempted path when a write fails validation', async () => {
    const toolName = 'write_file';
    const args = { path: 'missing-content.txt' };
    const sessionId = 'invalid-write-file';
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(fauxToolCall(toolName, args)),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );
    const canonicalCwd = await realpath(agentWorkDir(sessionId));
    const expectedDetails = {
      relativePath: args.path,
      absolutePath: path.join(canonicalCwd, args.path),
    };

    expect(
      events.find(
        (event) => event.type === 'tool_start' && event.name === toolName,
      ),
    ).toMatchObject({ details: expectedDetails });
    expect(
      events.find(
        (event) => event.type === 'tool_end' && event.name === toolName,
      ),
    ).toMatchObject({ isError: true, details: expectedDetails });
    expect(
      result.messages.find(
        (message) =>
          message !== null &&
          typeof message === 'object' &&
          !Array.isArray(message) &&
          message.role === 'toolResult' &&
          message.toolName === toolName,
      ),
    ).toMatchObject({ isError: true, details: expectedDetails });
  });

  it('does not apply current path details to a prior reused tool-call id', async () => {
    const sessionId = 'reused-file-call-id';
    const toolCallId = 'shared-read-id';
    const priorMessages: AgentMessage[] = [
      fauxAssistantMessage(
        fauxToolCall('read_file', { path: 'legacy.txt' }, { id: toolCallId }),
      ),
      {
        role: 'toolResult',
        toolCallId,
        toolName: 'read_file',
        content: [{ type: 'text', text: 'legacy contents' }],
        details: { path: 'legacy.txt' },
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall(
            'read_file',
            { path: 'current.txt', limit: 0 },
            { id: toolCallId },
          ),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      undefined,
      stubPlatform,
      undefined,
      priorMessages,
    );
    const matchingResults = result.messages.filter(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolCallId === toolCallId,
    );
    const canonicalCwd = await realpath(agentWorkDir(sessionId));

    expect(matchingResults).toHaveLength(2);
    expect(matchingResults[0]).toMatchObject({
      details: { path: 'legacy.txt' },
    });
    expect(matchingResults[0]).not.toHaveProperty('details.relativePath');
    expect(matchingResults[1]).toMatchObject({
      details: {
        relativePath: 'current.txt',
        absolutePath: path.join(canonicalCwd, 'current.txt'),
      },
    });
  });

  it('keeps large edit details bounded in stream and transcript payloads', async () => {
    const sessionId = 'bounded-edit-details';
    const cwd = agentWorkDir(sessionId);
    const original = `TOKEN${'🙂\\'.repeat(20_000)}`;
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, 'large.js'), original);
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('edit_file', {
            path: 'large.js',
            old_string: 'TOKEN',
            new_string: 'DONE',
          }),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );

    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'edit_file',
    );
    expect(toolEnd?.details).toMatchObject({
      diffTruncated: true,
      patchOmitted: true,
    });
    expect(
      Buffer.byteLength(JSON.stringify(toolEnd?.details), 'utf8'),
    ).toBeLessThanOrEqual(MAX_EDIT_DETAILS_BYTES);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: 'run.event',
          runId: sessionId,
          runnerSeq: 1,
          event: toolEnd,
        }),
        'utf8',
      ),
    ).toBeLessThan(MAX_EDIT_DETAILS_BYTES * 2);

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult',
    );
    expect(toolResult).toMatchObject({
      details: { diffTruncated: true, patchOmitted: true },
    });
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: 'run.finished',
          runId: sessionId,
          status: 'completed',
          messages: result.messages,
        }),
        'utf8',
      ),
    ).toBeLessThan(MAX_EDIT_DETAILS_BYTES * 2);
    await expect(readFile(path.join(cwd, 'large.js'), 'utf8')).resolves.toBe(
      original.replace('TOKEN', 'DONE'),
    );
  });
});

describe('runAgentTurn auto compaction', () => {
  // Compaction triggers above (400000 - 40000) * 0.8 = 288000 tokens.
  const model = { contextWindow: 400000, maxTokens: 40000 };
  const TRIGGER = 288000;
  const SUMMARY = 'condensed history';

  type ProviderContext = Parameters<
    Extract<FauxResponseStep, (...args: never[]) => unknown>
  >[0];

  const isSummaryRequest = (context: ProviderContext) =>
    getCurrentSystemPrompt(context.messages).includes(
      'context summarization assistant',
    );

  const contextText = (context: ProviderContext) =>
    JSON.stringify(context.messages);

  /**
   * Provider script that answers every summarization request with `SUMMARY`
   * and hands the agent's own requests to `replies` in order. A compaction
   * may take one or two summary calls, so the two kinds are not interleaved
   * by position.
   */
  function script(replies: ((context: ProviderContext) => AssistantMessage)[]) {
    const agentRequests: ProviderContext[] = [];
    let summaryRequests = 0;
    const step: FauxResponseStep = (context) => {
      if (isSummaryRequest(context)) {
        summaryRequests += 1;
        return fauxAssistantMessage(SUMMARY);
      }
      agentRequests.push(context);
      const reply = replies[agentRequests.length - 1];
      if (!reply) throw new Error('Unexpected extra agent request');
      return reply(context);
    };
    return {
      steps: Array.from({ length: 12 }, () => step),
      agentRequests,
      summaryRequests: () => summaryRequests,
    };
  }

  /**
   * Alternating user/assistant history. Each assistant message carries the
   * provider usage a real run records: the context size up to that reply.
   */
  function history(messages: number, chars: number): AgentMessage[] {
    const result: AgentMessage[] = [];
    let tokens = 0;
    for (let index = 0; index < messages; index++) {
      tokens += Math.ceil(chars / 4);
      if (index % 2 === 0) {
        result.push({
          role: 'user',
          content: `user-${index} ${'x'.repeat(chars)}`,
          timestamp: 1,
        } as AgentMessage);
      } else {
        const message = fauxAssistantMessage(
          `assistant-${index} ${'x'.repeat(chars)}`,
        );
        result.push({
          ...message,
          usage: { ...message.usage, input: tokens, totalTokens: tokens },
        });
      }
    }
    return result;
  }

  type Marker = {
    role: 'compactionSummary';
    summary: string;
    tokensBefore: number;
    timestamp: number;
    firstKeptIndex: number;
  };
  const roleOf = (message: unknown) => (message as { role?: string }).role;
  const markersOf = (messages: unknown[]) =>
    messages.filter(
      (message): message is Marker => roleOf(message) === 'compactionSummary',
    );
  const compactPhases = (events: AgentStreamEvent[]) =>
    events.flatMap((event) =>
      event.type === 'compact' ? [[event.reason, event.phase]] : [],
    );

  it('compacts the model context while the transcript keeps the whole history', async () => {
    const prior = history(12, 100000); // 300000 tokens by recorded usage
    const provider = script([() => fauxAssistantMessage('final answer')]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithResponses(
      provider.steps,
      'compact-threshold',
      (event) => events.push(event),
      stubPlatform,
      undefined,
      prior,
      undefined,
      model,
    );

    expect(result.error).toBeUndefined();
    // Nothing is removed or reordered: earlier turns stay where they were, so
    // the runs bound to them by user-turn position still match.
    expect(result.messages.slice(0, prior.length)).toEqual(prior);
    expect(nextUserTurn(result.messages)).toBe(nextUserTurn(prior) + 1);
    const [marker] = markersOf(result.messages);
    expect(markersOf(result.messages)).toHaveLength(1);
    expect(marker.summary).toContain(SUMMARY);
    expect(roleOf(result.messages[marker.firstKeptIndex])).not.toBe(
      'compactionSummary',
    );
    expect(marker.firstKeptIndex).toBeGreaterThan(0);

    // The model saw the summary and the kept tail, not the summarized head.
    const sent = contextText(provider.agentRequests[0]);
    expect(sent).toContain(SUMMARY);
    expect(sent).not.toContain('user-0 ');
    expect(sent).toContain('hello');

    expect(compactPhases(events)).toEqual([
      ['threshold', 'start'],
      ['threshold', 'done'],
    ]);
    // The usage recorded before the compaction no longer describes the
    // context: the estimate after it must drop under the trigger.
    const done = events.find(
      (event) => event.type === 'compact' && event.phase === 'done',
    );
    expect(done).toMatchObject({ tokensBefore: expect.any(Number) });
    if (done?.type !== 'compact') throw new Error('missing compact done');
    expect(done.tokensBefore).toBeGreaterThan(TRIGGER);
    expect(done.tokensAfter).toBeLessThan(TRIGGER);
  });

  it('continues from a stored compaction marker without compacting again', async () => {
    // A stored transcript whose head was already summarized: the marker sits
    // where the compaction happened and keeps the last two messages.
    // The newest recorded usage (300000 tokens) predates the marker and no
    // longer describes the context, so it must not trigger another pass.
    const head = history(12, 100000);
    const marker: Marker = {
      role: 'compactionSummary',
      summary: SUMMARY,
      tokensBefore: 300000,
      timestamp: 1234,
      firstKeptIndex: 10,
    };
    const prior = [...head, marker] as unknown as AgentMessage[];
    const provider = script([() => fauxAssistantMessage('second answer')]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithResponses(
      provider.steps,
      'compact-reload',
      (event) => events.push(event),
      stubPlatform,
      undefined,
      prior,
      undefined,
      model,
    );

    expect(result.error).toBeUndefined();
    expect(provider.summaryRequests()).toBe(0);
    expect(compactPhases(events)).toEqual([]);
    const sent = contextText(provider.agentRequests[0]);
    expect(sent).toContain(SUMMARY);
    expect(sent).not.toContain('user-0 ');
    expect(sent).toContain('user-10 ');
    // The stored transcript is extended, never rewritten.
    expect(result.messages.slice(0, prior.length)).toEqual(prior);
    expect(markersOf(result.messages)).toEqual([marker]);
  });

  it('leaves under-threshold history untouched', async () => {
    const provider = script([() => fauxAssistantMessage('done')]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithResponses(
      provider.steps,
      'compact-under',
      (event) => events.push(event),
      stubPlatform,
      undefined,
      history(2, 400),
      undefined,
      model,
    );

    expect(result.error).toBeUndefined();
    expect(provider.summaryRequests()).toBe(0);
    expect(markersOf(result.messages)).toEqual([]);
    expect(compactPhases(events)).toEqual([]);
  });

  it('compacts inside the turn once the context grows past the threshold', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      extractResponse(ARTICLE_URL, 'x'.repeat(30000)),
    );
    vi.stubGlobal('fetch', fetchMock);
    // 100000 recorded tokens: under the 104000 trigger of this model when the
    // turn starts. The first request's reported usage (the same history plus
    // the system prompt and tool schemas) and the ~7500-token tool result put
    // the context over it before the request that follows the tool call.
    const prior = history(4, 100000);
    const provider = script([
      () =>
        fauxAssistantMessage(fauxToolCall('web_fetch', { url: ARTICLE_URL })),
      () => fauxAssistantMessage('final answer'),
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithResponses(
      provider.steps,
      'compact-mid-turn',
      (event) => events.push(event),
      undefined,
      undefined,
      prior,
      undefined,
      { contextWindow: 150000, maxTokens: 20000 },
    );

    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The first request went out whole; the one after the tool result did not.
    expect(contextText(provider.agentRequests[0])).toContain('user-0 ');
    const afterTool = contextText(provider.agentRequests[1]);
    expect(afterTool).toContain(SUMMARY);
    expect(afterTool).not.toContain('user-0 ');
    expect(result.messages.slice(0, prior.length)).toEqual(prior);
    expect(markersOf(result.messages)).toHaveLength(1);
    expect(result.messages.map(roleOf)).toContain('toolResult');
    expect(compactPhases(events)).toEqual([
      ['threshold', 'start'],
      ['threshold', 'done'],
    ]);
  });

  it('recovers from a provider context-length rejection without repeating tool work', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      extractResponse(ARTICLE_URL, 'small result'),
    );
    vi.stubGlobal('fetch', fetchMock);
    // 100000 recorded tokens: the estimate never crosses the trigger, but the
    // provider rejects the request that follows the tool call anyway.
    const prior = history(4, 100000);
    const provider = script([
      () =>
        fauxAssistantMessage(fauxToolCall('web_fetch', { url: ARTICLE_URL })),
      () =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'prompt is too long: 99999 tokens > 40000 maximum',
        }),
      () => fauxAssistantMessage('recovered answer'),
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithResponses(
      provider.steps,
      'compact-overflow',
      (event) => events.push(event),
      undefined,
      undefined,
      prior,
      undefined,
      model,
    );

    expect(result.error).toBeUndefined();
    // The tool ran once and its result is still part of the turn.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(
      1,
    );
    const resent = contextText(provider.agentRequests[2]);
    expect(resent).toContain(SUMMARY);
    expect(resent).toContain('small result');
    // The rejection never became part of the reply.
    expect(JSON.stringify(result.messages)).not.toContain('prompt is too long');
    expect(JSON.stringify(result.messages)).toContain('recovered answer');
    expect(markersOf(result.messages)).toHaveLength(1);
    expect(compactPhases(events)).toEqual([
      ['overflow', 'start'],
      ['overflow', 'done'],
    ]);
  });

  const toolCallReply = () =>
    fauxAssistantMessage(fauxToolCall('web_fetch', { url: ARTICLE_URL }));

  it('starts no model or tool work for a run stopped before its turn began', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    const result = await runWithResponses(
      script([toolCallReply, () => fauxAssistantMessage('never')]).steps,
      'compact-stopped-early',
      undefined,
      undefined,
      undefined,
      history(2, 400),
      undefined,
      model,
      controller.signal,
    );

    expect(result.error).toMatch(/abort/i);
    expect(fetchMock).not.toHaveBeenCalled();
    // The stopped turn's user message is still part of the transcript.
    expect(nextUserTurn(result.messages)).toBe(2);
  });

  it('starts no model or tool work for a run stopped during a compaction', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const step: FauxResponseStep = (context) => {
      if (isSummaryRequest(context)) {
        controller.abort();
        return fauxAssistantMessage(SUMMARY);
      }
      return toolCallReply();
    };
    const events: AgentStreamEvent[] = [];
    const prior = history(12, 100000);
    const result = await runWithResponses(
      Array.from({ length: 6 }, () => step),
      'compact-stopped-compacting',
      (event) => events.push(event),
      undefined,
      undefined,
      prior,
      undefined,
      model,
      controller.signal,
    );

    expect(result.error).toMatch(/abort/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markersOf(result.messages)).toEqual([]);
    expect(result.messages.slice(0, prior.length)).toEqual(prior);
    expect(compactPhases(events)).toEqual([
      ['threshold', 'start'],
      ['threshold', 'failed'],
    ]);
  });

  it('reports the provider rejection when there is nothing left to compact', async () => {
    const provider = script([
      () =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'prompt is too long: 99999 tokens > 40000 maximum',
        }),
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithResponses(
      provider.steps,
      'compact-overflow-nothing',
      (event) => events.push(event),
      stubPlatform,
      undefined,
      history(2, 400),
      undefined,
      model,
    );

    expect(result.error).toContain('prompt is too long');
    expect(provider.agentRequests).toHaveLength(1);
    expect(compactPhases(events)).toEqual([]);
  });

  it('does not compact on provider errors unrelated to context length', async () => {
    const provider = script([
      () =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'rate limit exceeded, retry later',
        }),
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithResponses(
      provider.steps,
      'compact-no-retry',
      (event) => events.push(event),
      stubPlatform,
      undefined,
      history(4, 100000),
      undefined,
      model,
    );

    expect(result.error).toContain('rate limit');
    expect(provider.agentRequests).toHaveLength(1);
    expect(compactPhases(events)).toEqual([]);
  });
});

describe('runAgentTurn steer messages', () => {
  async function runWithSteer(
    responses: FauxResponseStep[],
    sessionId: string,
    batches: SteerMessage[][],
    emit: (event: AgentStreamEvent) => void,
  ) {
    const providerId = `runtime-steer-${sessionId}`;
    const faux = fauxProvider({ provider: providerId });
    faux.setResponses(responses);
    const models = createModels();
    models.setProvider(faux.provider);
    const claim = vi.fn<() => Promise<SteerMessage[]>>(
      async () => batches.shift() ?? [],
    );
    const result = await runAgentTurn({
      appUrl: 'https://hatch.example.test',
      priorMessages: [],
      sessionId,
      userText: 'Build a tracker',
      models,
      picked: {
        providerId,
        providerName: 'Runtime Test',
        apiType: 'openai-responses',
        model: faux.getModel() as ResolvedModel['model'],
        thinkingLevel: 'medium',
        nativeWebSearch: false,
      },
      platform: stubPlatform,
      signal: new AbortController().signal,
      steer: { pending: () => batches.length > 0, claim },
      emit,
    });
    return { result, claim };
  }

  const steer = (
    id: string,
    userText: string,
    composerContent: AgentComposerContentPart[] = [],
  ): SteerMessage => ({
    id,
    userText,
    composerContent,
    images: [],
    attachments: [],
  });

  const userTexts = (messages: readonly unknown[]) =>
    messages
      .filter(
        (message): message is { role: 'user'; content: unknown } =>
          (message as { role?: unknown }).role === 'user',
      )
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content as { type: string; text?: string }[])
              .map((part) => part.text ?? '')
              .join(''),
      );

  it('injects every claimed message after the tool calls, before the next model call', async () => {
    const events: AgentStreamEvent[] = [];
    let seenByModel: string[] = [];
    const app = {
      type: 'app' as const,
      id: 'app-1',
      name: 'Tracker',
      slug: 'tracker',
    };
    const fix: AgentComposerContentPart[] = [
      { type: 'text', text: 'Also fix ' },
      app,
    ];
    const { result, claim } = await runWithSteer(
      [
        fauxAssistantMessage(
          fauxToolCall('write_file', { path: 'a.txt', content: 'x' }),
        ),
        (context) => {
          seenByModel = userTexts(context.messages);
          return fauxAssistantMessage('done');
        },
      ],
      'steer-after-tools',
      [[steer('p1', 'Use blue'), steer('p2', composerModelText(fix), fix)]],
      (event) => events.push(event),
    );

    expect(claim).toHaveBeenCalledTimes(1);
    expect(seenByModel).toEqual([
      'Build a tracker',
      'Use blue',
      composerModelText(fix),
    ]);
    const order = events
      .filter((event) => ['tool_end', 'user_message'].includes(event.type))
      .map((event) =>
        event.type === 'user_message' ? event.pendingId : event.type,
      );
    expect(order).toEqual(['tool_end', 'p1', 'p2']);
    expect(events).toContainEqual({
      type: 'user_message',
      pendingId: 'p2',
      text: 'Also fix @Tracker',
      composerContent: fix,
      images: [],
    });

    const users = result.messages.filter(
      (message) => (message as { role?: unknown }).role === 'user',
    );
    expect(users).toMatchObject([
      { role: 'user' },
      { steered: true, pendingMessageId: 'p1' },
      { steered: true, pendingMessageId: 'p2', composerContent: fix },
    ]);
    expect(users[0]).not.toHaveProperty('steered');
    // Steered messages belong to the run: still one user turn.
    expect(nextUserTurn(result.messages)).toBe(1);
  });

  it('continues the run after a final answer when a steer message arrived', async () => {
    const events: AgentStreamEvent[] = [];
    const { result } = await runWithSteer(
      [fauxAssistantMessage('first answer'), fauxAssistantMessage('revised')],
      'steer-after-answer',
      [[steer('p1', 'Make it shorter')]],
      (event) => events.push(event),
    );
    expect(
      result.messages.map(
        (message) =>
          (message as { role: string; steered?: boolean }).steered ??
          (message as { role: string }).role,
      ),
    ).toEqual(['user', 'assistant', true, 'assistant']);
    expect(result.error).toBeUndefined();
  });
});

describe('runAgentTurn with transcripts stored by pi 0.83', () => {
  const roleOf = (message: unknown) => (message as { role?: string }).role;
  const usage = (input: number) => ({
    input,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const assistant = (
    content: unknown[],
    stopReason: string,
    extra: Record<string, unknown> = {},
  ) => ({
    role: 'assistant',
    api: 'openai-completions',
    provider: '01PROVFAKE000000000000000A',
    model: 'fake-model',
    responseId: 'c1',
    content,
    stopReason,
    usage: usage(500),
    timestamp: 1795539657286,
    ...extra,
  });
  // The shapes pi 0.83 and the Hatch platform stored before the upgrade:
  // signed thinking, tool calls with details, an aborted partial reply, a
  // steered message with Hatch metadata, an image, and a compaction marker
  // that keeps the history from index 4.
  const stored = [
    { role: 'user', content: 'OLD-REQUEST', timestamp: 1 },
    assistant(
      [
        {
          type: 'thinking',
          thinking: 'OLD-THINKING',
          thinkingSignature: 'reasoning_content',
        },
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'read_file',
          arguments: { path: 'a.ts' },
        },
      ],
      'toolUse',
    ),
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read_file',
      content: [{ type: 'text', text: 'OLD-FILE' }],
      details: { path: '/work/a.ts' },
      isError: false,
      timestamp: 3,
    },
    assistant([{ type: 'text', text: 'OLD-ANSWER' }], 'stop'),
    {
      role: 'user',
      content: [
        { type: 'text', text: 'KEPT-REQUEST' },
        {
          type: 'image',
          data: Buffer.from('png').toString('base64'),
          mimeType: 'image/png',
        },
      ],
      steered: true,
      pendingMessageId: '01m8789abrkjvhj58wj3tmpxjs',
      injectedAt: '2026-11-24T17:05:17.080Z',
      timestamp: 5,
    },
    assistant([{ type: 'text', text: 'PARTIAL' }], 'aborted', {
      errorMessage: 'Request was aborted',
    }),
    {
      role: 'compactionSummary',
      summary: 'SUMMARY-OF-OLD',
      tokensBefore: 24599,
      timestamp: 7,
      firstKeptIndex: 4,
      details: { readFiles: ['a.ts'], modifiedFiles: [] },
    },
    { role: 'user', content: 'AFTER-COMPACTION', timestamp: 8 },
    assistant([{ type: 'text', text: 'AFTER-ANSWER' }], 'stop'),
  ] as unknown as AgentMessage[];

  it('sends the compacted context and keeps the stored transcript intact', async () => {
    let sent:
      | Parameters<Extract<FauxResponseStep, (...args: never[]) => unknown>>[0]
      | undefined;
    const result = await runWithResponses(
      [
        (context) => {
          sent = context;
          return fauxAssistantMessage('NEW-ANSWER');
        },
      ],
      'stored-by-pi-083',
      undefined,
      undefined,
      undefined,
      structuredClone(stored),
    );

    expect(result.error).toBeUndefined();
    const messages = sent!.messages;
    // The prompt and tools lead the request as its system message.
    expect(messages[0].role).toBe('system');
    expect(getCurrentSystemPrompt(messages)).toContain('Hatch');
    expect(getCurrentTools(messages).map((tool) => tool.name)).toContain(
      'read_file',
    );
    // History before the marker's kept message is replaced by its summary.
    const text = JSON.stringify(messages);
    for (const dropped of ['OLD-REQUEST', 'OLD-FILE', 'OLD-ANSWER']) {
      expect(text).not.toContain(dropped);
    }
    const order = [
      'The conversation history before this point was compacted',
      'SUMMARY-OF-OLD',
      'KEPT-REQUEST',
      'AFTER-COMPACTION',
      'AFTER-ANSWER',
      'hello',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The stored items come back unchanged, the marker still pointing at the
    // same kept message, followed by this turn; no system message is stored.
    expect(result.messages.slice(0, stored.length)).toEqual(stored);
    expect(result.messages.map(roleOf).slice(stored.length)).toEqual([
      'user',
      'assistant',
    ]);
    expect(result.messages.map(roleOf)).not.toContain('system');
  });
});
