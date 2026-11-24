import { Menu, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconLayoutGridAdd } from '@tabler/icons-react';
import { toast } from 'sonner';
import { lastDashboardId } from '~components/desk/last-dashboard';
import { dashboardWidgetKey } from '~/lib/dashboard-widget';
import {
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';
import { addDashboardWidget, type AvailableWidget } from '~server/dashboards';

const icon = <IconLayoutGridAdd size={15} stroke={1.7} />;

/**
 * "Pin to desk" as menu items: place the App's widget on the current
 * dashboard (the one this browser showed last, else the first). The dock is
 * pinned separately. An App with several widgets offers a choice; widgets
 * already on that dashboard are not added again, and an unavailable item
 * says why.
 */
export function PinToDeskItems({ appId }: { appId: string }) {
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
  // The items name the target dashboard, so they wait for every query.
  const ready = Boolean(target && available.data && placed.data);

  if (!ready || !target || missing.length === 0) {
    const reason = !ready
      ? null
      : widgets.length === 0
        ? 'This App has no widget to put on the desk.'
        : `Already on ${target!.name}.`;
    return (
      <Menu.Item leftSection={icon} disabled>
        Pin to desk
        {reason ? (
          <Text component="span" display="block" size="xs" c="dimmed">
            {reason}
          </Text>
        ) : null}
      </Menu.Item>
    );
  }
  if (missing.length === 1)
    return (
      <Menu.Item
        leftSection={icon}
        disabled={add.isPending}
        onClick={() => add.mutate(missing[0])}
      >
        Pin to desk
      </Menu.Item>
    );
  return (
    <Menu.Sub>
      <Menu.Sub.Target>
        <Menu.Sub.Item leftSection={icon}>Pin to desk</Menu.Sub.Item>
      </Menu.Sub.Target>
      <Menu.Sub.Dropdown miw={200}>
        <Menu.Label>Add to {target.name}</Menu.Label>
        {missing.map((widget) => (
          <Menu.Item
            key={widget.widgetId}
            disabled={add.isPending}
            onClick={() => add.mutate(widget)}
          >
            {widget.name}
          </Menu.Item>
        ))}
      </Menu.Sub.Dropdown>
    </Menu.Sub>
  );
}
