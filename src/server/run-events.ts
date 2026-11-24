/**
 * Server-only: the stdout event protocol shared by Workflow runs and App task
 * runs.
 *
 * A run process reports its steps as `[[hatch]]{json}` lines on stdout; every
 * other line is plain log output. This module turns a child's stdout/stderr
 * into bounded log text plus an ordered stream of step events, so each caller
 * only decides where the events are stored.
 */

export const RUN_EVENT_SENTINEL = '[[hatch]]';
/** Completed log lines kept per run (tail). */
export const MAX_RUN_LOG = 100_000;
/**
 * Cap on a single pending stdout record (a line with no newline yet).
 * `MAX_RUN_LOG` only bounds completed lines, so without this a process that
 * streams megabytes on one line would grow the buffer until the platform runs
 * out of memory, long before the run timeout fires.
 */
export const MAX_RUN_STDOUT_BUFFER = 1_000_000;
/**
 * Cap on persisted step events per run. Each step attempt writes a row, so a
 * `step()` call in a tight loop would otherwise flood the step table.
 */
export const MAX_RUN_STEP_EVENTS = 2000;

export type StepStartEvent = {
  t: 'step:start';
  seq: number;
  name: string;
  attempt?: number;
  startedAt?: string;
};

export type StepEndEvent = {
  t: 'step:end';
  seq: number;
  name: string;
  attempt?: number;
  status: 'succeeded' | 'failed' | 'retrying';
  output?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type RunEndEvent = {
  t: 'run:end';
  status: 'succeeded' | 'failed';
  output?: unknown;
  error?: string;
};

export type RunEvent = StepStartEvent | StepEndEvent | RunEndEvent;

/** Why a stream asked for its process to be killed, if it did. */
export type RunStreamOverflow = 'steps' | 'line' | null;

export type RunEventStreamOptions = {
  /** Persist one event. Calls are serialized in stdout order. */
  onEvent: (event: RunEvent) => Promise<void>;
  /** Kill the process: the stream hit a step or line cap. */
  onOverflow: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse one sentinel payload: an event, `ignored` for a well-formed record
 * of a kind the platform does not store (e.g. the SDK's `run:start`), or null
 * when it is not a protocol record at all (then it is kept as a log line).
 */
function parseEvent(payload: string): RunEvent | 'ignored' | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.t !== 'string') return null;
  if (value.t === 'run:end') {
    return value.status === 'succeeded' || value.status === 'failed'
      ? (value as RunEndEvent)
      : null;
  }
  if (value.t !== 'step:start' && value.t !== 'step:end') return 'ignored';
  if (
    typeof value.seq !== 'number' ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.name !== 'string'
  ) {
    return null;
  }
  if (
    value.t === 'step:end' &&
    value.status !== 'succeeded' &&
    value.status !== 'failed' &&
    value.status !== 'retrying'
  ) {
    return null;
  }
  return value as StepStartEvent | StepEndEvent;
}

/**
 * Line splitter, log accumulator and serialized event sink for one run.
 * Feed it the child's output, then `await finish()` once the child closed
 * stdout so every event is persisted before the run's terminal status.
 */
export class RunEventStream {
  private log = '';
  private pending = '';
  private chain: Promise<void> = Promise.resolve();
  private stepEvents = 0;
  private overflowReason: RunStreamOverflow = null;
  private ended: RunEndEvent | null = null;
  private failure: unknown = null;

  constructor(private readonly options: RunEventStreamOptions) {}

  /** The log tail collected so far. */
  get text(): string {
    return this.log;
  }

  /** The `run:end` event, unless a cap overflow voided the run. */
  get runEnd(): RunEndEvent | null {
    return this.overflowReason ? null : this.ended;
  }

  get overflow(): RunStreamOverflow {
    return this.overflowReason;
  }

  appendLog(text: string): void {
    this.log = (this.log + text).slice(-MAX_RUN_LOG);
  }

  /** Feed a chunk of stdout. */
  stdout(chunk: Buffer | string): void {
    if (this.overflowReason === 'line') return;
    this.pending += chunk.toString();
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const part of parts) this.enqueue(part);
    // Only the trailing, still-unterminated record remains in the buffer. If
    // it alone exceeds the cap the process streams one unbounded line.
    if (this.pending.length > MAX_RUN_STDOUT_BUFFER) {
      this.pending = '';
      this.trip('line');
    }
  }

  /** Feed a chunk of stderr (always plain log output). */
  stderr(chunk: Buffer | string): void {
    this.appendLog(chunk.toString());
  }

  /**
   * Flush the unterminated last line and wait until every event has been
   * handed to `onEvent`. Rejects with the first persistence error.
   */
  async finish(): Promise<void> {
    if (this.pending) {
      this.enqueue(this.pending);
      this.pending = '';
    }
    await this.chain;
    if (this.failure) throw this.failure;
  }

  private trip(reason: Exclude<RunStreamOverflow, null>): void {
    if (this.overflowReason) return;
    this.overflowReason = reason;
    this.options.onOverflow();
  }

  private enqueue(line: string): void {
    this.chain = this.chain.then(async () => {
      if (this.failure) return;
      try {
        await this.handle(line);
      } catch (error) {
        this.failure = error;
      }
    });
  }

  private async handle(line: string): Promise<void> {
    if (!line.startsWith(RUN_EVENT_SENTINEL)) {
      if (line.length > 0) this.appendLog(`${line}\n`);
      return;
    }
    const event = parseEvent(line.slice(RUN_EVENT_SENTINEL.length));
    if (event === 'ignored') return;
    if (!event) {
      this.appendLog(`${line}\n`);
      return;
    }
    if (event.t === 'run:end') {
      this.ended = event;
      return;
    }
    if (this.overflowReason === 'steps') return;
    this.stepEvents += 1;
    if (this.stepEvents > MAX_RUN_STEP_EVENTS) {
      // A step loop this hot is a bug (or abuse); every further event would
      // be another database write.
      this.trip('steps');
      return;
    }
    await this.options.onEvent(event);
  }
}
