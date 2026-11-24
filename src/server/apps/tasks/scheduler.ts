/** Server-only: start App task runs on their declared cron schedules. */
import { db, schema } from '~/db';
import { createCronScheduler } from '~server/cron-scheduler';
import type { JsonValue } from '~/db/schema';
import { loadTaskCronJobs, startTaskRun } from './service';

type TaskCronJob = {
  task: string;
  name: string;
  schedule: string;
  input: JsonValue;
};

async function log(
  appId: string,
  message: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(schema.logs).values({
      appId,
      source: 'cron',
      level: 'error',
      message,
      data: data as never,
    });
  } catch {
    /* logging is best-effort */
  }
}

const scheduler = createCronScheduler<TaskCronJob>({
  globalKey: '__hatchTaskScheduler__',
  jobKey: (appId, job) => `${appId}::${job.task}::${job.name}`,
  schedule: (job) => job.schedule,
  fire: async (appId, job) => {
    try {
      await startTaskRun(appId, job.task, {
        trigger: 'cron',
        cronName: job.name,
        input: job.input,
      });
    } catch (error) {
      // Nothing was recorded as a run (the App cannot run tasks right now or
      // its queue is full), so leave a trace in the App's log.
      await log(appId, `task "${job.task}" cron "${job.name}" not started`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  onInvalidSchedule: (appId, job, error) => {
    void log(appId, `invalid cron for task "${job.task}" job "${job.name}"`, {
      schedule: job.schedule,
      error: error.message,
    });
  },
  loadJobs: loadTaskCronJobs,
});

/** Start the task scheduler once (idempotent). */
export function ensureTaskScheduler(): void {
  scheduler.ensure();
}

/** Reload every task schedule (after a deploy, rollback, archive or delete). */
export async function reloadTaskScheduler(): Promise<void> {
  await scheduler.reload();
}
