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
import { randomUUID } from 'node:crypto';
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
  runOverflowError,
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

/** Same bound as a platform call into a backend. */
export const TASK_RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Queued runs one App may hold before new ones are refused. */
export const TASK_QUEUE_LIMIT = 100;
/** Largest task input, as JSON text, any trigger accepts. */
export const MAX_TASK_INPUT_BYTES = 1_000_000;
/** Largest rejected input stored on its failed run. */
const MAX_REJECTED_INPUT_BYTES = 64 * 1024;

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: 1 (App deploys), 2 (retired), 3
// (apps/kv.ts), 4 (pins.ts), 5 (dashboard-service.ts), 6 (apps/provision.ts),
// 7 (platform-config.ts).
const APP_TASK_QUEUE_LOCK_NS = 8;

/**
 * Backoff for retrying a dispatch pass that failed (e.g. the database was
 * down): doubling from the base, capped, and never giving up, since nothing
 * else may wake an App whose queue holds accepted runs.
 */
const DISPATCH_RETRY_BASE_MS = 1000;
const DISPATCH_RETRY_MAX_MS = 60_000;
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
      {
        code: 'tasks.queueFull',
        params: { task: taskName, limit: TASK_QUEUE_LIMIT },
      },
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
    throw new AppError('The App is archived; restore it to run tasks.', 409, {
      code: 'tasks.appArchived',
    });
  }
  if (!app.currentDeploymentId) {
    throw new AppError('The App has no active deployment.', 409, {
      code: 'tasks.notDeployed',
    });
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
    throw new AppError('The App declares no tasks.', 409, {
      code: 'tasks.noTasks',
    });
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
    throw new AppError(`Task "${taskName}" is not declared by the App.`, 404, {
      code: 'tasks.taskNotDeclared',
      params: { task: taskName },
    });
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
  const validation = validateSchemaInput(task.inputSchema, rawInput);
  const base = {
    id: ulid().toLowerCase(),
    appId,
    taskName,
    trigger: options.trigger,
    cronName: options.cronName ?? null,
    actor: options.actor ?? null,
  };
  if (!validation.success) {
    // Rejected input is kept for diagnosis, but a large one only as its size:
    // failed runs are not bounded by the queue limit.
    const bytes = Buffer.byteLength(JSON.stringify(rawInput));
    await db.insert(schema.appTaskRuns).values({
      ...base,
      status: 'failed',
      input:
        bytes > MAX_REJECTED_INPUT_BYTES
          ? { truncated: true, bytes }
          : (rawInput as JsonValue),
      error: `Input validation failed: ${validation.message}`,
      finishedAt: new Date(),
    });
    return { runId: base.id, status: 'failed' };
  }
  // Count and insert under a per-App lock so concurrent triggers cannot both
  // take the last queue slot.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${APP_TASK_QUEUE_LOCK_NS}, hashtext(${appId}))`,
    );
    const [{ queued }] = await tx
      .select({ queued: sql<number>`count(*)::int` })
      .from(schema.appTaskRuns)
      .where(
        and(
          eq(schema.appTaskRuns.appId, appId),
          eq(schema.appTaskRuns.status, 'queued'),
        ),
      );
    if (queued >= TASK_QUEUE_LIMIT) throw new TaskQueueFullError(taskName);
    // The caller's input, as sent: defaults come from the deployment that
    // executes the run and are applied when it starts.
    await tx.insert(schema.appTaskRuns).values({
      ...base,
      status: 'queued',
      input: rawInput as JsonValue,
    });
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
  __hatchTaskDispatch__?: Map<string, DispatchState>;
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

type DispatchState = {
  running: boolean;
  again: boolean;
  /** Consecutive failed passes; drives the retry backoff. */
  failures: number;
  retry: NodeJS.Timeout | null;
};

function dispatchState(appId: string): DispatchState {
  const g = globalThis as TaskGlobal;
  g.__hatchTaskDispatch__ ??= new Map();
  let state = g.__hatchTaskDispatch__.get(appId);
  if (!state) {
    state = { running: false, again: false, failures: 0, retry: null };
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
        try {
          await dispatchPass(appId);
          state.failures = 0;
        } catch (error) {
          console.error(
            `[tasks] dispatch for App "${appId}" failed:`,
            error instanceof Error ? error.message : error,
          );
          // Nothing else may wake this App (no run is active to finish), so
          // try again with backoff instead of leaving accepted runs queued.
          if (!state.retry) {
            const delay = Math.min(
              DISPATCH_RETRY_BASE_MS * 2 ** Math.min(state.failures, 16),
              DISPATCH_RETRY_MAX_MS,
            );
            state.failures += 1;
            state.retry = setTimeout(() => {
              state.retry = null;
              dispatch(appId);
            }, delay);
            state.retry.unref();
          }
        }
      } while (state.again);
    } finally {
      state.running = false;
    }
  })();
}

async function failQueuedRuns(runIds: string[], error: string): Promise<void> {
  await db
    .update(schema.appTaskRuns)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(
      and(
        inArray(schema.appTaskRuns.id, runIds),
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
    // Infrastructure errors leave the queue alone; the pass is retried.
    if (!(error instanceof AppError)) throw error;
    // The App can no longer run tasks (archived, tasks removed, unsupported
    // deployment): the runs seen here will never start, so say why now.
    await failQueuedRuns(
      queued.map((run) => run.id),
      error.message,
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
    // Input was validated against the deployment active when the run was
    // queued. The run executes on `context`'s deployment, whose definition
    // may have added required fields, defaults or constraints since.
    const validation = validateSchemaInput(task.inputSchema, run.input ?? {});
    if (!validation.success) {
      await db
        .update(schema.appTaskRuns)
        .set({
          status: 'failed',
          error: `Input validation failed for version ${context.version}: ${validation.message}`,
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
    // Register before claiming: a cancel that commits once the claim has
    // committed always finds this entry and aborts it, even while the claim
    // response is still on its way back.
    const active: ActiveRun = {
      taskName: task.name,
      abort: new AbortController(),
      handle: null,
    };
    running.set(run.id, active);
    const claimed = await db
      .update(schema.appTaskRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(
        and(
          eq(schema.appTaskRuns.id, run.id),
          eq(schema.appTaskRuns.status, 'queued'),
        ),
      )
      .returning({ id: schema.appTaskRuns.id })
      .catch((error: unknown) => {
        running.delete(run.id);
        throw error;
      });
    if (claimed.length === 0 || active.abort.signal.aborted) {
      // Not ours, or canceled between the claim and now: nothing started.
      running.delete(run.id);
      continue;
    }
    void executeRun(
      context,
      task,
      run.id,
      validation.data as JsonValue,
      run.trigger,
      active,
    )
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

function parseOutput(body: string, truncated: boolean): JsonValue | null {
  if (truncated) {
    return {
      truncated: true,
      limitBytes: MAX_TASK_OUTPUT_BYTES,
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
      deploymentId: context.deploymentId,
      maxResponseBytes: MAX_TASK_OUTPUT_BYTES,
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
          )
          .catch((error: unknown) => {
            // Version metadata only; the run itself goes on.
            console.error(
              `[tasks] recording the deployment of run ${runId} failed:`,
              error instanceof Error ? error.message : error,
            );
          });
      },
      signal: active.abort.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  // Steps arrive on stdout and the result over HTTP; the instance has exited
  // and closed stdout, so persist every step before the terminal status.
  await recorded;
  try {
    await stream.finish();
  } catch (error) {
    // A step write failed: fail the run but keep what it logged.
    await finalizeRun(runId, {
      status: 'failed',
      output: null,
      error: `Recording the run's steps failed: ${error instanceof Error ? error.message : String(error)}`,
      log: stream.text || null,
    });
    return;
  }
  const log = stream.text || null;

  if (result.superseded) {
    // A deploy activated another deployment before the request was sent:
    // nothing ran, so queue the run again (keeping its place) to validate
    // and execute it against the new deployment. A cancel still wins.
    await db
      .update(schema.appTaskRuns)
      .set({
        status: 'queued',
        startedAt: null,
        deploymentId: null,
        version: null,
      })
      .where(
        and(
          eq(schema.appTaskRuns.id, runId),
          eq(schema.appTaskRuns.status, 'running'),
        ),
      );
    return;
  }
  const response = result.response;
  if (stream.overflow) {
    await finalizeRun(runId, {
      status: 'failed',
      output: null,
      error: runOverflowError(stream.overflow, 'Task'),
      log,
    });
    return;
  }
  if (response && response.status >= 200 && response.status < 300) {
    await finalizeRun(runId, {
      status: 'succeeded',
      output: parseOutput(response.body, response.truncated),
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
  if (canceled.length === 0) {
    // The run ended between the read and the update: report how it ended.
    const current = await db.query.appTaskRuns.findFirst({
      where: { id: runId, appId },
      columns: { status: true },
    });
    if (!current) throw new AppError(`Task run "${runId}" not found.`, 404);
    return { canceled: false, status: current.status };
  }
  activeRuns(appId).get(runId)?.abort.abort();
  return { canceled: true, status: 'canceled' };
}

/**
 * At boot: runs left `running` by a previous process have no instance any
 * more, so fail them; queued runs never started and are dispatched again.
 */
export async function recoverTaskRuns(): Promise<void> {
  // One transaction: a failed attempt leaves every interrupted run (and its
  // steps) `running`, so the next boot finds and recovers them again.
  await db.transaction(async (tx) => {
    const stale = await tx
      .update(schema.appTaskRuns)
      .set({
        status: 'failed',
        error: 'Task run was interrupted because the platform restarted.',
        finishedAt: new Date(),
      })
      .where(eq(schema.appTaskRuns.status, 'running'))
      .returning({ id: schema.appTaskRuns.id });
    if (stale.length === 0) return;
    await tx
      .update(schema.appTaskRunSteps)
      .set({
        status: 'failed',
        error: 'Platform restarted',
        finishedAt: new Date(),
      })
      .where(
        and(
          inArray(
            schema.appTaskRunSteps.runId,
            stale.map((run) => run.id),
          ),
          eq(schema.appTaskRunSteps.status, 'running'),
        ),
      );
  });
  const apps = await db
    .selectDistinct({ appId: schema.appTaskRuns.appId })
    .from(schema.appTaskRuns)
    .where(eq(schema.appTaskRuns.status, 'queued'));
  for (const { appId } of apps) dispatch(appId);
}

/* ----------------------------- webhook secret ------------------------------ */

/**
 * Mint a new shared webhook secret for an App (the App webhook and task
 * webhooks accept it) and return it; the previous secret stops working.
 */
export async function rotateAppWebhookSecret(appId: string): Promise<string> {
  const app = await db.query.apps.findFirst({
    where: { id: appId },
    columns: { status: true, capabilities: true, currentDeploymentId: true },
  });
  if (!app) throw new AppError(`App "${appId}" not found.`, 404);
  if (app.status === 'archived') {
    throw new AppError('The App is archived; restore it first.', 409);
  }
  let taskWebhook = false;
  if (app.currentDeploymentId) {
    const deployment = await db.query.deployments.findFirst({
      where: { id: app.currentDeploymentId },
      columns: { manifestNormalized: true },
    });
    const manifest =
      deployment?.manifestNormalized as NormalizedManifest | null;
    taskWebhook = Boolean(
      manifest?.tasks?.definitions.some((task) => task.webhook),
    );
  }
  if (!app.capabilities?.webhook && !taskWebhook) {
    throw new AppError(
      'The App has no webhook trigger: enable the App webhook or a task webhook first.',
      409,
    );
  }
  const secret = randomUUID().replaceAll('-', '');
  await db
    .update(schema.apps)
    .set({ webhookSecret: secret })
    .where(eq(schema.apps.id, appId));
  return secret;
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

/** The columns a run list needs; never the (large) input, output or log. */
// A function, not a module constant: importing this module must not touch
// the schema (tests mock `~/db` without it).
const summaryColumns = () => ({
  id: schema.appTaskRuns.id,
  appId: schema.appTaskRuns.appId,
  taskName: schema.appTaskRuns.taskName,
  trigger: schema.appTaskRuns.trigger,
  cronName: schema.appTaskRuns.cronName,
  status: schema.appTaskRuns.status,
  version: schema.appTaskRuns.version,
  error: schema.appTaskRuns.error,
  createdAt: schema.appTaskRuns.createdAt,
  startedAt: schema.appTaskRuns.startedAt,
  finishedAt: schema.appTaskRuns.finishedAt,
});

type RunRow = Pick<
  typeof schema.appTaskRuns.$inferSelect,
  keyof ReturnType<typeof summaryColumns>
>;

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
    .select(summaryColumns())
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
          // Dispatch order, compared in SQL at the database's precision.
          sql`(${schema.appTaskRuns.createdAt}, ${schema.appTaskRuns.id}) < (select r.created_at, r.id from ${schema.appTaskRuns} r where r.id = ${runId})`,
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
  const rows = await db
    .select(summaryColumns())
    .from(schema.appTaskRuns)
    .orderBy(desc(schema.appTaskRuns.id))
    .limit(limit);
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
