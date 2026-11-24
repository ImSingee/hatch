/** Server-only: AppService task RPC messages from the task domain views. */
import { fromJson, type JsonObject, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type {
  AppTaskRunDetail,
  AppTaskRunListItem,
  AppTasksView,
} from '~server/apps/tasks/service';

const value = (v: unknown) => fromJson(ValueSchema, (v ?? null) as JsonValue);
// google.protobuf.Struct fields are plain JSON objects in generated messages.
const struct = (v: unknown) => (v ?? {}) as JsonObject;

export function tasksMessage(appId: string, view: AppTasksView | null) {
  if (!view) {
    return {
      appId,
      available: false,
      concurrency: 0,
      queued: 0,
      running: 0,
      tasks: [],
    };
  }
  return {
    appId: view.appId,
    available: true,
    concurrency: view.concurrency,
    queued: view.queued,
    running: view.running,
    tasks: view.tasks.map((task) => ({
      name: task.name,
      method: task.method,
      title: task.title ?? undefined,
      description: task.description ?? undefined,
      concurrency: task.concurrency ?? undefined,
      inputType: task.inputType,
      inputSchema: struct(task.inputSchema),
      cron: task.cron.map((job) => ({
        name: job.name,
        schedule: job.schedule,
        input: value(job.input),
        nextRun: job.nextRun ?? undefined,
      })),
      webhook: task.webhook.enabled,
      webhookPath: task.webhook.url ?? undefined,
      queued: task.queued,
      running: task.running,
      latestRun: task.latestRun ?? undefined,
    })),
  };
}

export function runSummaryMessage(run: AppTaskRunListItem) {
  return {
    id: run.id,
    task: run.taskName,
    trigger: run.trigger,
    cronName: run.cronName ?? undefined,
    status: run.status,
    version: run.version ?? undefined,
    error: run.error ?? undefined,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? undefined,
    finishedAt: run.finishedAt ?? undefined,
    durationMs:
      run.durationMs == null ? undefined : BigInt(Math.max(0, run.durationMs)),
    stepCount: run.stepCount,
  };
}

export function runMessage(run: AppTaskRunDetail) {
  return {
    summary: runSummaryMessage({ ...run, stepCount: run.steps.length }),
    actor: run.actor ?? undefined,
    deploymentId: run.deploymentId ?? undefined,
    input: run.input == null ? undefined : value(run.input),
    output: run.output == null ? undefined : value(run.output),
    log: run.log ?? undefined,
    queuePosition: run.queuePosition ?? undefined,
    steps: run.steps.map((step) => ({
      seq: step.seq,
      name: step.name,
      status: step.status,
      attempt: step.attempt,
      output: step.output == null ? undefined : value(step.output),
      error: step.error ?? undefined,
      startedAt: step.startedAt ?? undefined,
      finishedAt: step.finishedAt ?? undefined,
      durationMs:
        step.durationMs == null
          ? undefined
          : BigInt(Math.max(0, step.durationMs)),
    })),
  };
}
