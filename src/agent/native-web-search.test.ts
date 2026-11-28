import { describe, expect, it, vi } from 'vitest';
import type { NativeWebSearch } from './native-web-search-results';
import {
  createNativeWebSearchCollector,
  injectNativeWebSearch,
} from './native-web-search';

describe('provider-native web search', () => {
  it('prepends Anthropic search without moving the function tool cache breakpoint', () => {
    const fn = { name: 'web_fetch', cache_control: { type: 'ephemeral' } };
    const body = { tools: [fn] };
    const injected = injectNativeWebSearch('anthropic-messages', body);
    expect(injected).toEqual({
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        fn,
      ],
    });
    expect(injectNativeWebSearch('anthropic-messages', injected)).toEqual(
      injected,
    );
    expect(body.tools).toEqual([fn]);
  });

  it('appends OpenAI search and merges the included sources idempotently', () => {
    const fn = { type: 'function', name: 'web_fetch' };
    const body = {
      store: false,
      tools: [fn],
      include: ['reasoning.encrypted_content'],
    };
    const injected = injectNativeWebSearch('openai-responses', body);
    expect(injected).toEqual({
      ...body,
      tools: [fn, { type: 'web_search' }],
      include: [
        'reasoning.encrypted_content',
        'web_search_call.action.sources',
      ],
    });
    expect(injectNativeWebSearch('openai-responses', injected)).toEqual(
      injected,
    );
  });

  it('collects Anthropic sources or errors and reconstructs a paused response from streamed blocks', () => {
    const onSearchStart = vi.fn<(search: NativeWebSearch) => void>();
    const onSearchEnd = vi.fn<(search: NativeWebSearch) => void>();
    const collector = createNativeWebSearchCollector('anthropic-messages', {
      onSearchStart,
      onSearchEnd,
    });
    const block = (index: number, content_block: unknown) => ({
      type: 'content_block_start',
      index,
      content_block,
    });
    const delta = (index: number, delta: unknown) => ({
      type: 'content_block_delta',
      index,
      delta,
    });
    const stop = (index: number) => ({ type: 'content_block_stop', index });
    const call = (id: string) => ({
      type: 'server_tool_use',
      name: 'web_search',
      id,
      input: {},
    });
    const result = (id: string, content: unknown) => ({
      type: 'web_search_tool_result',
      tool_use_id: id,
      content,
    });
    const source = {
      type: 'web_search_result',
      url: 'https://example.test/one',
      title: 'One',
      encrypted_content: 'opaque',
      page_age: null,
    };
    const error = {
      type: 'web_search_tool_result_error',
      error_code: 'too_many_requests',
    };
    const thinking = { type: 'thinking', thinking: '', signature: '' };
    for (const event of [
      block(0, thinking),
      delta(0, { type: 'thinking_delta', thinking: 'Look it up.' }),
      delta(0, { type: 'signature_delta', signature: 'signed' }),
      stop(0),
      block(1, call('srvtoolu_1')),
      delta(1, { type: 'input_json_delta', partial_json: '{"query":' }),
      delta(1, { type: 'input_json_delta', partial_json: '"first"}' }),
      stop(1),
      block(2, result('srvtoolu_1', [source])),
      stop(2),
      block(3, { type: 'text', text: 'Before ' }),
      delta(3, { type: 'text_delta', text: 'search two.' }),
      stop(3),
      block(4, call('srvtoolu_2')),
      delta(4, {
        type: 'input_json_delta',
        partial_json: '{"query":"second"}',
      }),
      stop(4),
      block(5, result('srvtoolu_2', error)),
      stop(5),
    ])
      collector.observe(event);
    expect(collector.finish().searches).toMatchObject([
      {
        name: 'web_search',
        contentIndex: 1,
        args: { query: 'first' },
        sources: [{ url: source.url, title: source.title }],
      },
      {
        name: 'web_search',
        contentIndex: 2,
        args: { query: 'second' },
        sources: [],
        error: 'too_many_requests',
      },
    ]);
    expect(onSearchStart).toHaveBeenCalledTimes(2);
    expect(onSearchEnd).toHaveBeenCalledTimes(2);
    expect(collector.replay()).toEqual([
      { ...thinking, thinking: 'Look it up.', signature: 'signed' },
      { ...call('srvtoolu_1'), input: { query: 'first' } },
      result('srvtoolu_1', [source]),
      { type: 'text', text: 'Before search two.' },
      { ...call('srvtoolu_2'), input: { query: 'second' } },
      result('srvtoolu_2', error),
    ]);
  });

  it('does not split a search source title surrogate pair at the storage limit', () => {
    const collector = createNativeWebSearchCollector('anthropic-messages', {
      onSearchStart: vi.fn<(search: NativeWebSearch) => void>(),
      onSearchEnd: vi.fn<(search: NativeWebSearch) => void>(),
    });
    const prefix = 'a'.repeat(239);
    collector.observe({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'server_tool_use',
        name: 'web_search',
        id: 'search',
        input: { query: 'Hatch' },
      },
    });
    collector.observe({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'search',
        content: [
          { url: 'https://example.test/cut', title: `${prefix}🌍` },
          { url: 'https://example.test/fits', title: `${prefix.slice(1)}🌍` },
        ],
      },
    });
    expect(collector.finish().searches[0]?.sources).toEqual([
      { url: 'https://example.test/cut', title: prefix },
      { url: 'https://example.test/fits', title: `${prefix.slice(1)}🌍` },
    ]);
  });

  it('collects OpenAI searches and page opens, including the neighboring replay id', () => {
    const onSearchStart = vi.fn<(search: NativeWebSearch) => void>();
    const onSearchEnd = vi.fn<(search: NativeWebSearch) => void>();
    const collector = createNativeWebSearchCollector('openai-responses', {
      onSearchStart,
      onSearchEnd,
    });
    const item = (
      phase: 'added' | 'done',
      output_index: number,
      item: unknown,
    ) => ({ type: `response.output_item.${phase}`, output_index, item });
    const source = { type: 'url', url: 'https://example.test' };
    const search = {
      type: 'web_search_call',
      id: 'ws_search',
      status: 'completed',
      action: { type: 'search', query: 'Hatch', sources: [source] },
    };
    const page = {
      type: 'web_search_call',
      id: 'ws_page',
      status: 'completed',
      action: { type: 'open_page', url: source.url },
    };
    for (const event of [
      item('added', 0, { type: 'reasoning', id: 'rs_reasoning' }),
      item('added', 1, { ...search, action: undefined, status: 'in_progress' }),
      item('done', 1, search),
      item('added', 2, { ...page, status: 'in_progress' }),
      item('done', 2, page),
      item('added', 3, { type: 'message', id: 'msg_answer' }),
    ])
      collector.observe(event);
    expect(collector.finish().searches).toMatchObject([
      {
        name: 'web_search',
        contentIndex: 1,
        args: { query: 'Hatch' },
        sources: [{ url: source.url }],
        openAI: { item: search, previousItemId: 'rs_reasoning' },
      },
      {
        name: 'web_fetch',
        contentIndex: 1,
        args: { url: source.url },
        sources: [{ url: source.url }],
        openAI: { item: page, previousItemId: 'ws_search' },
      },
    ]);
    expect(onSearchStart).toHaveBeenCalledTimes(2);
    expect(onSearchEnd).toHaveBeenCalledTimes(2);
  });
});
