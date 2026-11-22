import { Button, Menu } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconLayoutGridAdd } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { lastDashboardId } from '~components/desk/last-dashboard';
import { dashboardWidgetKey } from '~/lib/dashboard-widget';
import {
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';
import { addDashboardWidget, type AvailableWidget } from '~server/dashboards';

/**
 * "Pin to desk": place the App's widget on the current dashboard (the one
 * this browser showed last, else the first). The dock is pinned separately.
 * An App with several widgets offers a choice; widgets already on that
 * dashboard are not added again.
 */
export function usePinToDesk(appId: string): {
  control: ReactNode;
  /** Why the control is disabled, to show under the actions. */
  reason: string | null;
} {
  const queryClient = useQueryClient();
  const dashboards = useQuery(dashboardsQueryOptions);
  const available = useQuery(availableWidgetsQueryOptions);
  const remembered = lastDashboardId();
  const target =
    dashboards.data?.find((item) => item.id === remembered) ??
    dashboards.data?.[0];
  const placed = useQuery({
    ...dashboardQueryOptions(target?.id ?? ''),
    enabled: Boolean(target),
  });

  const add = useMutation({
    mutationFn: (widget: AvailableWidget) =>
      addDashboardWidget({
        data: {
          dashboardId: target!.id,
          appId: widget.appId,
          widgetId: widget.widgetId,
        },
      }),
    onSuccess: (_result, widget) => {
      toast.success(`${widget.name} is on ${target!.name}`);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'widgets'] }),
  });

  const widgets = (available.data ?? []).filter(
    (widget) => widget.appId === appId,
  );
  const onDesk = new Set(
    (placed.data?.widgets ?? []).map((item) => dashboardWidgetKey(item)),
  );
  const missing = widgets.filter(
    (widget) => !onDesk.has(dashboardWidgetKey(widget)),
  );
  const ready = Boolean(target && available.data && placed.data);

  const reason = !ready
    ? null
    : widgets.length === 0
      ? 'This App has no widget to put on the desk.'
      : missing.length === 0
        ? `Already on ${target!.name}.`
        : null;

  const button = (
    <Button
      variant="default"
      leftSection={<IconLayoutGridAdd size={16} stroke={1.8} />}
      disabled={!ready || missing.length === 0}
      loading={add.isPending}
      onClick={missing.length === 1 ? () => add.mutate(missing[0]) : undefined}
    >
      Pin to desk
    </Button>
  );

  // The menu names the target dashboard, so it waits for every query; until
  // then the plain button stands in, disabled.
  const control =
    ready && target && missing.length > 1 ? (
      <Menu position="bottom-end" width={240} shadow="md">
        <Menu.Target>{button}</Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Add to {target.name}</Menu.Label>
          {missing.map((widget) => (
            <Menu.Item key={widget.widgetId} onClick={() => add.mutate(widget)}>
              {widget.name}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    ) : (
      button
    );
  return { control, reason };
}
