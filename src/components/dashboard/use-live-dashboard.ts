import { useQueryClient } from '@tanstack/react-query';
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
 * dashboard list refreshes; the draft is checked against the latest revision
 * when it is saved.
 */
export function useLiveDashboard(dashboardId: string, editing: boolean) {
  const queryClient = useQueryClient();
  const refresh = (changed?: string) => {
    void queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
      exact: true,
    });
    if (editing || (changed !== undefined && changed !== dashboardId)) return;
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryOptions(dashboardId).queryKey,
      exact: true,
    });
  };
  usePlatformEvent('dashboards.updated', (event) => refresh(event.dashboardId));
  usePlatformResync(() => refresh());
}
