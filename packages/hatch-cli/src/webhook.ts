/** Thin plain-HTTP invocation of the existing App webhook runtime endpoint. */
import type { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { credentialHeaders, platformClient } from './client';
import { configPath, resolveCredential } from './config';
import { argumentsError, CliError } from './error';
import { type SseEvent, type SseIdChange, SseParser } from './sse';

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function hasControl(value: string) {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export function webhookSuffix(value = ''): string {
  if (!value) return '';
  if (
    /[%?#\\:\s]/u.test(value) ||
    hasControl(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new CliError(
      'invalid_path',
      '--path must be relative segments without traversal, URL syntax or percent escapes. Use --query name=value for query parameters.',
    );
  return `/${value.split('/').map(encodeURIComponent).join('/')}`;
}

export function webhookHeaders(values: string[] = []): Headers {
  const headers = new Headers();
  for (const value of values) {
    const colon = value.indexOf(':');
    const name = value.slice(0, colon).trim().toLowerCase();
    if (
      colon <= 0 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      hasControl(value) ||
      name.startsWith('x-hatch-') ||
      name.startsWith('x-forwarded-') ||
      [
        'authorization',
        'x-api-key',
        'cookie',
        'host',
        'origin',
        'content-length',
        'content-type',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'forwarded',
        'via',
      ].includes(name) ||
      name.startsWith('sec-')
    )
      throw new CliError(
        'invalid_header',
        'Use an App-owned nonreserved header (for example X-App-Token). Platform credential/routing headers cannot be overridden; Authorization and x-api-key are stripped before the App handler. Use --content-type for media type.',
      );
    try {
      headers.append(name, value.slice(colon + 1).trim());
    } catch {
      throw new CliError('invalid_header', 'Invalid HTTP header.');
    }
  }
  return headers;
}

function seconds(
  value: string | undefined,
  flag: string,
  fallback: number | undefined,
  max: number,
): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max)
    throw new CliError(
      flag === '--timeout' ? 'invalid_timeout' : 'invalid_arguments',
      `${flag} must be greater than 0 and at most ${max} seconds.`,
    );
  return parsed;
}

function httpExitCode(status: number) {
  return status === 401 ? 3 : status === 403 ? 4 : status === 404 ? 5 : 7;
}

function isEventStream(response: Response) {
  return (
    (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase() === 'text/event-stream'
  );
}

/** How long stdout may stay unread after --max-duration before exiting. */
const OUTPUT_GRACE_MS = 5000;

/** Resolve whether everything queued on stdout is flushed within `ms`. */
async function stdoutFlushed(ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      // A write callback runs once it and every earlier write are flushed.
      new Promise<boolean>((resolve) =>
        process.stdout.write('', () => resolve(true)),
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function write(value: string | Uint8Array, signal: AbortSignal) {
  if (!process.stdout.write(value))
    await once(process.stdout, 'drain', { signal });
}

export async function runWebhook(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  if (args[offset + 2] !== 'webhook')
    throw new CliError('invalid_arguments', 'Use hatch app invoke webhook.');
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 3)],
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        config: { type: 'string' },
        profile: { type: 'string' },
        workdir: { type: 'string' },
        timeout: { type: 'string' },
        path: { type: 'string' },
        method: { type: 'string' },
        file: { type: 'string' },
        'content-type': { type: 'string' },
        header: { type: 'string', multiple: true },
        query: { type: 'string', multiple: true },
        sse: { type: 'boolean' },
        'idle-timeout': { type: 'string' },
        'max-duration': { type: 'string' },
      },
    });
  } catch (error) {
    throw argumentsError(error, 'app invoke webhook');
  }
  const v = parsed.values;
  const [id] = parsed.positionals;
  if (!id || parsed.positionals.length !== 1)
    throw new CliError(
      'invalid_arguments',
      'Supply exactly one App ID or slug.',
    );
  const method = (v.method ?? 'POST').toUpperCase();
  if (!methods.includes(method))
    throw new CliError(
      'invalid_method',
      `Supported methods: ${methods.join(', ')}.`,
    );
  if (['GET', 'HEAD'].includes(method) && v.file !== undefined)
    throw new CliError('invalid_body', 'GET/HEAD cannot include --file.');
  const sse = v.sse === true;
  for (const flag of ['idle-timeout', 'max-duration'] as const)
    if (!sse && v[flag] !== undefined)
      throw new CliError('invalid_arguments', `--${flag} requires --sse.`);
  if (sse && method === 'HEAD')
    throw new CliError(
      'invalid_arguments',
      '--sse cannot use --method HEAD; HEAD responses have no body.',
    );
  const suffix = webhookSuffix(v.path);
  const headers = webhookHeaders(v.header);
  if (sse) {
    if (headers.has('accept'))
      throw new CliError(
        'invalid_arguments',
        '--sse sets Accept: text/event-stream; remove --header Accept.',
      );
    headers.set('accept', 'text/event-stream');
  }
  try {
    headers.set(
      'content-type',
      v['content-type'] ?? 'application/octet-stream',
    );
    if (!headers.get('content-type')) throw new Error();
  } catch {
    throw new CliError(
      'invalid_content_type',
      'Supply a valid nonempty --content-type.',
    );
  }
  const query = new URLSearchParams();
  for (const pair of v.query ?? []) {
    const equals = pair.indexOf('=');
    if (equals < 1)
      throw new CliError(
        'invalid_query',
        '--query requires name=value. Repeat it for multiple values.',
      );
    query.append(pair.slice(0, equals), pair.slice(equals + 1));
  }
  const timeoutSeconds = seconds(v.timeout, '--timeout', 30, 3600)!;
  const idleSeconds = seconds(v['idle-timeout'], '--idle-timeout', 120, 86400)!;
  const maxSeconds = seconds(
    v['max-duration'],
    '--max-duration',
    undefined,
    86400,
  );
  if (
    v.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.profile)
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if ([v.config, v.workdir, v.file].includes(''))
    throw new CliError('invalid_arguments', 'Paths must not be empty.');
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, v.config),
    v.profile,
  );
  const timeout = Math.ceil(timeoutSeconds * 1000);
  // Without --sse, --timeout bounds the whole call. With --sse it bounds only
  // the time to response headers; idle and max-duration timers take over.
  const call = new AbortController();
  const callSignal = AbortSignal.any([signal, call.signal]);
  const callTimer = setTimeout(() => call.abort(new Error('timeout')), timeout);
  try {
    const app = await platformClient(credential, timeout, callSignal).apps.get({
      id,
    });
    // Resolve IDs/slugs through management RPC, then target only that
    // canonical App's runtime endpoint. Never read or request its webhook
    // secret.
    const url = new URL(
      `${credential.url}/api/app/${encodeURIComponent(app.id)}/hook${suffix}`,
    );
    url.search = query.toString();
    for (const [name, value] of Object.entries(credentialHeaders(credential)))
      headers.set(name, value);
    let input:
      | ReturnType<typeof createReadStream>
      | typeof process.stdin
      | undefined;
    if (v.file === '-') {
      if (process.stdin.isTTY)
        throw new CliError(
          'stdin_required',
          'Pipe raw bytes or redirect a file for --file -.',
        );
      input = process.stdin;
    } else if (v.file !== undefined) {
      const path = resolve(v.workdir ?? '.', v.file);
      let file;
      try {
        file = await open(path, 'r');
        if (!(await file.stat()).isFile()) throw new Error();
        input = file.createReadStream();
      } catch {
        await file?.close();
        throw new CliError('input_unreadable', 'Cannot read input file.');
      }
    }
    try {
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        redirect: 'error',
        signal: callSignal,
        ...(input
          ? { body: input as unknown as BodyInit, duplex: 'half' }
          : {}),
      };
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch {
        if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
        throw new CliError(
          'outcome_unknown',
          'Webhook request failed, redirected or timed out. Its outcome may be unknown; inspect App state before retrying.',
          7,
        );
      }
      if (sse) {
        clearTimeout(callTimer);
        await streamEvents(response, call, signal, {
          json: v.json === true,
          idleMs: Math.ceil(idleSeconds * 1000),
          maxMs: maxSeconds === undefined ? undefined : maxSeconds * 1000,
        });
        return;
      }
      if (v.json && isEventStream(response))
        process.stderr.write(
          `Response is text/event-stream; --json buffers it until the stream ends or --timeout (${timeoutSeconds}s) and prints one result. Use --sse --json for per-event output.\n`,
        );
      try {
        if (v.json) {
          const body = Buffer.from(await response.arrayBuffer());
          process.stdout.write(
            `${JSON.stringify({
              ok: response.ok,
              status: response.status,
              contentType: response.headers.get('content-type'),
              bodyEncoding: 'base64',
              body: body.toString('base64'),
            })}\n`,
          );
        } else if (response.body) {
          // Raw bytes go only to stdout; shell redirection can save binary
          // output.
          for await (const chunk of response.body)
            await write(chunk, callSignal);
        }
      } catch {
        if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
        throw new CliError(
          'outcome_unknown',
          'Webhook request failed, redirected or timed out. Its outcome may be unknown; inspect App state before retrying.',
          7,
        );
      }
      if (!response.ok) {
        if (!v.json)
          process.stderr.write(`Webhook returned HTTP ${response.status}.\n`);
        process.exitCode = httpExitCode(response.status);
      }
    } finally {
      input?.destroy();
    }
  } finally {
    clearTimeout(callTimer);
  }
}

/**
 * Read a `--sse` response until the server ends it, the stream goes idle, the
 * maximum duration elapses or the caller cancels. `--json` prints one NDJSON
 * record per event between an `open` and an `end` record; text mode passes
 * the raw bytes through. Failures carry the resume point in `details`.
 */
async function streamEvents(
  response: Response,
  call: AbortController,
  signal: AbortSignal,
  options: { json: boolean; idleMs: number; maxMs?: number },
) {
  const contentType = response.headers.get('content-type');
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new CliError(
      'http_error',
      `Webhook returned HTTP ${response.status}.`,
      httpExitCode(response.status),
      response.status,
    );
  }
  if (!isEventStream(response)) {
    await response.body?.cancel().catch(() => {});
    throw new CliError(
      'not_event_stream',
      `Webhook answered ${contentType ?? 'without a Content-Type'}, not text/event-stream.`,
      7,
    );
  }
  const parser = new SseParser();
  // Resume data follows what reached stdout, not what the parser has seen:
  // an event parsed but not yet written must not be skipped on resume.
  const delivered = { lastEventId: null as string | null, events: 0 };
  const deliver = (item: SseEvent | SseIdChange) => {
    delivered.lastEventId = item.id;
    if (item.type === 'event') delivered.events++;
  };
  const resume = () =>
    delivered.lastEventId === null
      ? 'No event ID was received; resubscribe from the start.'
      : `Resume with --header 'Last-Event-ID:${delivered.lastEventId}'.`;
  const details = () => ({ ...delivered, retry: parser.retry });
  let stop: 'idle' | 'max' | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stop ??= 'idle';
      call.abort(new Error('idle'));
    }, options.idleMs);
  };
  const maxTimer =
    options.maxMs === undefined
      ? undefined
      : setTimeout(() => {
          stop ??= 'max';
          call.abort(new Error('max-duration'));
        }, options.maxMs);
  const output = AbortSignal.any([signal, call.signal]);
  const emit = (record: unknown) =>
    write(`${JSON.stringify(record)}\n`, output);
  try {
    try {
      // Inside the stop handling: a backpressured open record still ends by
      // --max-duration or cancellation, not as an internal error.
      if (options.json)
        await emit({ type: 'open', status: response.status, contentType });
      armIdle();
      if (response.body)
        for await (const chunk of response.body) {
          // The idle timer covers only waiting for the App. Suspend it while
          // stdout applies backpressure, then restart it for the next chunk.
          clearTimeout(idleTimer);
          if (options.json)
            for (const item of parser.push(chunk)) {
              if (item.type === 'event') await emit(item);
              deliver(item);
            }
          else {
            await write(chunk, output);
            for (const item of parser.push(chunk)) deliver(item);
          }
          armIdle();
        }
      parser.end();
    } catch (error) {
      if (error instanceof CliError)
        throw new CliError(
          error.code,
          error.message,
          error.exitCode,
          undefined,
          details(),
        );
      if (stop === 'idle')
        throw new CliError(
          'stream_idle_timeout',
          `No data for ${options.idleMs / 1000}s; the stream was closed. ${resume()}`,
          7,
          undefined,
          details(),
        );
      if (stop !== 'max') {
        if (signal.aborted)
          throw new CliError(
            'cancelled',
            'Cancelled.',
            130,
            undefined,
            details(),
          );
        throw new CliError(
          'stream_interrupted',
          `The stream ended abnormally. ${resume()}`,
          7,
          undefined,
          details(),
        );
      }
    }
    const reason = stop === 'max' ? 'max_duration' : 'closed';
    if (options.json)
      // Queue the final record; the stream signal may already be aborted.
      process.stdout.write(
        `${JSON.stringify({ type: 'end', ok: true, reason, ...details() })}\n`,
      );
    else
      process.stderr.write(
        `Stream ${reason === 'closed' ? 'closed by the App' : 'reached --max-duration'} after ${delivered.events} events; last event ID: ${delivered.lastEventId ?? 'none'}.\n`,
      );
    // --max-duration bounds the whole run. A pending write to a pipe nobody
    // reads keeps Node alive even after the command returns, so give stdout
    // a short grace and then exit with the output discarded.
    if (reason === 'max_duration' && !(await stdoutFlushed(OUTPUT_GRACE_MS))) {
      process.stderr.write(
        `stdout was not read within ${OUTPUT_GRACE_MS / 1000}s after --max-duration; pending output was discarded.\n`,
      );
      process.exit(7);
    }
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    // Release the connection however the stream ended.
    call.abort();
  }
}
