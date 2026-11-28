import { randomUUID } from 'node:crypto';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Models,
} from '@earendil-works/pi-ai';
import type { NativeWebSearch } from './native-web-search-results';

type SearchApi = 'anthropic-messages' | 'openai-responses';
type RecordValue = Record<string, unknown>;
type SearchCallbacks = {
  onSearchStart: (search: NativeWebSearch) => void;
  onSearchEnd: (search: NativeWebSearch) => void;
};
type SearchEntry = {
  search: NativeWebSearch;
  started?: boolean;
  ended?: boolean;
};

const MAX_SEARCHES = 16;
const MAX_INPUT_JSON = 16_384;
const MAX_RAW_ITEM = 32_768;
const MAX_REPLAY_SIZE = 2 * 1024 * 1024;
export const MAX_NATIVE_SEARCH_CONTINUATIONS = 3;
const SOURCE_INCLUDE = 'web_search_call.action.sources';
const ANTHROPIC_VISIBLE_BLOCKS = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
]);
const OPENAI_VISIBLE_ITEMS = new Set([
  'reasoning',
  'message',
  'function_call',
  'custom_tool_call',
]);

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value.length) return undefined;
  const text = value.slice(0, max);
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function parseInput(value: string): RecordValue | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function sources(value: unknown): NativeWebSearch['sources'] {
  return list(value)
    .slice(0, 10)
    .flatMap((source) => {
      const entry = record(source);
      const url = boundedText(entry?.url, 2048);
      const title = boundedText(entry?.title, 240);
      return url ? [{ url, ...(title ? { title } : {}) }] : [];
    });
}

export function injectNativeWebSearch(
  api: SearchApi,
  payload: unknown,
): unknown {
  const body = record(payload);
  if (!body) return payload;
  const tools = list(body.tools);
  if (api === 'anthropic-messages') {
    if (tools.some((tool) => record(tool)?.type === 'web_search_20250305'))
      return body;
    return {
      ...body,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        ...tools,
      ],
    };
  }
  const include = list(body.include);
  return {
    ...body,
    tools: tools.some((tool) => record(tool)?.type === 'web_search')
      ? tools
      : [...tools, { type: 'web_search' }],
    include: include.includes(SOURCE_INCLUDE)
      ? include
      : [...include, SOURCE_INCLUDE],
  };
}

function createAnthropicReplay() {
  const blocks = new Map<number, { content: RecordValue; input?: string }>();
  let size = 0;
  let unusable = false;
  const reserve = (length: number) => {
    size += length;
    if (size > MAX_REPLAY_SIZE) {
      unusable = true;
      blocks.clear();
    }
    return !unusable;
  };
  return {
    observe(event: RecordValue) {
      const index = event.index;
      if (unusable || typeof index !== 'number') return;
      if (event.type === 'content_block_start') {
        const content = record(event.content_block);
        if (content && reserve(JSON.stringify(content).length))
          blocks.set(index, { content: structuredClone(content) });
        return;
      }
      const block = blocks.get(index);
      if (!block) return;
      if (event.type === 'content_block_stop' && block.input !== undefined) {
        const input = parseInput(block.input);
        if (input) block.content.input = input;
        else unusable = true;
        return;
      }
      if (event.type !== 'content_block_delta') return;
      const delta = record(event.delta);
      if (!delta) return;
      switch (delta.type) {
        case 'input_json_delta':
          if (
            typeof delta.partial_json === 'string' &&
            reserve(delta.partial_json.length)
          )
            block.input = (block.input ?? '') + delta.partial_json;
          break;
        case 'text_delta':
        case 'thinking_delta':
        case 'signature_delta': {
          const field =
            delta.type === 'text_delta'
              ? 'text'
              : delta.type === 'thinking_delta'
                ? 'thinking'
                : 'signature';
          const value = delta[field];
          if (typeof value === 'string' && reserve(value.length)) {
            const prior = block.content[field];
            block.content[field] =
              (typeof prior === 'string' ? prior : '') + value;
          }
          break;
        }
        case 'citations_delta':
          if (
            record(delta.citation) &&
            reserve(JSON.stringify(delta.citation).length)
          )
            block.content.citations = [
              ...list(block.content.citations),
              structuredClone(delta.citation),
            ];
          break;
      }
    },
    content() {
      if (unusable || !blocks.size) return undefined;
      return [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]) => block.content);
    },
  };
}

export function createNativeWebSearchCollector(
  api: SearchApi,
  callbacks: SearchCallbacks,
  inherited: ReadonlyMap<string, SearchEntry> = new Map(),
) {
  const entries = new Map<string, SearchEntry>();
  const anthropic =
    api === 'anthropic-messages' ? createAnthropicReplay() : undefined;
  const anthropicCalls = new Map<
    number,
    { entry: SearchEntry; json: string }
  >();
  const openAIItems = new Map<number, { id?: string; visible: boolean }>();
  let visibleBlocks = 0;
  let receivedDeferredSearchResult = false;

  function open(id: string, contentIndex: number) {
    const existing = entries.get(id) ?? inherited.get(id);
    if (existing || entries.size >= MAX_SEARCHES) return existing;
    const entry: SearchEntry = {
      search: {
        id: `native:${api}:${id}`,
        contentIndex,
        name: 'web_search',
        args: {},
        sources: [],
      },
    };
    entries.set(id, entry);
    return entry;
  }

  function start(entry: SearchEntry) {
    if (entry.started) return;
    entry.started = true;
    callbacks.onSearchStart(entry.search);
  }

  function end(entry: SearchEntry) {
    if (entry.ended) return;
    start(entry);
    entry.ended = true;
    callbacks.onSearchEnd(entry.search);
  }

  function observeAnthropic(event: RecordValue) {
    anthropic?.observe(event);
    const index = event.index;
    if (typeof index !== 'number') return;
    if (event.type === 'content_block_start') {
      const block = record(event.content_block);
      if (typeof block?.type !== 'string') return;
      if (ANTHROPIC_VISIBLE_BLOCKS.has(block.type)) visibleBlocks++;
      if (
        block.type === 'server_tool_use' &&
        block.name === 'web_search' &&
        typeof block.id === 'string' &&
        block.id.length <= 256
      ) {
        const entry = open(block.id, visibleBlocks);
        if (!entry) return;
        const query = boundedText(record(block.input)?.query, 2000);
        if (query) {
          entry.search.args = { query };
          start(entry);
        }
        anthropicCalls.set(index, { entry, json: '' });
      }
      if (
        block.type === 'web_search_tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        const deferred = inherited.get(block.tool_use_id);
        const entry = entries.get(block.tool_use_id) ?? deferred;
        if (!entry) return;
        if (deferred) receivedDeferredSearchResult = true;
        entry.search.sources = sources(block.content);
        const error = boundedText(record(block.content)?.error_code, 128);
        if (error) entry.search.error = error;
        end(entry);
      }
      return;
    }
    const call = anthropicCalls.get(index);
    if (!call) return;
    if (event.type === 'content_block_delta') {
      const delta = record(event.delta);
      if (
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        const remaining = MAX_INPUT_JSON - call.json.length;
        if (remaining > 0) call.json += delta.partial_json.slice(0, remaining);
      }
    } else if (event.type === 'content_block_stop') {
      const query = boundedText(parseInput(call.json)?.query, 2000);
      if (query) call.entry.search.args = { query };
      start(call.entry);
      anthropicCalls.delete(index);
    }
  }

  function observeOpenAI(event: RecordValue) {
    if (
      event.type !== 'response.output_item.added' &&
      event.type !== 'response.output_item.done'
    )
      return;
    const index = event.output_index;
    const item = record(event.item);
    if (typeof index !== 'number' || typeof item?.type !== 'string') return;
    if (openAIItems.size < 512 || openAIItems.has(index)) {
      openAIItems.set(index, {
        id: boundedText(item.id, 256),
        visible: OPENAI_VISIBLE_ITEMS.has(item.type),
      });
    }
    if (
      item.type !== 'web_search_call' ||
      typeof item.id !== 'string' ||
      item.id.length > 256
    )
      return;
    const contentIndex = [...openAIItems].filter(
      ([i, prior]) => i < index && prior.visible,
    ).length;
    const entry = open(item.id, contentIndex);
    if (!entry || entry.ended) return;
    const { search } = entry;
    search.contentIndex = contentIndex;
    const action = record(item.action);
    const query = boundedText(
      action?.query ?? list(action?.queries)[0] ?? action?.pattern,
      2000,
    );
    const url = boundedText(action?.url, 2048);
    if (action?.type === 'open_page') search.name = 'web_fetch';
    if (query || url) {
      search.args = { ...(query ? { query } : {}), ...(url ? { url } : {}) };
      start(entry);
    }
    if (event.type !== 'response.output_item.done') return;
    search.sources = sources(action?.sources);
    if (url && !search.sources.length) search.sources = [{ url }];
    const status = boundedText(item.status, 128);
    if (status && status !== 'completed') search.error = status;
    if (JSON.stringify(item).length <= MAX_RAW_ITEM) {
      const previousItemId = openAIItems.get(index - 1)?.id;
      search.openAI = {
        item: structuredClone(item),
        ...(previousItemId ? { previousItemId } : {}),
      };
    }
    end(entry);
  }

  return {
    observe(value: unknown) {
      const event = record(value);
      if (!event) return;
      if (api === 'anthropic-messages') observeAnthropic(event);
      else observeOpenAI(event);
    },
    finish(willContinue = false) {
      const pending = new Map<string, SearchEntry>();
      for (const [id, entry] of [...inherited, ...entries]) {
        if (entry.ended) continue;
        if (willContinue) pending.set(id, entry);
        else {
          entry.search.error = 'Provider web search did not complete.';
          end(entry);
        }
      }
      return {
        searches: [...entries.values()].map(({ search }) => search),
        pending,
      };
    },
    needsReplayForToolUse: () =>
      receivedDeferredSearchResult ||
      [...inherited.values(), ...entries.values()].some(
        (entry) => !entry.ended,
      ),
    replay: () => anthropic?.content(),
  };
}

export type AssistantWithNativeWebSearch = AssistantMessage & {
  nativeWebSearches?: NativeWebSearch[];
};

function prepareAnthropicReplay(
  messages: Message[],
  replies: WeakMap<AssistantMessage, RecordValue[]>,
) {
  const replacements = new Map<string, RecordValue[]>();
  const searchCalls = new Set<unknown>();
  const prepared = messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const reply = replies.get(message);
    if (!reply) return message;
    // Compaction can keep a deferred result after removing its call.
    const content = reply.filter((block) => {
      if (block.type === 'server_tool_use' && block.name === 'web_search')
        searchCalls.add(block.id);
      return (
        block.type !== 'web_search_tool_result' ||
        searchCalls.has(block.tool_use_id)
      );
    });
    if (!content.length) return message;
    // A reply made entirely of provider-side blocks has no content in pi.
    // Give pi a placeholder to locate that exact reply after serialization.
    const marker = randomUUID();
    replacements.set(marker, content);
    return {
      ...message,
      content: [{ type: 'text' as const, text: marker }, ...message.content],
    };
  });
  return {
    messages: replacements.size ? prepared : messages,
    needed: replacements.size > 0,
    apply(payload: unknown) {
      const body = record(payload);
      if (!body || !replacements.size) return payload;
      const messages = list(body.messages).map((value) => {
        const message = record(value);
        if (message?.role !== 'assistant') return value;
        const converted = list(message.content);
        const marker = record(converted[0]);
        const content =
          typeof marker?.text === 'string'
            ? replacements.get(marker.text)
            : undefined;
        if (!content) return value;
        const cacheControl = record(converted.at(-1))?.cache_control;
        return {
          ...message,
          content:
            cacheControl === undefined
              ? content
              : [
                  ...content.slice(0, -1),
                  { ...content.at(-1), cache_control: cacheControl },
                ],
        };
      });
      return { ...body, messages };
    },
  };
}

export function withNativeWebSearch(
  models: Models,
  api: SearchApi,
  callbacks: SearchCallbacks,
): Models {
  const replies = new WeakMap<AssistantMessage, RecordValue[]>();
  let pending = new Map<string, SearchEntry>();
  let continuations = 0;
  const streamSimple: Models['streamSimple'] = (model, context, options) => {
    const collector = createNativeWebSearchCollector(api, callbacks, pending);
    const replay =
      api === 'anthropic-messages'
        ? prepareAnthropicReplay(context.messages, replies)
        : undefined;
    const source = models.streamSimple(
      model,
      replay ? { ...context, messages: replay.messages } : context,
      {
        ...options,
        // A thread can already contain the reply we need to replay, even
        // when pi hashed it without the hosted tool blocks.
        ...(replay?.needed ? { disableContinuation: true } : {}),
        async onPayload(payload, model) {
          const withReplay = replay ? replay.apply(payload) : payload;
          const injected = injectNativeWebSearch(api, withReplay);
          return (await options?.onPayload?.(injected, model)) ?? injected;
        },
        async onProviderStreamEvent(event, model) {
          collector.observe(event);
          await options?.onProviderStreamEvent?.(event, model);
        },
      },
    );
    const output = createAssistantMessageEventStream();
    const finish = (message: AssistantWithNativeWebSearch) => {
      let willContinue = false;
      const paused =
        message.rawStopReason === 'pause_turn' &&
        message.stopReason !== 'error' &&
        message.stopReason !== 'aborted' &&
        continuations < MAX_NATIVE_SEARCH_CONTINUATIONS;
      const replayForClientTool =
        api === 'anthropic-messages' &&
        message.stopReason === 'toolUse' &&
        message.content.some((block) => block.type === 'toolCall') &&
        collector.needsReplayForToolUse();
      if (paused || replayForClientTool) {
        const content = collector.replay();
        if (content) {
          replies.set(message, content);
          if (paused) continuations++;
          willContinue = true;
        } else {
          message.stopReason = 'error';
          message.errorMessage = paused
            ? 'The provider paused web search without a replayable reply.'
            : 'The provider combined deferred web search and local tools without a replayable reply.';
        }
      }
      const finished = collector.finish(willContinue);
      if (finished.searches.length)
        message.nativeWebSearches = finished.searches;
      pending = finished.pending;
    };
    void (async () => {
      for await (const event of source) {
        if (event.type === 'done') {
          finish(event.message);
          if (event.message.stopReason === 'error') {
            output.push({
              type: 'error',
              reason: 'error',
              error: event.message,
            });
            return;
          }
        } else if (event.type === 'error') finish(event.error);
        output.push(event);
        if (event.type === 'done' || event.type === 'error') return;
      }
      const result = await source.result();
      finish(result);
      output.end(result);
    })();
    return output;
  };
  return new Proxy(models, {
    get(target, property) {
      if (property === 'streamSimple') return streamSimple;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
