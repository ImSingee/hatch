import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() =>
  vi.fn<(input: { id: string }) => Promise<{ id: string }>>(),
);
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, platformClient: () => ({ apps: { get: lookup } }) };
});
import { runWebhook, webhookHeaders, webhookSuffix } from './webhook';

let server: Server;
let directory: string;
let url: string;
/** Per-test handler for stream paths; the default handler serves the rest. */
let stream:
  | ((
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse,
    ) => void)
  | undefined;
let calls: {
  path: string;
  method?: string;
  body: Buffer;
  headers: Record<string, unknown>;
}[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hatch-webhook-cli-'));
  calls = [];
  stream = undefined;
  lookup.mockResolvedValue({ id: 'canonical-id' });
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({
      path: request.url!,
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    if (stream && request.url?.includes('/stream')) {
      stream(request, response);
    } else if (request.url?.includes('/redirect')) {
      response.writeHead(307, { location: '/unexpected' });
      response.end();
    } else {
      response.writeHead(request.url?.includes('/failure') ? 422 : 200, {
        'content-type': 'application/octet-stream',
      });
      response.end(Buffer.from([0, 255, 128, 10]));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  url = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('HATCH_CLI_URL', url);
  vi.stubEnv('HATCH_CLI_TOKEN', 'fixture-session');
  vi.stubEnv('HATCH_CLI_API_KEY', undefined);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('webhook target and credential boundary', () => {
  it('rejects target escapes and reserved credential/routing overrides', () => {
    for (const suffix of [
      '../rpc',
      '/rpc',
      '//evil.test',
      'http://evil.test',
      'a/../b',
      'a%2fb',
      '%252e%252e',
      'a?secret=x',
      'a#b',
      'a\\b',
      'a//b',
    ])
      expect(() => webhookSuffix(suffix)).toThrow(
        /relative segments|nonreserved header/,
      );
    for (const name of [
      'Authorization',
      'X-API-Key',
      'Cookie',
      'x-Hatch-Signature',
      'X-HATCH-anything',
      'Host',
      'Connection',
      'X-Forwarded-Host',
      'Origin',
      'Sec-Fetch-Site',
      'Content-Length',
    ])
      expect(() => webhookHeaders([`${name}: injected`])).toThrow(
        /relative segments|nonreserved header/,
      );
    expect(() =>
      webhookHeaders(['X-App-Token: value\r\nAuthorization: injected']),
    ).toThrow(/relative segments|nonreserved header/);
  });

  it('calls only the canonical runtime URL and preserves binary file/response bytes', async () => {
    const payload = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(directory, 'body.bin'), payload);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runWebhook(
      [
        'app',
        'invoke',
        'webhook',
        'my-slug',
        '--workdir',
        directory,
        '--file',
        'body.bin',
        '--path',
        'provider/events',
        '--query',
        'delivery=a&b?#%',
        '--header',
        'X-App-Token: app-private',
        '--json',
      ],
      0,
      new AbortController().signal,
    );
    expect(lookup).toHaveBeenCalledWith({ id: 'my-slug' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: '/api/app/canonical-id/hook/provider/events?delivery=a%26b%3F%23%25',
      method: 'POST',
      body: payload,
      headers: {
        authorization: 'Bearer fixture-session',
        'x-app-token': 'app-private',
        'content-type': 'application/octet-stream',
      },
    });
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
      ok: true,
      status: 200,
      contentType: 'application/octet-stream',
      bodyEncoding: 'base64',
      body: payload.toString('base64'),
    });
  });

  it('emits exact raw response bytes and HTTP failure without retries', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runWebhook(
      ['app', 'invoke', 'webhook', 'id', '--path', 'failure'],
      0,
      new AbortController().signal,
    );
    expect(output).toHaveBeenCalledWith(new Uint8Array([0, 255, 128, 10]));
    expect(errors).toHaveBeenCalledWith('Webhook returned HTTP 422.\n');
    expect(process.exitCode).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.length).toBe(0);
  });

  it('refuses redirects without reaching a second target', async () => {
    await expect(
      runWebhook(
        ['app', 'invoke', 'webhook', 'id', '--path', 'redirect'],
        0,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'outcome_unknown', exitCode: 7 });
    expect(calls).toHaveLength(1);
  });

  it('rejects supplied GET/HEAD bodies, unsupported methods and invalid env before invocation', async () => {
    for (const method of ['GET', 'HEAD'])
      await expect(
        runWebhook(
          ['app', 'invoke', 'webhook', 'id', '--method', method, '--file', '-'],
          0,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(
      runWebhook(
        ['app', 'invoke', 'webhook', 'id', '--method', 'TRACE'],
        0,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_method' });
    vi.stubEnv('HATCH_CLI_API_KEY', 'ambiguous');
    await expect(
      runWebhook(
        ['app', 'invoke', 'webhook', 'id'],
        0,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'incomplete_env' });
    expect(calls).toHaveLength(0);
  });
});

describe('server-sent event subscriptions', () => {
  const sse = (...extra: string[]) =>
    runWebhook(
      [
        'app',
        'invoke',
        'webhook',
        'id',
        '--method',
        'GET',
        '--path',
        'stream',
        '--sse',
        ...extra,
      ],
      0,
      new AbortController().signal,
    );
  const records = (output: { mock: { calls: unknown[][] } }) =>
    output.mock.calls.map((call) => JSON.parse(String(call[0])));
  const open = (response: import('node:http').ServerResponse) =>
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
    });

  it('rejects contradictory stream flags before any request', async () => {
    for (const [args, code] of [
      [['--idle-timeout', '5'], 'invalid_arguments'],
      [['--max-duration', '5'], 'invalid_arguments'],
      [['--sse', '--method', 'HEAD'], 'invalid_arguments'],
      [['--sse', '--header', 'Accept: application/json'], 'invalid_arguments'],
      [['--sse', '--idle-timeout', '0'], 'invalid_arguments'],
      [['--sse', '--max-duration', '86401'], 'invalid_arguments'],
    ] as const)
      await expect(
        runWebhook(
          ['app', 'invoke', 'webhook', 'id', ...args],
          0,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code });
    expect(lookup).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('streams NDJSON past --timeout while data flows, then ends on close', async () => {
    stream = (_, response) => {
      open(response);
      response.write('id: 1\ndata: {"pr":123}\n\n');
      let beats = 0;
      const timer = setInterval(() => {
        if (++beats < 8) response.write(': ping\n\n');
        else {
          clearInterval(timer);
          response.end('event: done\ndata: bye\n\n');
        }
      }, 100);
    };
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await sse('--json', '--timeout', '0.3', '--idle-timeout', '1');
    expect(calls[0].headers.accept).toBe('text/event-stream');
    expect(records(output)).toEqual([
      {
        type: 'open',
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
      },
      { type: 'event', event: 'message', id: '1', data: '{"pr":123}' },
      { type: 'event', event: 'done', id: '1', data: 'bye' },
      {
        type: 'end',
        ok: true,
        reason: 'closed',
        lastEventId: '1',
        events: 2,
        retry: null,
      },
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('fails an idle stream with its resume point and ends at --max-duration', async () => {
    stream = (_, response) => {
      open(response);
      response.write('id: 5\ndata: one\n\n');
    };
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await expect(sse('--json', '--idle-timeout', '0.2')).rejects.toMatchObject({
      code: 'stream_idle_timeout',
      exitCode: 7,
      details: { lastEventId: '5', events: 1, retry: null },
    });

    stream = (_, response) => {
      open(response);
      const timer = setInterval(() => response.write(': ping\n\n'), 30);
      response.on('close', () => clearInterval(timer));
    };
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await sse('--json', '--max-duration', '0.2', '--idle-timeout', '1');
    expect(records(output).at(-1)).toEqual({
      type: 'end',
      ok: true,
      reason: 'max_duration',
      lastEventId: null,
      events: 0,
      retry: null,
    });
  });

  it('does not count a backpressured stdout as an idle stream', async () => {
    stream = (_, response) => {
      open(response);
      response.end('id: 1\ndata: a\n\nid: 2\ndata: b\n\n');
    };
    // Every write waits for a drain that comes after the idle timeout.
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      setTimeout(() => process.stdout.emit('drain'), 400);
      return false;
    });
    await sse('--json', '--idle-timeout', '0.2');
    expect(records(output).at(-1)).toMatchObject({
      type: 'end',
      reason: 'closed',
      lastEventId: '2',
      events: 2,
    });
  });

  it('reports interrupted, non-2xx and non-stream responses distinctly', async () => {
    stream = (_, response) => {
      open(response);
      response.write('id: 3\ndata: a\n\n', () =>
        setTimeout(() => response.destroy(), 20),
      );
    };
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await expect(sse('--json')).rejects.toMatchObject({
      code: 'stream_interrupted',
      exitCode: 7,
      message: expect.stringContaining("Last-Event-ID:3'"),
      details: { lastEventId: '3', events: 1 },
    });

    stream = (_, response) => {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('no');
    };
    await expect(sse('--json')).rejects.toMatchObject({
      code: 'http_error',
      exitCode: 4,
      httpStatus: 403,
    });

    stream = (_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    };
    await expect(sse('--json')).rejects.toMatchObject({
      code: 'not_event_stream',
      exitCode: 7,
    });
  });

  it('warns on stderr when plain --json meets an event stream', async () => {
    stream = (_, response) => {
      open(response);
      response.end('data: x\n\n');
    };
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runWebhook(
      [
        'app',
        'invoke',
        'webhook',
        'id',
        '--method',
        'GET',
        '--path',
        'stream',
        '--json',
      ],
      0,
      new AbortController().signal,
    );
    expect(String(errors.mock.calls[0][0])).toMatch(
      /text\/event-stream; --json buffers it .* Use --sse --json/,
    );
    expect(records(output)).toEqual([
      {
        ok: true,
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        bodyEncoding: 'base64',
        body: Buffer.from('data: x\n\n').toString('base64'),
      },
    ]);
  });
});
