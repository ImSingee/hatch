/** Server functions for App tasks (Tasks pages and the App manage page). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { JsonValue } from '~/db/schema';
import { authMiddleware, requireSession } from './auth';
import { idSchema } from './validation';
import {
  type AppTaskRunDetail,
  type AppTaskRunListItem,
  type AppTasksView,
  cancelTaskRun,
  getTaskRun,
  type AppTaskRunGlobalItem,
  listAppTasks,
  listRecentTaskRuns,
  listTaskRuns,
  startTaskRun,
} from './apps/tasks/service';

export type {
  AppTaskRunGlobalItem,
  AppTaskRunDetail,
  AppTaskRunListItem,
  AppTasksView,
  AppTaskView,
} from './apps/tasks/service';

const taskNameSchema = z.string().min(1).max(64);
const runStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export const listAppTasksFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppTasksView | null> => {
    return listAppTasks(id);
  });

export const runAppTaskFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; task: string; input: JsonValue }) =>
    z
      .object({
        id: idSchema,
        task: taskNameSchema,
        input: z.unknown(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return startTaskRun(data.id, data.task, {
      trigger: 'manual',
      input: data.input,
      actor: session.user.id,
    });
  });

export const listAppTaskRunsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    (input: {
      id: string;
      task?: string;
      status?: AppTaskRunListItem['status'];
      limit?: number;
      cursor?: string;
    }) =>
      z
        .object({
          id: idSchema,
          task: taskNameSchema.optional(),
          status: runStatusSchema.optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: idSchema.optional(),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    return listTaskRuns(data.id, {
      taskName: data.task,
      status: data.status,
      limit: data.limit,
      cursor: data.cursor,
    });
  });

export const getAppTaskRunFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { id: string; runId: string }) =>
    z.object({ id: idSchema, runId: idSchema }).parse(input),
  )
  .handler(async ({ data }): Promise<AppTaskRunDetail | null> => {
    return getTaskRun(data.id, data.runId);
  });

export const cancelAppTaskRunFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; runId: string }) =>
    z.object({ id: idSchema, runId: idSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    return cancelTaskRun(data.id, data.runId);
  });

export const listRecentTaskRunsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<AppTaskRunGlobalItem[]> => {
    return listRecentTaskRuns();
  });
