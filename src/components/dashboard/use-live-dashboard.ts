import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  usePlatformEvent,
  usePlatformResync,
} from '~components/system/platform-events';
import {
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';

/**
 * Keep an open desk current when its dashboard changes somewhere else
 * (another browser, the CLI, the Agent): refetch on `dashboards.updated` and
 * after the event stream reconnects. While the layout editor is open only the
 * dashboard list refreshes and the dashboard's own change is held until
 * editing ends; the draft is checked against the latest revision when saved.
 */
export function useLiveDashboard(dashboardId: string, editing: boolean) {
  const queryClient = useQueryClient();
  // A change that arrives while the editor is open is held back, then read
  // once editing ends, so Cancel or an unchanged Done shows it.
  const deferred = useRef(false);
  const refetchDashboard = () =>
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryOptions(dashboardId).queryKey,
      exact: true,
    });
  const refresh = (changed?: string) => {
    void queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
      exact: true,
    });
    if (changed !== undefined && changed !== dashboardId) return;
    if (editing) deferred.current = true;
    else refetchDashboard();
  };
  useEffect(() => {
    if (editing || !deferred.current) return;
    deferred.current = false;
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryOptions(dashboardId).queryKey,
      exact: true,
    });
  }, [editing, dashboardId, queryClient]);
  usePlatformEvent('dashboards.updated', (event) => refresh(event.dashboardId));
  usePlatformResync(() => refresh());
}
