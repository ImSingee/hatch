/** Server-only: execute a workflow run and stream its step events into the db. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import { workflowDeploymentArtifactDir } from '~agent/paths';
import { db, schema } from '~/db';
import type {
  JsonValue,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
  WorkflowTrigger,
} from '~/db/schema';
import {
  assertSupportedWorkflowCompatibility,
  WorkflowDeploymentCompatibilityError,
} from './compatibility';
import {
  workflowExtraPermissionsFromManifest,
  workflowNetworkPolicyFromManifest,
} from './manifest';
import { buildWorkflowDenoArgs } from './runtime-permissions';
import { workflowSandboxEnv } from './sandbox-env';
import { validateSchemaInput } from '../json-schema-input';
import {
  MAX_RUN_STEP_EVENTS,
  RunEventStream,
  type StepEndEvent,
  type StepStartEvent,
} from '../run-events';

const RUN_TIMEOUT_MS = 5 * 60 * 1000;

type RuntimeGlobal = typeof globalThis & {
  __hatchWorkflowRuns__?: Map<string, ChildProcess>;
};

function runRegistry(): Map<string, ChildProcess> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchWorkflowRuns__ ??= new Map<string, ChildProcess>();
  return g.__hatchWorkflowRuns__;
}

export type StartRunOptions = {
  trigger: WorkflowTrigger;
  input?: unknown;
};

export type StartRunResult = {
  runId: string;
  status: WorkflowRunStatus;
};

/**
 * Validate input, record a run row, and kick off execution. Returns as soon as
 * the run is queued; the UI polls the run for progress. A validation failure is
 * recorded as a failed run (no process is spawned).
 */
export async function startWorkflowRun(
  id: string,
  options: StartRunOptions,
): Promise<StartRunResult> {
  const workflow = await db.query.workflows.findFirst({
    where: { id },
  });
  if (!workflow) throw new Error(`Workflow "${id}" not found.`);
  if (workflow.status !== 'deployed' || !workflow.currentDeploymentId) {
    throw new Error(`Workflow "${id}" is not deployed yet.`);
  }

  const deployment = await db.query.workflowDeployments.findFirst({
    where: { id: workflow.currentDeploymentId as string },
  });
  if (!deployment) {
    throw new WorkflowDeploymentCompatibilityError(
      'The active Workflow deployment record is unavailable.',
    );
  }
  assertSupportedWorkflowCompatibility(deployment.compatibilityVersion);
  const version = deployment.version;

  const validation = validateSchemaInput(
    workflow.inputSchema,
    options.input ?? {},
  );

  const runId = ulid().toLowerCase();
  await db.insert(schema.workflowRuns).values({
    id: runId,
    workflowId: id,
    deploymentId: workflow.currentDeploymentId,
    version,
    trigger: options.trigger,
    status: 'queued',
    input: validation.success
      ? (validation.data as JsonValue)
      : ((options.input ?? {}) as JsonValue),
  });

  if (!validation.success) {
    await db
      .update(schema.workflowRuns)
      .set({
        status: 'failed',
        error: `Input validation failed: ${validation.message}`,
        finishedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.id, runId));
    return { runId, status: 'failed' };
  }

  void executeRun(
    runId,
    id,
    workflow.currentDeploymentId,
    validation.data,
  ).catch(async (err) => {
    await db
      .update(schema.workflowRuns)
      .set({
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.id, runId))
      .catch(() => {});
  });

  return { runId, status: 'queued' };
}

async function upsertStepStart(
  runId: string,
  e: StepStartEvent,
): Promise<void> {
  const startedAt = e.startedAt ? new Date(e.startedAt) : new Date();
  await db
    .insert(schema.workflowRunSteps)
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
        schema.workflowRunSteps.runId,
        schema.workflowRunSteps.seq,
        schema.workflowRunSteps.attempt,
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
  // Each attempt is its own row, so a `retrying` attempt is itself terminal
  // (it failed; the next attempt arrives as a separate row). Recording it as
  // `failed` preserves that attempt's error and timing in the inspector.
  const status: WorkflowRunStepStatus =
    e.status === 'succeeded' ? 'succeeded' : 'failed';
  const finishedAt = e.finishedAt ? new Date(e.finishedAt) : new Date();
  await db
    .insert(schema.workflowRunSteps)
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
        schema.workflowRunSteps.runId,
        schema.workflowRunSteps.seq,
        schema.workflowRunSteps.attempt,
      ],
      set: {
        status,
        output: (e.output ?? null) as JsonValue,
        error: e.error ?? null,
        finishedAt,
      },
    });
}

/**
 * Mark any steps still "running" as failed. Called when a run ends without the
 * child emitting terminal step events (timeout/kill/crash) so the audit
 * timeline doesn't leave steps stuck in-flight forever.
 */
async function failRunningSteps(runId: string, error: string): Promise<void> {
  await db
    .update(schema.workflowRunSteps)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(
      and(
        eq(schema.workflowRunSteps.runId, runId),
        eq(schema.workflowRunSteps.status, 'running'),
      ),
    );
}

async function executeRun(
  runId: string,
  workflowId: string,
  deploymentId: string,
  input: unknown,
): Promise<void> {
  const deployment = await db.query.workflowDeployments.findFirst({
    where: { id: deploymentId, workflowId },
    columns: { manifestNormalized: true },
  });
  if (!deployment) {
    await db
      .update(schema.workflowRuns)
      .set({
        status: 'failed',
        error: 'The workflow deployment record is unavailable.',
        finishedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.id, runId));
    return;
  }

  let network;
  let extraPermissions;
  try {
    network = workflowNetworkPolicyFromManifest(deployment.manifestNormalized);
    extraPermissions = workflowExtraPermissionsFromManifest(
      deployment.manifestNormalized,
    );
  } catch (error) {
    await db
      .update(schema.workflowRuns)
      .set({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.id, runId));
    return;
  }

  // Run the exact immutable artifact this run was queued against, so a
  // concurrent deploy/rollback can never swap in a different version than the
  // run row and its validated input claim.
  const dir = workflowDeploymentArtifactDir(workflowId, deploymentId);
  const bundle = path.join(dir, 'workflow.js');
  if (!existsSync(bundle)) {
    await db
      .update(schema.workflowRuns)
      .set({
        status: 'failed',
        error: 'No built workflow bundle. Deploy the workflow first.',
        finishedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.id, runId));
    return;
  }

  // Atomically claim the run only while it's still `queued`. A concurrent
  // cancel (cancelWorkflowRun) or workflow delete can flip/remove this row
  // before we start; without the status guard we'd resurrect a canceled run or
  // run against a deleted workflow and spawn a Deno child with no registered
  // handle to cancel. Zero rows updated means we must not spawn.
  const claimed = await db
    .update(schema.workflowRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(
      and(
        eq(schema.workflowRuns.id, runId),
        eq(schema.workflowRuns.status, 'queued'),
      ),
    )
    .returning({ id: schema.workflowRuns.id });
  if (claimed.length === 0) return;

  const child = spawn(
    'deno',
    // Default reads are scoped to this artifact; declared extraPermissions may
    // intentionally extend host access. The main module load is exempt from
    // --allow-read, and input arrives over stdin.
    buildWorkflowDenoArgs({
      bundlePath: bundle,
      artifactDir: dir,
      network,
      extraPermissions,
    }),
    {
      cwd: dir,
      // Never inherit the platform's process.env: with --allow-env the workflow
      // could otherwise read host secrets (DATABASE_URL, auth keys, ...). Only
      // system essentials + the Hatch run vars the SDK needs are exposed.
      env: workflowSandboxEnv({ HATCH_MODE: 'run', HATCH_RUN_ID: runId }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  runRegistry().set(runId, child);

  const killChild = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
  };
  const stream = new RunEventStream({
    onEvent: (event) =>
      event.t === 'step:start'
        ? upsertStepStart(runId, event)
        : event.t === 'step:end'
          ? upsertStepEnd(runId, event)
          : Promise.resolve(),
    onOverflow: killChild,
  });
  child.stdout.on('data', (d) => stream.stdout(d));
  child.stderr.on('data', (d) => stream.stderr(d));

  child.stdin.end(`${JSON.stringify(input ?? {})}\n`);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killChild();
  }, RUN_TIMEOUT_MS);

  await new Promise<void>((resolve) => {
    child.on('error', (err) => {
      stream.appendLog(`\nspawn error: ${err.message}`);
      resolve();
    });
    child.on('close', () => resolve());
  });
  clearTimeout(timeout);
  runRegistry().delete(runId);
  await stream.finish();
  const log = stream.text;

  // A concurrent cancel may have already marked the run; respect it.
  const current = await db.query.workflowRuns.findFirst({
    where: { id: runId },
  });
  if (current?.status === 'canceled') {
    await failRunningSteps(runId, 'Canceled');
    await db
      .update(schema.workflowRuns)
      .set({ log, finishedAt: current.finishedAt ?? new Date() })
      .where(eq(schema.workflowRuns.id, runId));
    return;
  }

  // A step-overflow kill may race the child's own run:end; the overflow
  // verdict wins so the failure cause is reported, not a bogus success.
  const runEnd = stream.runEnd;
  const succeeded = runEnd?.status === 'succeeded';
  const finalStatus: WorkflowRunStatus = succeeded ? 'succeeded' : 'failed';
  const error = succeeded
    ? null
    : (runEnd?.error ??
      (stream.overflow === 'steps'
        ? `Workflow exceeded ${MAX_RUN_STEP_EVENTS} step events`
        : stream.overflow === 'line'
          ? 'Workflow produced too much output on a single line'
          : timedOut
            ? 'Run timed out'
            : 'Workflow exited before completing (see log).'));
  if (!succeeded) {
    await failRunningSteps(runId, error ?? 'Run failed');
  }
  // Only transition a still-`running` row to its terminal state. A cancel that
  // lands between the read above and here marks the row `canceled` and kills the
  // child; without this predicate the unconditional update would clobber that
  // back to succeeded/failed. If the conditional update matched nothing, persist
  // just the log so the cancel's terminal status stays authoritative.
  const finalized = await db
    .update(schema.workflowRuns)
    .set({
      status: finalStatus,
      output: (runEnd?.output ?? null) as JsonValue,
      error,
      log,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(schema.workflowRuns.id, runId),
        eq(schema.workflowRuns.status, 'running'),
      ),
    )
    .returning({ id: schema.workflowRuns.id });
  if (finalized.length === 0) {
    await db
      .update(schema.workflowRuns)
      .set({ log })
      .where(eq(schema.workflowRuns.id, runId));
  }
}

/**
 * Fail any runs left `queued`/`running` by a previous process. The child
 * registry lives in memory, so after a server restart these rows have no
 * backing Deno process: left alone they spin in the UI forever and can't be
 * canceled. Called once at boot (mirrors interruptStaleAgentRuns).
 */
export async function interruptStaleWorkflowRuns(): Promise<void> {
  const runs = await db.query.workflowRuns.findMany({
    where: { status: { in: ['queued', 'running'] } },
    columns: { id: true },
  });
  for (const run of runs) {
    await failRunningSteps(run.id, 'Server restarted');
    await db
      .update(schema.workflowRuns)
      .set({
        status: 'failed',
        error: 'Workflow run was interrupted because the server restarted.',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workflowRuns.id, run.id),
          inArray(schema.workflowRuns.status, ['queued', 'running']),
        ),
      );
  }
}

/**
 * Kill any in-flight Deno processes for a workflow. Used before deleting a
 * workflow so an active run cannot keep producing side effects (and become an
 * unkillable orphan) once its rows are gone.
 */
export async function killActiveWorkflowRuns(
  workflowId: string,
): Promise<void> {
  const runs = await db.query.workflowRuns.findMany({
    where: { workflowId, status: { in: ['queued', 'running'] } },
    columns: { id: true },
  });
  const registry = runRegistry();
  for (const run of runs) {
    const child = registry.get(run.id);
    if (!child) continue;
    try {
      child.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    registry.delete(run.id);
  }
}

/** Cancel a queued/running run: mark it canceled and kill its process. */
export async function cancelWorkflowRun(
  runId: string,
): Promise<{ canceled: boolean }> {
  const run = await db.query.workflowRuns.findFirst({
    where: { id: runId },
  });
  if (!run) throw new Error('Run not found.');
  if (run.status !== 'running' && run.status !== 'queued') {
    return { canceled: false };
  }
  // The status check above is a read; the run may finish before this update. Gate
  // the UPDATE on the row still being queued/running (and use the affected rows)
  // so a completed succeeded/failed run is never overwritten as canceled.
  const canceled = await db
    .update(schema.workflowRuns)
    .set({ status: 'canceled', error: 'Canceled', finishedAt: new Date() })
    .where(
      and(
        eq(schema.workflowRuns.id, runId),
        inArray(schema.workflowRuns.status, ['queued', 'running']),
      ),
    )
    .returning({ id: schema.workflowRuns.id });
  if (canceled.length === 0) {
    return { canceled: false };
  }
  const child = runRegistry().get(runId);
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
  }
  return { canceled: true };
}
