import { useQueryClient } from '@tanstack/react-query';
import {
  usePlatformEvent,
  usePlatformResync,
} from '~components/system/platform-events';
import { dashboardsQueryOptions } from '~queries/dashboards';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { workflowsQueryOptions } from '~queries/workflows';

/**
 * Keep the dock and the dashboard switcher current when pins change somewhere
 * else (another browser, the CLI, the Agent): refetch on `pins.updated` and
 * after the event stream reconnects.
 */
export function useLivePins() {
  const queryClient = useQueryClient();
  const refresh = () => {
    for (const { queryKey } of [
      sidebarItemsQueryOptions,
      workflowsQueryOptions,
      dashboardsQueryOptions,
    ])
      void queryClient.invalidateQueries({ queryKey, exact: true });
  };
  usePlatformEvent('pins.updated', refresh);
  usePlatformResync(refresh);
}

/** Mounts `useLivePins` inside the platform events provider. */
export function LivePins() {
  useLivePins();
  return null;
}
