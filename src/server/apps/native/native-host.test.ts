/**
 * The web player's host for a native App: every `hatch.*` call validates its
 * arguments, reaches only this App's own endpoints, and answers with an
 * envelope.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeHost,
  type NativePlayerConfig,
} from '../../../../sdk-internal/app/src/native-player';

const config: NativePlayerConfig = {
  appId: 'notes',
  deploymentId: 'deployment-7',
  name: 'Notes',
  nshAppId: 'dev.hatch.app.notes',
  runtime: {
    base: '/rt/',
    module: 'nsh.js',
    wasm: 'nsh.wasm',
    data: {},
    sides: {},
  },
  app: {
    code: 'web/app.js',
    chunks: {},
    assets: {},
    fonts: [],
    chunkFonts: {},
    chunkSides: {},
    entryChunks: [],
    nativeExports: {},
  },
  grant: '{"host":[]}',
  rpc: {
    url: '/api/app/notes/rpc',
    methods: { 'app.v1.NotesService': ['ListNotes'] },
  },
  data: { url: '/api/app/notes/data' },
  themes: { indigo: { cssVars: { light: { primary: '#3F51C7' } } } },
  defaultAccent: 'indigo',
};

function setup(
  fetchImpl: (url: string, init?: RequestInit) => Response,
  visible = true,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const hideListeners = new Set<() => void>();
  const shell = {
    theme: () => config.themes.indigo,
    visibleWithin: () => Promise.resolve(visible),
    onHidden: (listener: () => void) => {
      hideListeners.add(listener);
      return () => hideListeners.delete(listener);
    },
    hide: () => {
      for (const listener of hideListeners) listener();
    },
    post: vi.fn<(message: unknown) => boolean>(() => true),
    setTitle: vi.fn<(title: string | null) => void>(),
    setRoute: vi.fn<(route: string) => void>(),
  };
  const host = createNativeHost(config, shell, (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init });
    return fetchImpl(url, init);
  }) as typeof fetch);
  return { host, calls, shell };
}

describe('native App host', () => {
  it('sends a unary RPC to this App only and returns the message', async () => {
    const { host, calls } = setup(() =>
      Response.json({ notes: ['a'] }, { headers: { 'x-trace': '1' } }),
    );
    await expect(
      host.call('hatch.rpc', {
        service: 'app.v1.NotesService',
        method: 'ListNotes',
        message: {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { notes: ['a'] },
      header: { 'x-trace': '1' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      '/api/app/notes/rpc/app.v1.NotesService/ListNotes',
    );
    expect(calls[0].init?.headers).toMatchObject({
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    });
  });

  it('carries a message whose JSON form is not an object both ways', async () => {
    // `google.protobuf.Timestamp` in, `google.protobuf.Value` (null) out.
    const { host, calls } = setup(() => Response.json(null));
    await expect(
      host.call('hatch.rpc', {
        service: 'app.v1.NotesService',
        method: 'ListNotes',
        message: '2026-01-02T03:04:05Z',
      }),
    ).resolves.toMatchObject({ ok: true, message: null });
    expect(calls[0].init?.body).toBe('"2026-01-02T03:04:05Z"');
  });

  it('refuses RPCs outside the App and malformed arguments without a request', async () => {
    const { host, calls } = setup(() => Response.json({}));
    const refusals = [
      // Another service, a path escape, a streaming or unknown method.
      { service: 'other.v1.Admin', method: 'ListNotes', message: {} },
      { service: '../../other/rpc/x', method: 'ListNotes', message: {} },
      { service: 'app.v1.NotesService', method: 'WatchNotes', message: {} },
      { service: 'app.v1.NotesService', method: 'List/../x', message: {} },
      { service: 'app.v1.NotesService', method: 'ListNotes' },
      'text',
    ];
    for (const args of refusals) {
      const answer = await host.call('hatch.rpc', args);
      expect(answer.ok).toBe(false);
      expect(answer).toHaveProperty('code');
    }
    expect(calls).toEqual([]);
  });

  it('passes a backend Connect error through with its code', async () => {
    const { host } = setup(() =>
      Response.json(
        { code: 'invalid_argument', message: 'title is required' },
        { status: 400 },
      ),
    );
    await expect(
      host.call('hatch.rpc', {
        service: 'app.v1.NotesService',
        method: 'ListNotes',
        message: {},
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'invalid_argument',
      message: 'title is required',
    });
  });

  it('scopes Data Table calls to this App and its deployment', async () => {
    const { host, calls } = setup((url) =>
      url.endsWith('/query')
        ? Response.json({ items: [], revision: 3 })
        : new Response('conflict', { status: 409 }),
    );
    await expect(
      host.call('hatch.data.query', { body: { table: 'notes' } }),
    ).resolves.toEqual({ ok: true, result: { items: [], revision: 3 } });
    await expect(
      host.call('hatch.data.mutate', { body: { operations: [] } }),
    ).resolves.toEqual({
      ok: false,
      code: 'already_exists',
      message: 'conflict',
    });
    expect(calls.map((call) => call.url)).toEqual([
      '/api/app/notes/data/query',
      '/api/app/notes/data/mutate',
    ]);
    for (const call of calls) {
      expect(call.init?.headers).toMatchObject({
        'x-hatch-data-deployment': 'deployment-7',
      });
    }
    for (const args of [{}, { body: 'x' }, { table: 'notes' }]) {
      expect((await host.call('hatch.data.query', args)).ok).toBe(false);
    }
    for (const args of [
      { table: 'notes', since: -1 },
      { table: '', since: 0 },
    ]) {
      expect((await host.call('hatch.data.events', args)).ok).toBe(false);
    }
    expect(calls).toHaveLength(2);
  });

  it('answers change events from the App’s own stream', async () => {
    const { host, calls } = setup(
      () =>
        new Response('id: 9\nevent: change\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    await expect(
      host.call('hatch.data.events', { table: 'notes', since: 4 }),
    ).resolves.toEqual({
      ok: true,
      events: [{ revision: 9, reset: false }],
    });
    expect(calls[0].url).toBe('/api/app/notes/data/events?since=4&table=notes');
  });

  it('answers no change events for a hidden App without a request', async () => {
    const { host, calls } = setup(() => Response.json({}), false);
    await expect(
      host.call('hatch.data.events', { table: 'notes', since: 4 }),
    ).resolves.toEqual({ ok: true, events: [] });
    expect(calls).toEqual([]);
  });

  it('ends an open poll with no events when the App is hidden', async () => {
    // A stream with no change yet, open until the poll is aborted.
    const { host, shell } = setup((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const answer = host.call('hatch.data.events', { table: 'notes', since: 4 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    shell.hide();
    await expect(answer).resolves.toEqual({ ok: true, events: [] });
  });

  it('validates navigation and refuses names that are not host functions', async () => {
    const { host, shell } = setup(() => Response.json({}));
    await expect(
      host.call('hatch.nav.setRoute', { route: '/notes/7' }),
    ).resolves.toEqual({ ok: true });
    expect(shell.setRoute).toHaveBeenCalledWith('/notes/7');
    await expect(
      host.call('hatch.nav.setTitle', { title: 'Inbox' }),
    ).resolves.toEqual({ ok: true });
    expect(shell.setTitle).toHaveBeenCalledWith('Inbox');
    for (const [name, args] of [
      ['hatch.nav.setRoute', { route: '#/x' }],
      ['hatch.nav.setRoute', { route: 7 }],
      ['hatch.nav.setTitle', { title: 'x'.repeat(300) }],
      ['hatch.nav.open', { slug: '../admin' }],
      ['hatch.nav.open', { slug: 'a'.repeat(65) }],
    ] as const) {
      expect((await host.call(name, args)).ok).toBe(false);
    }
    // Every slug the platform accepts (up to 64 characters) can be opened.
    await expect(
      host.call('hatch.nav.open', { slug: 'a'.repeat(64) }),
    ).resolves.toEqual({ ok: true });
    await expect(host.call('hatch.native.camera.open', {})).resolves.toEqual({
      ok: false,
      code: 'unimplemented',
      message: 'hatch.native.camera.open is not a host function.',
    });
    await expect(host.call('hatch.theme.get', {})).resolves.toEqual({
      ok: true,
      theme: config.themes.indigo,
    });
  });
});
