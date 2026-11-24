/** Incremental `text/event-stream` parser (WHATWG HTML, server-sent events). */
import { CliError } from './error';

export type SseEvent = {
  type: 'event';
  event: string;
  /** The last event ID in effect when this event was dispatched. */
  id: string | null;
  data: string;
  /** Present when this event's block set a reconnection time. */
  retry?: number;
};

/** Largest event (pending line plus buffered data), in UTF-16 code units. */
export const MAX_SSE_EVENT_LENGTH = 1024 * 1024;

export class SseParser {
  readonly #decoder = new TextDecoder('utf-8');
  #line = '';
  #skipLineFeed = false;
  #data = '';
  #hasData = false;
  #event = '';
  #blockRetry: number | undefined;
  #lastEventId = '';
  #retry: number | null = null;
  #events = 0;

  constructor(readonly maxEventLength = MAX_SSE_EVENT_LENGTH) {}

  /** The stream's last event ID, for `Last-Event-ID` on reconnect. */
  get lastEventId(): string | null {
    return this.#lastEventId || null;
  }

  /** The most recent reconnection time the server asked for, if any. */
  get retry(): number | null {
    return this.#retry;
  }

  /** How many events have been dispatched. */
  get events(): number {
    return this.#events;
  }

  /** Feed raw bytes; returns the events they complete. */
  push(chunk: Uint8Array): SseEvent[] {
    // TextDecoder drops a leading BOM and holds split multi-byte sequences.
    return this.#feed(this.#decoder.decode(chunk, { stream: true }));
  }

  /**
   * Flush at end of stream. A trailing event without its blank line is
   * discarded, as the specification requires.
   */
  end(): SseEvent[] {
    this.#feed(this.#decoder.decode());
    return [];
  }

  #feed(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    // A CR ended the previous chunk; an LF opening this one completes CRLF.
    if (this.#skipLineFeed && text) {
      if (text.startsWith('\n')) start = 1;
      this.#skipLineFeed = false;
    }
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (character !== '\r' && character !== '\n') continue;
      const event = this.#line + text.slice(start, index);
      this.#line = '';
      if (character === '\r') {
        if (index + 1 === text.length) this.#skipLineFeed = true;
        else if (text[index + 1] === '\n') index++;
      }
      start = index + 1;
      const dispatched = this.#processLine(event);
      if (dispatched) events.push(dispatched);
    }
    this.#line += text.slice(start);
    if (this.#line.length + this.#data.length > this.maxEventLength)
      throw new CliError(
        'stream_event_too_large',
        `An event exceeded ${this.maxEventLength} characters.`,
        7,
      );
    return events;
  }

  #processLine(line: string): SseEvent | undefined {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') {
      this.#data += this.#hasData ? `\n${value}` : value;
      this.#hasData = true;
    } else if (field === 'id') {
      if (!value.includes('\0')) this.#lastEventId = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) {
      this.#blockRetry = Number(value);
      this.#retry = this.#blockRetry;
    }
  }

  #dispatch(): SseEvent | undefined {
    const retry = this.#blockRetry;
    const hasData = this.#hasData;
    const result: SseEvent = {
      type: 'event',
      event: this.#event || 'message',
      id: this.lastEventId,
      data: this.#data,
      ...(retry === undefined ? {} : { retry }),
    };
    this.#data = '';
    this.#hasData = false;
    this.#event = '';
    this.#blockRetry = undefined;
    if (!hasData) return;
    this.#events++;
    return result;
  }
}
