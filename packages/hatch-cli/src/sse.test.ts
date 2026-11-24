import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

const bytes = (text: string) => new TextEncoder().encode(text);

function parse(chunks: (string | Uint8Array)[], max?: number) {
  const parser = new SseParser(max);
  const events = chunks.flatMap((chunk) => [
    ...parser.push(typeof chunk === 'string' ? bytes(chunk) : chunk),
  ]);
  parser.end();
  return { events, parser };
}

describe('server-sent event parsing contract', () => {
  it('reassembles lines, line endings and UTF-8 split across chunks', () => {
    const snowman = bytes('data: ☃\n\n');
    const { events } = parse([
      '﻿data: fi',
      'rst\r',
      '\n\r\ndata: second\r\rid',
      ': 7\nevent: custom\n',
      '\n',
      snowman.slice(0, 8),
      snowman.slice(8),
    ]);
    expect(events).toEqual([
      { type: 'event', event: 'message', id: null, data: 'first' },
      { type: 'event', event: 'message', id: null, data: 'second' },
      // The data-less `custom` block dispatches nothing but keeps its id.
      { type: 'event', event: 'message', id: '7', data: '☃' },
    ]);
  });

  it('applies field rules: comments, multi-line data, id carry-over and retry', () => {
    const { events, parser } = parse([
      ': heartbeat\n\n',
      'event: only-type\n\n',
      'data\ndata:  two\nretry: 1500\nretry: soon\nid: a\0b\n\n',
      'id: 9\ndata: x\n\n',
      'id\ndata: reset\n\n',
      'data: unterminated',
    ]);
    expect(events).toEqual([
      {
        type: 'event',
        event: 'message',
        id: null,
        data: '\n two',
        retry: 1500,
      },
      { type: 'event', event: 'message', id: '9', data: 'x' },
      { type: 'event', event: 'message', id: null, data: 'reset' },
    ]);
    expect(parser).toMatchObject({ lastEventId: null, retry: 1500 });
  });

  it('rejects an oversized event however the network splits it', () => {
    const big = `data: ${'x'.repeat(64)}`;
    for (const chunks of [[`${big}\n\n`], ['data: ', big.slice(6)]])
      expect(() => parse(chunks, 32)).toThrow(
        expect.objectContaining({
          code: 'stream_event_too_large',
          exitCode: 7,
        }),
      );
  });

  it('yields completed events before failing on a later oversized one', () => {
    const parser = new SseParser(32);
    const events = parser.push(
      bytes(`id: 1\ndata: valid\n\nid: 2\ndata: ${'x'.repeat(64)}`),
    );
    expect(events.next().value).toMatchObject({ id: '1', data: 'valid' });
    expect(() => events.next()).toThrow(
      expect.objectContaining({ code: 'stream_event_too_large' }),
    );
  });

  it('advances the resume ID only when an event block completes', () => {
    const { events, parser } = parse(['id: 1\ndata: a\n\nid: 2\ndata: cut']);
    expect(events.map((event) => event.id)).toEqual(['1']);
    expect(parser.lastEventId).toBe('1');
  });
});
