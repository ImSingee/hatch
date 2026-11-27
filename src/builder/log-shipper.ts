/**
 * Build output on its way from a Builder to the platform's logs endpoint
 * (src/builder/protocol.ts).
 */
import {
  LOG_BATCH_MAX_BYTES,
  LOG_BATCH_MAX_LINES,
  LOG_LINE_MAX_CHARS,
} from './protocol';

const LOG_SEND_ATTEMPTS = 3;
/**
 * Build output waiting to be sent, at most: past it, output is dropped and
 * one line says how much, so a platform that cannot keep up costs bounded
 * memory instead of all of a long build's output.
 */
const LOG_QUEUE_MAX_LINES = 20_000;
const LOG_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
/** How long the line noting dropped output may take to send. */
const LOG_NOTE_TIMEOUT_MS = 5_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function cutLine(line: string): string {
  return line.length > LOG_LINE_MAX_CHARS
    ? `${line.slice(0, LOG_LINE_MAX_CHARS - 1)}…`
    : line;
}

/** The line that stands for `count` lines of output that were dropped. */
function droppedNote(count: number): string {
  return `[builder] ${count} line(s) of build output were dropped: the platform did not take them in time.`;
}

/** A queued log line, or a note standing for `lines` dropped ones. */
type LogEntry = { text: string; lines: number };

/** What `entry` adds to a logs call's JSON body. */
const jsonBytes = (entry: LogEntry) =>
  Buffer.byteLength(JSON.stringify(entry.text)) + 1;

/**
 * Build output on its way to the platform: sent one batch at a time, in
 * order, each within the protocol's line and byte limits. The queue is
 * bounded (output past it is dropped and counted); a failed batch is
 * retried a few times, then dropped and counted, so a broken log endpoint
 * cannot hold up the build. Each gap is marked, where it occurred, by one
 * line saying how many lines it lost.
 */
export class LogShipper {
  private queue: LogEntry[] = [];
  private queuedBytes = 0;
  /**
   * Lines lost after everything queued (the queue was full), not yet
   * reported: the next line queued is preceded by their note.
   */
  private dropped = 0;
  /**
   * Lines lost just before the queue's first entry (a batch that failed),
   * not yet reported: their note leads the next batch. It is no queue entry,
   * so it never keeps a flush going by itself.
   */
  private lostAhead = 0;
  /** Lines (notes counted by what they stand for) of the batch in flight. */
  private inFlight = 0;
  private sending: Promise<void> = Promise.resolve();
  private stopped = false;
  /** A flush started by a burst is pending. */
  private kicked = false;
  /** Aborts the batch in flight once the shipper is abandoned. */
  private readonly abandon = new AbortController();

  constructor(
    private readonly send: (
      lines: string[],
      signal: AbortSignal,
    ) => Promise<Response>,
  ) {}

  push(lines: readonly string[]): void {
    if (this.stopped) return;
    for (const raw of lines) {
      const line = cutLine(raw);
      if (
        this.queue.length >= LOG_QUEUE_MAX_LINES ||
        this.queuedBytes + Buffer.byteLength(line) > LOG_QUEUE_MAX_BYTES
      ) {
        this.dropped += 1;
        continue;
      }
      // Space again after a gap: the note goes where the gap is. One note
      // per gap, so notes stay bounded by the lines that fit.
      this.noteDropped();
      this.enqueue({ text: line, lines: 1 });
    }
    // A burst sends at once rather than at the next timed flush, so the
    // queue limit drops output only when the platform falls behind.
    if (!this.kicked && this.queue.length >= LOG_BATCH_MAX_LINES) {
      this.kicked = true;
      void this.flush().finally(() => (this.kicked = false));
    }
  }

  private noteDropped(): void {
    if (this.dropped === 0) return;
    this.enqueue({ text: droppedNote(this.dropped), lines: this.dropped });
    this.dropped = 0;
  }

  private enqueue(entry: LogEntry): void {
    this.queue.push(entry);
    this.queuedBytes += Buffer.byteLength(entry.text);
  }

  /** Send what is queued now; resolves when it (and earlier sends) landed. */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.queue.length > 0 && !this.stopped) {
        await this.sendBatch(this.takeBatch());
      }
    });
    return this.sending;
  }

  /**
   * Send the rest within `ms`, or until `signal` aborts. Then the batch in
   * flight is aborted, what is still queued is dropped, and (unless `signal`
   * aborted) one line saying how many lines may be missing is sent, with a
   * short deadline of its own.
   */
  async drain(ms: number, signal: AbortSignal): Promise<void> {
    if (!this.stopped) this.noteDropped();
    const deadline = AbortSignal.any([AbortSignal.timeout(ms), signal]);
    const flushed = this.flush();
    await new Promise<void>((resolve) => {
      if (deadline.aborted) resolve();
      deadline.addEventListener('abort', () => resolve(), { once: true });
      void flushed.then(resolve);
    });
    if (this.stopped) return;
    if (!deadline.aborted) {
      // Everything was sent, except batches that ran out of retries during
      // this last flush (and output dropped after them): reported too, with
      // nothing sent after them.
      const lost = this.lostAhead + this.dropped;
      if (lost > 0 && !signal.aborted) {
        this.lostAhead = 0;
        this.dropped = 0;
        await this.sendNote(droppedNote(lost), signal);
      }
      return;
    }
    this.stopped = true;
    this.abandon.abort();
    // The aborted batch may or may not have landed: counted as missing.
    let lost = this.inFlight + this.lostAhead + this.dropped;
    for (const entry of this.queue) lost += entry.lines;
    this.queue = [];
    this.queuedBytes = 0;
    if (lost === 0) return;
    console.error(`[builder] up to ${lost} build log line(s) not sent`);
    if (signal.aborted) return;
    await this.sendNote(
      `[builder] Up to ${lost} line(s) of build output are missing: ` +
        'the platform did not take them in time.',
      signal,
    );
  }

  /** One note line, within its own short deadline and the run's signal. */
  private async sendNote(text: string, signal: AbortSignal): Promise<void> {
    await this.send(
      [text],
      AbortSignal.any([AbortSignal.timeout(LOG_NOTE_TIMEOUT_MS), signal]),
    ).catch(() => {});
  }

  /**
   * The next batch: the note of a gap just before the queue (if any), then
   * queued entries. It always takes the first queued entry, so each batch
   * moves the queue on; a cut line and a note fit any batch.
   */
  private takeBatch(): LogEntry[] {
    const batch: LogEntry[] = [];
    // `{"lines":[]}` plus each JSON string and its comma.
    let bytes = 12;
    if (this.lostAhead > 0) {
      const note = { text: droppedNote(this.lostAhead), lines: this.lostAhead };
      this.lostAhead = 0;
      batch.push(note);
      bytes += jsonBytes(note);
    }
    let count = 0;
    while (
      count < this.queue.length &&
      batch.length + count < LOG_BATCH_MAX_LINES
    ) {
      const size = jsonBytes(this.queue[count]!);
      if (count > 0 && bytes + size > LOG_BATCH_MAX_BYTES) break;
      bytes += size;
      count += 1;
    }
    const taken = this.queue.splice(0, count);
    for (const entry of taken) {
      this.queuedBytes -= Buffer.byteLength(entry.text);
    }
    batch.push(...taken);
    return batch;
  }

  private async sendBatch(batch: LogEntry[]): Promise<void> {
    const represented = batch.reduce((sum, entry) => sum + entry.lines, 0);
    this.inFlight = represented;
    try {
      const lines = batch.map((entry) => entry.text);
      for (let attempt = 1; attempt <= LOG_SEND_ATTEMPTS; attempt++) {
        if (this.abandon.signal.aborted) return;
        const response = await this.send(lines, this.abandon.signal).catch(
          () => null,
        );
        if (response?.ok) return;
        if (response?.status === 409) {
          // The lease moved on; nothing more is accepted for this build.
          this.stopped = true;
          this.queue = [];
          this.queuedBytes = 0;
          return;
        }
        if (response && response.status >= 400 && response.status < 500) break;
        await sleep(500 * attempt, this.abandon.signal);
      }
      if (this.abandon.signal.aborted) return;
      console.error(`[builder] dropped ${represented} build log line(s)`);
      // Everything still queued came after this batch, so its note leads
      // the next one. A note it carried is folded in: one note per gap.
      this.lostAhead += represented;
    } finally {
      // An abandoned batch is counted by drain(), which reads it first.
      if (!this.abandon.signal.aborted) this.inFlight = 0;
    }
  }
}
