/**
 * App tasks: list, run (optionally waiting), run history, inspect, cancel,
 * and rotating the App webhook secret task webhooks accept.
 */
import type { JsonObject } from '@bufbuild/protobuf';
import { parseArgs } from 'node:util';
import { configPath, resolveCredential } from './config';
import {
  type AppTaskRunSummaryView,
  type AppTaskRunView,
  type AppTaskView,
  platformClient,
} from './client';
import { CliError, argumentsError } from './error';
import { readInput } from './input';

const ACTIONS = [
  'list',
  'run',
  'runs',
  'get-run',
  'cancel',
  'rotate-webhook-secret',
] as const;
type Action = (typeof ACTIONS)[number];

const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
/** Largest JSON input accepted by --input and --file, like the webhook. */
const MAX_INPUT_BYTES = 1_000_000;
const POLL_MS = 1000;

export type TaskCommand = {
  action: Action;
  id: string;
  /** Task name (run) or run id (get-run, cancel). */
  target?: string;
  input?: { inline: JsonObject } | { file: string };
  wait: boolean;
  task?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  json: boolean;
  timeoutMs: number;
  config?: string;
  profile?: string;
};

function invalid(message: string): CliError {
  return new CliError('invalid_arguments', message);
}

/** Validate arguments locally; nothing is sent until this succeeds. */
export function parseTaskCommand(
  args: readonly string[],
  offset: number,
): TaskCommand {
  const action = args[offset + 2] as Action | undefined;
  if (!action || !ACTIONS.includes(action))
    throw invalid(
      'Use hatch app task list, run, runs, get-run, cancel or rotate-webhook-secret. See hatch help app task.',
    );
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 3)],
      options: {
        json: { type: 'boolean' },
        config: { type: 'string' },
        profile: { type: 'string' },
        workdir: { type: 'string' },
        timeout: { type: 'string' },
        input: { type: 'string' },
        file: { type: 'string' },
        wait: { type: 'boolean' },
        task: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw argumentsError(error, `app task ${action}`);
  }
  const v = parsed.values;
  const positionals = parsed.positionals;
  const appOnly =
    action === 'list' ||
    action === 'runs' ||
    action === 'rotate-webhook-secret';
  const arity = appOnly ? 1 : 2;
  if (positionals.length !== arity || positionals.some((p) => !p))
    throw invalid(
      appOnly
        ? `Supply exactly one App ID or slug to task ${action}.`
        : action === 'run'
          ? 'Supply an App ID or slug and a task name to task run.'
          : `Supply an App ID or slug and a run ID to task ${action}.`,
    );
  const only = (flags: string[], allowed: Action[]) => {
    for (const flag of flags)
      if (v[flag as keyof typeof v] !== undefined && !allowed.includes(action))
        throw invalid(
          `--${flag} applies only to task ${allowed.join(' and task ')}.`,
        );
  };
  only(['input', 'file', 'wait'], ['run']);
  only(['task', 'status', 'limit', 'cursor'], ['runs']);

  let input: TaskCommand['input'];
  if (v.input !== undefined && v.file !== undefined)
    throw invalid('Supply at most one of --input and --file.');
  if (v.input !== undefined) {
    if (Buffer.byteLength(v.input) > MAX_INPUT_BYTES)
      throw new CliError('input_too_large', '--input exceeds 1 MB.');
    let value: unknown;
    try {
      value = JSON.parse(v.input);
    } catch {
      throw new CliError('invalid_input', '--input must be a JSON object.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new CliError('invalid_input', '--input must be a JSON object.');
    input = { inline: value as JsonObject };
  } else if (v.file !== undefined) {
    if (!v.file) throw invalid('--file needs a path or - for stdin.');
    input = { file: v.file };
  }

  if (v.status !== undefined && !STATUSES.includes(v.status))
    throw invalid(`--status must be one of ${STATUSES.join(', ')}.`);
  if (v.task !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v.task))
    throw invalid('--task must be a task name.');
  const limit = v.limit === undefined ? undefined : Number(v.limit);
  if (
    limit !== undefined &&
    (!/^[0-9]+$/.test(v.limit as string) || limit < 1 || limit > 200)
  )
    throw invalid('--limit must be an integer between 1 and 200.');
  if (v.cursor === '' || (v.cursor?.length ?? 0) > 191)
    throw invalid('--cursor must be the nextCursor of the previous page.');

  // Waiting for a run covers its 5-minute limit plus queueing.
  const defaultSeconds = v.wait ? 600 : 60;
  const seconds = v.timeout === undefined ? defaultSeconds : Number(v.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    v.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.profile)
  )
    throw invalid('Invalid profile name.');
  if (v.config === '') throw invalid('--config must not be empty.');
  return {
    action,
    id: positionals[0],
    target: positionals[1],
    input,
    wait: v.wait === true,
    task: v.task,
    status: v.status,
    limit,
    cursor: v.cursor,
    json: v.json === true,
    timeoutMs: Math.ceil(seconds * 1000),
    config: v.config,
    profile: v.profile,
  };
}

/** One line per task with every identifier a follow-up command needs. */
export function taskText(task: AppTaskView): string {
  const triggers = [
    'manual',
    ...task.cron.map((job) => `cron:${job.name}(${job.schedule})`),
    ...(task.webhook ? [`webhook:${task.webhookPath}`] : []),
  ];
  const parts = [
    task.name,
    task.method,
    triggers.join(','),
    `queued=${task.queued}`,
    `running=${task.running}`,
    ...(task.concurrency === null ? [] : [`concurrency=${task.concurrency}`]),
    ...(task.latestRun
      ? [`last=${task.latestRun.id}:${task.latestRun.status}`]
      : []),
  ];
  return parts.join('  ');
}

export function runSummaryText(run: AppTaskRunSummaryView): string {
  return [
    run.id,
    run.task,
    run.status,
    run.trigger + (run.cronName ? `:${run.cronName}` : ''),
    run.startedAt ?? run.createdAt,
    ...(run.durationMs === null ? [] : [`${run.durationMs}ms`]),
    `steps=${run.stepCount}`,
    ...(run.error ? [`error: ${run.error.split('\n')[0]}`] : []),
  ].join('  ');
}

export function runText(run: AppTaskRunView): string {
  const lines = [runSummaryText(run)];
  if (run.queuePosition !== null)
    lines.push(`queue position: ${run.queuePosition}`);
  for (const step of run.steps)
    lines.push(
      `  step ${step.seq} ${step.name} attempt ${step.attempt}: ${step.status}${step.error ? ` — ${step.error.split('\n')[0]}` : ''}`,
    );
  if (run.output !== null) lines.push(`output: ${JSON.stringify(run.output)}`);
  if (run.log) lines.push(`log:\n${run.log.trimEnd()}`);
  return lines.join('\n');
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    // Abort events are not replayed: an already-aborted signal must reject
    // now, or polling would continue past the deadline.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export async function runTask(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const command = parseTaskCommand(args, offset);
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, command.config),
    command.profile,
  );
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(command.timeoutMs),
  ]);
  // Every request shares the overall deadline, so `--timeout` bounds the
  // whole command, including each poll of a waited run.
  const { task } = platformClient(credential, command.timeoutMs, deadline).apps;
  const write = (json: unknown, text: string) =>
    process.stdout.write(
      command.json ? `${JSON.stringify(json)}\n` : `${text}\n`,
    );

  if (command.action === 'list') {
    const view = await task.list({ id: command.id });
    write(
      view,
      view.available
        ? [
            `${view.appId}  concurrency=${view.concurrency}  queued=${view.queued}  running=${view.running}`,
            ...view.tasks.map(taskText),
          ].join('\n')
        : `${view.appId}  No runnable tasks (not deployed, archived or none declared).`,
    );
    return;
  }
  if (command.action === 'runs') {
    const page = await task.runs({
      id: command.id,
      task: command.task,
      status: command.status,
      limit: command.limit,
      cursor: command.cursor,
    });
    write(
      page,
      [
        ...(page.runs.length ? page.runs.map(runSummaryText) : ['No runs.']),
        ...(page.nextCursor === null
          ? []
          : [`next cursor: ${page.nextCursor}`]),
      ].join('\n'),
    );
    return;
  }
  if (command.action === 'get-run') {
    const run = await task.get({
      id: command.id,
      runId: command.target as string,
    });
    write(run, runText(run));
    return;
  }
  if (command.action === 'rotate-webhook-secret') {
    const { secret } = await task.rotateWebhookSecret({ id: command.id });
    write(
      { appId: command.id, secret },
      `${command.id}  webhook secret: ${secret}\nThe previous secret no longer works; this is the only time the new one is printed.`,
    );
    return;
  }
  if (command.action === 'cancel') {
    const result = await task.cancel({
      id: command.id,
      runId: command.target as string,
    });
    write(
      { runId: command.target, ...result },
      `${command.target}  ${result.canceled ? 'canceled' : `not canceled (${result.status})`}`,
    );
    return;
  }

  const input =
    command.input === undefined
      ? {}
      : 'inline' in command.input
        ? command.input.inline
        : ((await readInput(
            command.input.file,
            signal,
            MAX_INPUT_BYTES,
          )) as JsonObject);
  const started = await task.run({
    id: command.id,
    task: command.target as string,
    input,
  });
  if (!command.wait) {
    write(started, `${started.runId}  ${started.status}`);
    return;
  }
  process.stderr.write(`Run ${started.runId} ${started.status}; waiting…\n`);
  let status = started.status;
  const poll = async (wait: boolean) => {
    try {
      if (wait) await sleep(POLL_MS, deadline);
      return await task.get({ id: command.id, runId: started.runId });
    } catch (error) {
      if (signal.aborted) throw new CliError('canceled', 'Canceled.', 130);
      if (!deadline.aborted) throw error;
      throw new CliError(
        'timeout',
        `Run ${started.runId} is still ${status} after --timeout. Inspect it with hatch app task get-run ${command.id} ${started.runId}.`,
        7,
        undefined,
        { runId: started.runId, status },
      );
    }
  };
  let run = await poll(false);
  status = run.status;
  while (!TERMINAL.has(run.status)) {
    run = await poll(true);
    if (run.status !== status) {
      process.stderr.write(`Run ${run.id} ${run.status}\n`);
      status = run.status;
    }
  }
  if (run.status === 'succeeded') {
    write(run, runText(run));
    return;
  }
  // With --json the error envelope is the only stdout document; it carries
  // the full run so automation still gets steps, log and error.
  if (!command.json) process.stdout.write(`${runText(run)}\n`);
  throw new CliError(
    run.status === 'canceled' ? 'task_run_canceled' : 'task_run_failed',
    `Run ${run.id} ${run.status}${run.error ? `: ${run.error.split('\n')[0]}` : '.'}`,
    6,
    undefined,
    { runId: run.id, status: run.status, run },
  );
}
