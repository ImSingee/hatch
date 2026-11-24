// @ts-self-types="./tasks.d.ts"
/**
 * @hatch/app/tasks — write App tasks: backend RPC methods the manifest marks
 * as runnable. Every run executes the method in its own backend instance;
 * `step` records observable, retried units of work in the run inspector.
 */
import { hmacHeaders, runtimeEnv, verifyHmac } from './signing.js';

export type RetryOptions = {
  /** Total attempts including the first try (default 1 = no retry). */
  maxAttempts?: number;
  /** Delay before the first retry, in ms (default 0). */
  backoffMs?: number;
  /** Multiplier applied to the delay after each failed attempt (default 2). */
  factor?: number;
};

export type StepOptions = {
  retry?: RetryOptions;
};

export type TaskTrigger = 'manual' | 'cron' | 'webhook' | 'app';

/** The task run the current backend instance serves. */
export type TaskRun = {
  runId: string;
  task: string;
};

const SENTINEL = '[[hatch]]';
let nextSeq = 0;

/** The run this instance was started for, or null outside a task run. */
export function currentTaskRun(): TaskRun | null {
  const runId = runtimeEnv('HATCH_RUN_ID');
  const task = runtimeEnv('HATCH_TASK');
  return runId && task ? { runId, task } : null;
}

/** Whether this backend instance was started to serve one task run. */
export function isTaskRun(): boolean {
  return currentTaskRun() !== null;
}

function emit(event: Record<string, unknown>): void {
  console.log(SENTINEL + JSON.stringify(event));
}

function safeValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    if (json.length > 20_000) {
      return { truncated: true, preview: json.slice(0, 20_000) };
    }
    return JSON.parse(json);
  } catch {
    return { unserializable: String(value) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an observable, optionally retried unit of work. In a task run each
 * attempt is recorded (start, end, output or error) and shown in the run
 * inspector; called outside a task run (for example when the frontend calls
 * the same method) it only runs and retries `fn`.
 */
export async function step<T>(
  name: string,
  fn: () => Promise<T> | T,
  options: StepOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.retry?.maxAttempts ?? 1));
  const factor = options.retry?.factor ?? 2;
  let delay = Math.max(0, options.retry?.backoffMs ?? 0);
  const record = isTaskRun();
  const seq = nextSeq++;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = new Date().toISOString();
    if (record) emit({ t: 'step:start', seq, name, attempt, startedAt });
    try {
      const output = await fn();
      if (record) {
        emit({
          t: 'step:end',
          seq,
          name,
          attempt,
          status: 'succeeded',
          output: safeValue(output),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      return output;
    } catch (error) {
      const last = attempt >= maxAttempts;
      if (record) {
        emit({
          t: 'step:end',
          seq,
          name,
          attempt,
          status: last ? 'failed' : 'retrying',
          error: errorMessage(error),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      if (last) throw error;
      if (delay > 0) await sleep(delay);
      delay *= factor;
    }
  }
}

/** Write a line to the run log (stdout of the run's instance). */
export function log(...args: unknown[]): void {
  console.log(...args);
}

/**
 * Check that a request was sent by the platform to start a task run, and
 * return the run. Use it in a method that must only run as a task:
 *
 *   const run = await verifyTaskRequest(context.requestHeader);
 *   if (!run) throw new ConnectError('tasks only', Code.PermissionDenied);
 */
export async function verifyTaskRequest(
  headers: Headers,
): Promise<(TaskRun & { trigger: TaskTrigger }) | null> {
  const secret = runtimeEnv('HATCH_SIGNING_SECRET');
  const runId = headers.get('x-hatch-run-id');
  const task = headers.get('x-hatch-task');
  const trigger = headers.get('x-hatch-trigger') as TaskTrigger | null;
  if (!secret || !runId || !task || !trigger) return null;
  const valid = await verifyHmac({
    secret,
    timestamp: headers.get('x-hatch-timestamp'),
    signature: headers.get('x-hatch-signature'),
    body: `${runId}.${task}`,
    maxSkewMs: 5 * 60 * 1000,
  });
  return valid ? { runId, task, trigger } : null;
}

/**
 * Queue a run of one of this App's tasks from backend code and return its
 * id. The run starts in its own instance once a concurrency slot is free.
 */
export async function enqueueTask(
  task: string,
  input: Record<string, unknown> = {},
): Promise<{ runId: string; status: 'queued' | 'failed' }> {
  const url = runtimeEnv('HATCH_TASKS_URL');
  const secret = runtimeEnv('HATCH_SIGNING_SECRET');
  if (!url || !secret) {
    throw new Error(
      'Tasks are unavailable: enable capabilities.tasks and deploy the App.',
    );
  }
  const body = JSON.stringify({ task, input });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await hmacHeaders(secret, body)),
    },
    body,
  });
  if (response.status !== 202) {
    throw new Error(
      `Task "${task}" was not queued (${response.status}): ${await response.text()}`,
    );
  }
  return (await response.json()) as {
    runId: string;
    status: 'queued' | 'failed';
  };
}
