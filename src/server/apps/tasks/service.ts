/**
 * Server-only: App task runs.
 *
 * A task is a backend RPC method the manifest marks as runnable. Starting a
 * run validates its input against the schema captured at deploy time and
 * queues a row; the dispatcher starts queued runs within the App's and the
 * task's concurrency caps, each in its own backend instance
 * (`runInDedicatedInstance`). The instance reports steps on stdout and the
 * method's Connect response becomes the run output.
 *
 * Run state lives in memory per platform process, like the backend instance
 * registry: at boot, runs left `running` are failed and `queued` runs are
 * dispatched again.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  appCompatibility,
  appCompatibilityRuntimeMessage,
} from '~/app-compatibility';
import { db, schema } from '~/db';
import type { AppTaskRunStatus, AppTaskTrigger, JsonValue } from '~/db/schema';
import { AppError } from '~server/errors';
import { runDurationMs, type RunDetailView } from '~lib/runs';
import { validateSchemaInput } from '../../json-schema-input';
import {
  MAX_RUN_STEP_EVENTS,
  RunEventStream,
  type StepEndEvent,
  type StepStartEvent,
} from '../../run-events';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  hatchSignature,
} from '../../secrets';
import {
  type NormalizedManifest,
  type NormalizedTask,
  type NormalizedTasks,
  taskRunUrl,
} from '../manifest';
import { nextRun, parseCron } from '../cron-expr';
import { type DedicatedRunHandle, runInDedicatedInstance } from '../runtime';

/** Same bound as a Workflow run and a platform call into a backend. */
export const TASK_RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Queued runs one App may hold before new ones are refused. */
export const TASK_QUEUE_LIMIT = 100;
/** Output bytes kept from a method's response. */
const MAX_TASK_OUTPUT_BYTES = 1024 * 1024;

export const TASK_HEADER = 'x-hatch-task';
export const TASK_RUN_HEADER = 'x-hatch-run-id';
export const TASK_TRIGGER_HEADER = 'x-hatch-trigger';

/** Too many queued runs; callers map it to 429. */
export class TaskQueueFullError extends AppError {
  constructor(taskName: string) {
    super(
      `Task "${taskName}" was not started: the App already has ${TASK_QUEUE_LIMIT} queued runs.`,
      429,
    );
    this.name = 'TaskQueueFullError';
  }
}

/* ---------------------------- task definitions ---------------------------- */

type TaskContext = {
  appId: string;
  deploymentId: string;
  version: number;
  service: string;
  tasks: NormalizedTasks;
  signingSecret: string | null;
  webhookSecret: string | null;
};

/**
 * The tasks of an App's active deployment. Throws `AppError` with the HTTP
 * status a caller should use: 404 for an unknown App, 409 when it cannot run
 * tasks right now, 503 for an unsupported compatibility version.
 */
async function activeTaskContext(appId: string): Promise<TaskContext> {
  const app = await db.query.apps.findFirst({
    where: { id: appId },
    columns: {
      id: true,
      status: true,
      capabilities: true,
      currentDeploymentId: true,
      signingSecret: true,
      webhookSecret: true,
    },
  });
  if (!app) throw new AppError(`App "${appId}" not found.`, 404);
  if (app.status === 'archived') {
    throw new AppError('The App is archived; restore it to run tasks.', 409);
  }
  if (!app.currentDeploymentId) {
    throw new AppError('The App has no active deployment.', 409);
  }
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId },
    columns: {
      id: true,
      version: true,
      compatibilityVersion: true,
      manifestNormalized: true,
    },
  });
  if (!deployment) {
    throw new AppError('The active App deployment record is unavailable.', 503);
  }
  const compatibility = appCompatibility(deployment.compatibilityVersion);
  if (!compatibility.isSupported) {
    throw new AppError(appCompatibilityRuntimeMessage(compatibility), 503);
  }
  const manifest = deployment.manifestNormalized as NormalizedManifest | null;
  if (!app.capabilities?.tasks || !manifest?.tasks || !manifest.rpc) {
    throw new AppError('The App declares no tasks.', 409);
  }
  return {
    appId,
    deploymentId: deployment.id,
    version: deployment.version,
    service: manifest.rpc.service,
    tasks: manifest.tasks,
    signingSecret: app.signingSecret ?? null,
    webhookSecret: app.webhookSecret ?? null,
  };
}

function findTask(context: TaskContext, taskName: string): NormalizedTask {
  const task = context.tasks.definitions.find((t) => t.name === taskName);
  if (!task) {
    throw new AppError(`Task "${taskName}" is not declared by the App.`, 404);
  }
  return task;
}

/* --------------------------------- start ---------------------------------- */

export type StartTaskRunOptions = {
  trigger: AppTaskTrigger;
  input?: unknown;
  /** Schedule that fired a `cron` run. */
  cronName?: string;
  /** User id, or `agent` for an Agent Run. */
  actor?: string | null;
  /**
   * Only for webhooks: the task must have its webhook trigger enabled. Other
   * triggers are always available.
   */
  requireWebhook?: boolean;
};

export type StartTaskRunResult = { runId: string; status: AppTaskRunStatus };

/**
 * Validate input, record a run and queue it. Invalid input is recorded as a
 * failed run (no instance is started) so the caller can show why.
 */
export async function startTaskRun(
  appId: string,
  taskName: string,
  options: StartTaskRunOptions,
): Promise<StartTaskRunResult> {
  const context = await activeTaskContext(appId);
  const task = findTask(context, taskName);
  if (options.requireWebhook && !task.webhook) {
    throw new AppError(`Task "${taskName}" does not accept webhook runs.`, 404);
  }
  const rawInput = options.input ?? {};
  const validation = validateSchemaInput(task.inputSchema, rawInput, {
    strict: true,
  });
  const base = {
    id: ulid().toLowerCase(),
    appId,
    taskName,
    trigger: options.trigger,
    cronName: options.cronName ?? null,
    actor: options.actor ?? null,
  };
  if (!validation.success) {
    await db.insert(schema.appTaskRuns).values({
      ...base,
      status: 'failed',
      input: rawInput as JsonValue,
      error: `Input validation failed: ${validation.message}`,
      finishedAt: new Date(),
    });
    return { runId: base.id, status: 'failed' };
  }
  const [{ queued }] = await db
    .select({ queued: sql<number>`count(*)::int` })
    .from(schema.appTaskRuns)
    .where(
      and(
        eq(schema.appTaskRuns.appId, appId),
        eq(schema.appTaskRuns.status, 'queued'),
      ),
    );
  if (queued >= TASK_QUEUE_LIMIT) throw new TaskQueueFullError(taskName);
  await db.insert(schema.appTaskRuns).values({
    ...base,
    status: 'queued',
    input: validation.data as JsonValue,
  });
  dispatch(appId);
  return { runId: base.id, status: 'queued' };
}

/* -------------------------------- dispatch -------------------------------- */

type ActiveRun = {
  taskName: string;
  abort: AbortController;
  handle: DedicatedRunHandle | null;
};

type TaskGlobal = typeof globalThis & {
  __hatchTaskRuns__?: Map<string, Map<string, ActiveRun>>;
  __hatchTaskDispatch__?: Map<string, { running: boolean; again: boolean }>;
};

/** Runs this platform process is executing, per App. */
function activeRuns(appId: string): Map<string, ActiveRun> {
  const g = globalThis as TaskGlobal;
  g.__hatchTaskRuns__ ??= new Map();
  let runs = g.__hatchTaskRuns__.get(appId);
  if (!runs) {
    runs = new Map();
    g.__hatchTaskRuns__.set(appId, runs);
  }
  return runs;
}

function dispatchState(appId: string): { running: boolean; again: boolean } {
  const g = globalThis as TaskGlobal;
  g.__hatchTaskDispatch__ ??= new Map();
  let state = g.__hatchTaskDispatch__.get(appId);
  if (!state) {
    state = { running: false, again: false };
    g.__hatchTaskDispatch__.set(appId, state);
  }
  return state;
}

/**
 * Start as many queued runs of an App as its caps allow. Passes are
 * serialized per App, and a request during a pass schedules one more, so a
 * run is never claimed twice and a freed slot is never missed.
 */
export function dispatch(appId: string): void {
  const state = dispatchState(appId);
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  void (async () => {
    try {
      do {
        state.again = false;
        await dispatchPass(appId).catch((error) => {
          console.error(
            `[tasks] dispatch for App "${appId}" failed:`,
            error instanceof Error ? error.message : error,
          );
        });
      } while (state.again);
    } finally {
      state.running = false;
    }
  })();
}

async function failQueuedRuns(appId: string, error: string): Promise<void> {
  await db
    .update(schema.appTaskRuns)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(
      and(
        eq(schema.appTaskRuns.appId, appId),
        eq(schema.appTaskRuns.status, 'queued'),
      ),
    );
}

async function dispatchPass(appId: string): Promise<void> {
  const queued = await db.query.appTaskRuns.findMany({
    where: { appId, status: 'queued' },
    orderBy: { createdAt: 'asc', id: 'asc' },
    limit: TASK_QUEUE_LIMIT,
    columns: { id: true, taskName: true, input: true, trigger: true },
  });
  if (queued.length === 0) return;
  let context: TaskContext;
  try {
    context = await activeTaskContext(appId);
  } catch (error) {
    // The App can no longer run tasks (archived, tasks removed, unsupported
    // deployment): nothing queued will ever start, so say why now.
    await failQueuedRuns(
      appId,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const running = activeRuns(appId);
  for (const run of queued) {
    if (running.size >= context.tasks.concurrency) break;
    const task = context.tasks.definitions.find((t) => t.name === run.taskName);
    if (!task) {
      await db
        .update(schema.appTaskRuns)
        .set({
          status: 'failed',
          error: `Task "${run.taskName}" is no longer declared by the active deployment.`,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(schema.appTaskRuns.id, run.id),
            eq(schema.appTaskRuns.status, 'queued'),
          ),
        );
      continue;
    }
    if (task.concurrency !== undefined) {
      let sameTask = 0;
      for (const active of running.values()) {
        if (active.taskName === task.name) sameTask += 1;
      }
      // Keep this run queued; later runs of other tasks may still fit.
      if (sameTask >= task.concurrency) continue;
    }
    const claimed = await db
      .update(schema.appTaskRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(
        and(
          eq(schema.appTaskRuns.id, run.id),
          eq(schema.appTaskRuns.status, 'queued'),
        ),
      )
      .returning({ id: schema.appTaskRuns.id });
    if (claimed.length === 0) continue;
    const active: ActiveRun = {
      taskName: task.name,
      abort: new AbortController(),
      handle: null,
    };
    running.set(run.id, active);
    void executeRun(context, task, run.id, run.input, run.trigger, active)
      .catch(async (error) => {
        await finalizeRun(run.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          output: null,
          log: null,
        }).catch(() => {});
      })
      .finally(() => {
        running.delete(run.id);
        dispatch(appId);
      });
  }
}

/* -------------------------------- execute --------------------------------- */

async function upsertStepStart(
  runId: string,
  e: StepStartEvent,
): Promise<void> {
  const startedAt = e.startedAt ? new Date(e.startedAt) : new Date();
  await db
    .insert(schema.appTaskRunSteps)
    .values({
      runId,
      seq: e.seq,
      name: e.name,
      status: 'running',
      attempt: e.attempt ?? 1,
      startedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.appTaskRunSteps.runId,
        schema.appTaskRunSteps.seq,
        schema.appTaskRunSteps.attempt,
      ],
      set: {
        name: e.name,
        status: 'running',
        startedAt,
        error: null,
        finishedAt: null,
      },
    });
}

async function upsertStepEnd(runId: string, e: StepEndEvent): Promise<void> {
  // Each attempt is its own row; a `retrying` attempt failed and the next
  // attempt arrives as a separate row.
  const status = e.status === 'succeeded' ? 'succeeded' : 'failed';
  const finishedAt = e.finishedAt ? new Date(e.finishedAt) : new Date();
  await db
    .insert(schema.appTaskRunSteps)
    .values({
      runId,
      seq: e.seq,
      name: e.name,
      status,
      attempt: e.attempt ?? 1,
      output: (e.output ?? null) as JsonValue,
      error: e.error ?? null,
      startedAt: e.startedAt ? new Date(e.startedAt) : null,
      finishedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.appTaskRunSteps.runId,
        schema.appTaskRunSteps.seq,
        schema.appTaskRunSteps.attempt,
      ],
      set: {
        status,
        output: (e.output ?? null) as JsonValue,
        error: e.error ?? null,
        finishedAt,
      },
    });
}

async function failRunningSteps(runId: string, error: string): Promise<void> {
  await db
    .update(schema.appTaskRunSteps)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(
      and(
        eq(schema.appTaskRunSteps.runId, runId),
        eq(schema.appTaskRunSteps.status, 'running'),
      ),
    );
}

/**
 * Write a run's terminal state, unless it is no longer running (a cancel
 * won). A canceled run still gets its log.
 */
async function finalizeRun(
  runId: string,
  result: {
    status: 'succeeded' | 'failed';
    output: JsonValue | null;
    error: string | null;
    log: string | null;
  },
): Promise<void> {
  if (result.status === 'failed') {
    await failRunningSteps(runId, result.error ?? 'Run failed');
  }
  const finalized = await db
    .update(schema.appTaskRuns)
    .set({
      status: result.status,
      output: result.output,
      error: result.error,
      log: result.log,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(schema.appTaskRuns.id, runId),
        eq(schema.appTaskRuns.status, 'running'),
      ),
    )
    .returning({ id: schema.appTaskRuns.id });
  if (finalized.length === 0) {
    await failRunningSteps(runId, 'Canceled');
    await db
      .update(schema.appTaskRuns)
      .set({ log: result.log })
      .where(eq(schema.appTaskRuns.id, runId));
  }
}

/** Connect JSON errors carry `{ code, message }`. */
function connectError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof parsed.message === 'string' || typeof parsed.code === 'string') {
      return [parsed.code, parsed.message].filter(Boolean).join(': ');
    }
  } catch {
    /* not JSON */
  }
  const text = body.trim().slice(0, 500);
  return text ? `HTTP ${status}: ${text}` : `HTTP ${status}`;
}

function parseOutput(body: string): JsonValue | null {
  if (Buffer.byteLength(body) > MAX_TASK_OUTPUT_BYTES) {
    return {
      truncated: true,
      bytes: Buffer.byteLength(body),
      preview: body.slice(0, 2000),
    };
  }
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as JsonValue;
  } catch {
    return body;
  }
}

async function executeRun(
  context: TaskContext,
  task: NormalizedTask,
  runId: string,
  input: JsonValue | null,
  trigger: AppTaskTrigger,
  active: ActiveRun,
): Promise<void> {
  const body = JSON.stringify(input ?? {});
  const timestamp = String(Date.now());
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    [TASK_HEADER]: task.name,
    [TASK_RUN_HEADER]: runId,
    [TASK_TRIGGER_HEADER]: trigger,
    [HATCH_TIMESTAMP_HEADER]: timestamp,
  };
  // Signed over `<timestamp>.<runId>.<task>`, which a Connect handler can
  // rebuild from headers alone (`verifyTaskRequest` in @hatch/app/tasks), so
  // a method that must only run as a task can tell the platform sent it.
  if (context.signingSecret) {
    headers[HATCH_SIGNATURE_HEADER] = hatchSignature(
      context.signingSecret,
      timestamp,
      `${runId}.${task.name}`,
    );
  }

  const stream = new RunEventStream({
    onEvent: (event) =>
      event.t === 'step:start'
        ? upsertStepStart(runId, event)
        : event.t === 'step:end'
          ? upsertStepEnd(runId, event)
          : Promise.resolve(),
    onOverflow: () => active.handle?.kill(),
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    active.abort.abort();
  }, TASK_RUN_TIMEOUT_MS);
  timeout.unref();

  let recorded: Promise<unknown> = Promise.resolve();
  let result;
  try {
    result = await runInDedicatedInstance(context.appId, {
      request: {
        path: `/${context.service}/${task.method}`,
        headers,
        body,
      },
      env: { HATCH_RUN_ID: runId, HATCH_TASK: task.name },
      onStdout: (chunk) => stream.stdout(chunk),
      onStderr: (chunk) => stream.stderr(chunk),
      onSpawn: (handle) => {
        active.handle = handle;
        // The deployment is known only once the instance is spawned: a
        // deploy between queueing and starting serves the new version.
        recorded = db
          .select({ version: schema.deployments.version })
          .from(schema.deployments)
          .where(eq(schema.deployments.id, handle.deploymentId))
          .then(([row]) =>
            db
              .update(schema.appTaskRuns)
              .set({
                deploymentId: handle.deploymentId,
                version: row?.version ?? null,
              })
              .where(eq(schema.appTaskRuns.id, runId)),
          );
      },
      signal: active.abort.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  // Steps arrive on stdout and the result over HTTP; the instance has exited
  // and closed stdout, so persist every step before the terminal status.
  await stream.finish();
  await recorded.catch(() => {});
  const log = stream.text || null;

  const response = result.response;
  if (stream.overflow) {
    await finalizeRun(runId, {
      status: 'failed',
      output: null,
      error:
        stream.overflow === 'steps'
          ? `Task exceeded ${MAX_RUN_STEP_EVENTS} step events`
          : 'Task produced too much output on a single line',
      log,
    });
    return;
  }
  if (response && response.status >= 200 && response.status < 300) {
    await finalizeRun(runId, {
      status: 'succeeded',
      output: parseOutput(response.body),
      error: null,
      log,
    });
    return;
  }
  const error = response
    ? connectError(response.status, response.body)
    : timedOut
      ? `Run timed out after ${TASK_RUN_TIMEOUT_MS / 60_000} minutes`
      : result.error === 'aborted'
        ? 'Canceled'
        : `Run did not complete: ${result.error ?? 'unknown error'}`;
  await finalizeRun(runId, { status: 'failed', output: null, error, log });
}

/* --------------------------- cancel and recovery --------------------------- */

/** Cancel a queued or running run; a running one has its instance killed. */
export async function cancelTaskRun(
  appId: string,
  runId: string,
): Promise<{ canceled: boolean; status: AppTaskRunStatus }> {
  const run = await db.query.appTaskRuns.findFirst({
    where: { id: runId, appId },
    columns: { status: true },
  });
  if (!run) throw new AppError(`Task run "${runId}" not found.`, 404);
  const canceled = await db
    .update(schema.appTaskRuns)
    .set({ status: 'canceled', error: 'Canceled', finishedAt: new Date() })
    .where(
      and(
        eq(schema.appTaskRuns.id, runId),
        inArray(schema.appTaskRuns.status, ['queued', 'running']),
      ),
    )
    .returning({ id: schema.appTaskRuns.id });
  if (canceled.length === 0) return { canceled: false, status: run.status };
  activeRuns(appId).get(runId)?.abort.abort();
  return { canceled: true, status: 'canceled' };
}

/**
 * At boot: runs left `running` by a previous process have no instance any
 * more, so fail them; queued runs never started and are dispatched again.
 */
export async function recoverTaskRuns(): Promise<void> {
  const stale = await db
    .update(schema.appTaskRuns)
    .set({
      status: 'failed',
      error: 'Task run was interrupted because the platform restarted.',
      finishedAt: new Date(),
    })
    .where(eq(schema.appTaskRuns.status, 'running'))
    .returning({ id: schema.appTaskRuns.id });
  for (const run of stale) {
    await failRunningSteps(run.id, 'Platform restarted');
  }
  const apps = await db
    .selectDistinct({ appId: schema.appTaskRuns.appId })
    .from(schema.appTaskRuns)
    .where(eq(schema.appTaskRuns.status, 'queued'));
  for (const { appId } of apps) dispatch(appId);
}

/* ---------------------------------- views ---------------------------------- */

export type AppTaskRunListItem = {
  id: string;
  taskName: string;
  trigger: AppTaskTrigger;
  cronName: string | null;
  status: AppTaskRunStatus;
  version: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  stepCount: number;
};

export type AppTaskRunDetail = RunDetailView & {
  appId: string;
  taskName: string;
  trigger: AppTaskTrigger;
  cronName: string | null;
  actor: string | null;
  deploymentId: string | null;
  /** Position among queued runs of the App (1 = next), while queued. */
  queuePosition: number | null;
};

type RunRow = typeof schema.appTaskRuns.$inferSelect;

function listItem(row: RunRow, stepCount: number): AppTaskRunListItem {
  return {
    id: row.id,
    taskName: row.taskName,
    trigger: row.trigger,
    cronName: row.cronName,
    status: row.status,
    version: row.version,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: runDurationMs(row.startedAt, row.finishedAt),
    stepCount,
  };
}

async function stepCounts(runIds: string[]): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({
      runId: schema.appTaskRunSteps.runId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.appTaskRunSteps)
    .where(inArray(schema.appTaskRunSteps.runId, runIds))
    .groupBy(schema.appTaskRunSteps.runId);
  return new Map(rows.map((row) => [row.runId, row.count]));
}

export type ListTaskRunsOptions = {
  taskName?: string;
  status?: AppTaskRunStatus;
  limit?: number;
  /** Id of the last run of the previous page. */
  cursor?: string;
};

/** An App's runs, newest first, one page at a time. */
export async function listTaskRuns(
  appId: string,
  options: ListTaskRunsOptions = {},
): Promise<{ runs: AppTaskRunListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const runs = schema.appTaskRuns;
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.appId, appId),
        options.taskName ? eq(runs.taskName, options.taskName) : undefined,
        options.status ? eq(runs.status, options.status) : undefined,
        options.cursor ? lt(runs.id, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(runs.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const counts = await stepCounts(page.map((row) => row.id));
  return {
    runs: page.map((row) => listItem(row, counts.get(row.id) ?? 0)),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** One run with its steps, scoped to the App. */
export async function getTaskRun(
  appId: string,
  runId: string,
): Promise<AppTaskRunDetail | null> {
  const row = await db.query.appTaskRuns.findFirst({
    where: { id: runId, appId },
  });
  if (!row) return null;
  const steps = await db.query.appTaskRunSteps.findMany({
    where: { runId },
    orderBy: { seq: 'asc', attempt: 'asc' },
  });
  let queuePosition: number | null = null;
  if (row.status === 'queued') {
    const [{ ahead }] = await db
      .select({ ahead: sql<number>`count(*)::int` })
      .from(schema.appTaskRuns)
      .where(
        and(
          eq(schema.appTaskRuns.appId, appId),
          eq(schema.appTaskRuns.status, 'queued'),
          lt(schema.appTaskRuns.createdAt, row.createdAt),
        ),
      );
    queuePosition = ahead + 1;
  }
  return {
    ...listItem(row, steps.length),
    appId: row.appId,
    actor: row.actor,
    deploymentId: row.deploymentId,
    input: row.input,
    output: row.output,
    log: row.log,
    queuePosition,
    steps: steps.map((step) => ({
      seq: step.seq,
      name: step.name,
      status: step.status,
      attempt: step.attempt,
      output: step.output,
      error: step.error,
      startedAt: step.startedAt?.toISOString() ?? null,
      finishedAt: step.finishedAt?.toISOString() ?? null,
      durationMs: runDurationMs(step.startedAt, step.finishedAt),
    })),
  };
}

export type AppTaskCronView = {
  name: string;
  schedule: string;
  input: JsonValue;
  nextRun: string | null;
};

export type AppTaskView = {
  name: string;
  method: string;
  title: string | null;
  description: string | null;
  concurrency: number | null;
  inputType: string;
  inputSchema: JsonValue;
  cron: AppTaskCronView[];
  webhook: {
    enabled: boolean;
    /** Path on the platform; append `?secret=` from `secret` to call it. */
    url: string | null;
  };
  queued: number;
  running: number;
  latestRun: {
    id: string;
    status: AppTaskRunStatus;
    createdAt: string;
  } | null;
};

export type AppTasksView = {
  appId: string;
  /** Runs allowed at once across the App's tasks. */
  concurrency: number;
  queued: number;
  running: number;
  /** Shared secret for task webhooks; null when no task enables them. */
  webhookSecret: string | null;
  tasks: AppTaskView[];
};

function nextRunOf(schedule: string): string | null {
  try {
    return nextRun(parseCron(schedule))?.toISOString() ?? null;
  } catch {
    return null;
  }
}

/**
 * The tasks of an App's active deployment with their triggers and current
 * load. Null when the App declares no tasks (or cannot run them now).
 */
export async function listAppTasks(
  appId: string,
): Promise<AppTasksView | null> {
  let context: TaskContext;
  try {
    context = await activeTaskContext(appId);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) throw error;
    return null;
  }
  const counts = await db
    .select({
      taskName: schema.appTaskRuns.taskName,
      status: schema.appTaskRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.appTaskRuns)
    .where(
      and(
        eq(schema.appTaskRuns.appId, appId),
        inArray(schema.appTaskRuns.status, ['queued', 'running']),
      ),
    )
    .groupBy(schema.appTaskRuns.taskName, schema.appTaskRuns.status);
  const latest = await db
    .selectDistinctOn([schema.appTaskRuns.taskName], {
      id: schema.appTaskRuns.id,
      taskName: schema.appTaskRuns.taskName,
      status: schema.appTaskRuns.status,
      createdAt: schema.appTaskRuns.createdAt,
    })
    .from(schema.appTaskRuns)
    .where(eq(schema.appTaskRuns.appId, appId))
    .orderBy(schema.appTaskRuns.taskName, desc(schema.appTaskRuns.id));
  const count = (taskName: string | null, status: 'queued' | 'running') =>
    counts
      .filter(
        (row) =>
          row.status === status &&
          (taskName === null || row.taskName === taskName),
      )
      .reduce((sum, row) => sum + row.count, 0);
  const anyWebhook = context.tasks.definitions.some((task) => task.webhook);
  return {
    appId,
    concurrency: context.tasks.concurrency,
    queued: count(null, 'queued'),
    running: count(null, 'running'),
    webhookSecret: anyWebhook ? context.webhookSecret : null,
    tasks: context.tasks.definitions.map((task) => {
      const last = latest.find((row) => row.taskName === task.name);
      return {
        name: task.name,
        method: task.method,
        title: task.title ?? null,
        description: task.description ?? null,
        concurrency: task.concurrency ?? null,
        inputType: task.inputType,
        inputSchema: task.inputSchema,
        cron: task.cron.map((job) => ({
          name: job.name,
          schedule: job.schedule,
          input: job.input,
          nextRun: nextRunOf(job.schedule),
        })),
        webhook: {
          enabled: task.webhook,
          url: task.webhook ? taskRunUrl(appId, task.name) : null,
        },
        queued: count(task.name, 'queued'),
        running: count(task.name, 'running'),
        latestRun: last
          ? {
              id: last.id,
              status: last.status,
              createdAt: last.createdAt.toISOString(),
            }
          : null,
      };
    }),
  };
}

/** Cron schedules of every App that can run tasks now, for the scheduler. */
export async function loadTaskCronJobs(): Promise<
  {
    ownerId: string;
    jobs: { task: string; name: string; schedule: string; input: JsonValue }[];
  }[]
> {
  const apps = await db.query.apps.findMany({
    where: { status: 'deployed' },
    columns: { id: true, capabilities: true, currentDeploymentId: true },
  });
  const taskApps = apps.filter(
    (app) => app.capabilities?.tasks && app.currentDeploymentId,
  );
  if (taskApps.length === 0) return [];
  const deployments = await db.query.deployments.findMany({
    where: {
      id: { in: taskApps.map((app) => app.currentDeploymentId as string) },
    },
    columns: { id: true, manifestNormalized: true, compatibilityVersion: true },
  });
  const byId = new Map(
    deployments
      .filter((d) => appCompatibility(d.compatibilityVersion).isSupported)
      .map((d) => [d.id, d.manifestNormalized as NormalizedManifest | null]),
  );
  return taskApps.map((app) => ({
    ownerId: app.id,
    jobs: (
      byId.get(app.currentDeploymentId as string)?.tasks?.definitions ?? []
    ).flatMap((task) =>
      task.cron.map((job) => ({
        task: task.name,
        name: job.name,
        schedule: job.schedule,
        input: job.input,
      })),
    ),
  }));
}

export type AppTaskRunGlobalItem = AppTaskRunListItem & {
  appId: string;
  appSlug: string;
  appName: string;
};

/** Recent task runs across every App, newest first (global run history). */
export async function listRecentTaskRuns(
  limit = 100,
): Promise<AppTaskRunGlobalItem[]> {
  const rows = await db.query.appTaskRuns.findMany({
    orderBy: { id: 'desc' },
    limit,
  });
  if (rows.length === 0) return [];
  const counts = await stepCounts(rows.map((row) => row.id));
  const apps = await db.query.apps.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.appId))] } },
    columns: { id: true, slug: true, name: true },
  });
  const byId = new Map(apps.map((app) => [app.id, app]));
  return rows.map((row) => ({
    ...listItem(row, counts.get(row.id) ?? 0),
    appId: row.appId,
    appSlug: byId.get(row.appId)?.slug ?? row.appId,
    appName: byId.get(row.appId)?.name ?? row.appId,
  }));
}
