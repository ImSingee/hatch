import { queryOptions } from '@tanstack/react-query';
import { isActiveRun } from '~lib/runs';
import {
  getAppTaskRunFn,
  listAppTaskRunsFn,
  listAppTasksFn,
  listRecentTaskRunsFn,
} from '~server/app-tasks';

/** Fast poll while a run is in flight, a slow idle poll otherwise. */
function pollWhile(active: boolean): number {
  return active ? 1500 : 15_000;
}

export const appTasksQueryOptions = (appId: string) =>
  queryOptions({
    queryKey: ['app-tasks', appId],
    queryFn: () => listAppTasksFn({ data: appId }),
    refetchInterval: (q) =>
      pollWhile(
        Boolean(q.state.data && q.state.data.queued + q.state.data.running > 0),
      ),
  });

export const appTaskRunsQueryOptions = (
  appId: string,
  task?: string,
  limit = 50,
) =>
  queryOptions({
    queryKey: ['app-task-runs', appId, task ?? null, limit],
    queryFn: () => listAppTaskRunsFn({ data: { id: appId, task, limit } }),
    // Background-triggered runs (cron, webhook, backend) appear without a
    // manual refresh; React Query pauses this while the tab is hidden.
    refetchInterval: (q) =>
      pollWhile(
        (q.state.data?.runs ?? []).some((run) => isActiveRun(run.status)),
      ),
  });

export const appTaskRunQueryOptions = (appId: string, runId: string) =>
  queryOptions({
    queryKey: ['app-task-run', appId, runId],
    queryFn: () => getAppTaskRunFn({ data: { id: appId, runId } }),
    refetchInterval: (q) =>
      q.state.data && isActiveRun(q.state.data.status) ? 1200 : false,
  });

export const recentTaskRunsQueryOptions = queryOptions({
  queryKey: ['app-task-runs', 'recent'],
  queryFn: () => listRecentTaskRunsFn(),
});
