import { ActionIcon, Button, Menu, Text, UnstyledButton } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  IconCheck,
  IconChevronDown,
  IconDots,
  IconFileText,
  IconLayoutDashboard,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { dashboardsQueryOptions } from '~queries/dashboards';
import {
  createDashboard,
  deleteDashboard,
  renameDashboard,
  setDashboardDescription,
  type Dashboard,
} from '~server/dashboards';
import { formatInterval } from './refresh-presets';
import classes from './desk-toolbar.module.css';

/** "Refreshes every 10s", or that automatic refresh is off. */
export function refreshText(seconds: number): string {
  return seconds > 0
    ? `Refreshes every ${formatInterval(seconds)}`
    : 'Auto refresh off';
}

/**
 * The dashboard on the desk as a menu: every dashboard, a new one, and the
 * way into managing them. The canvas draws one dashboard, so this is the
 * desk's own control for having several.
 */
export function DashboardSwitcher({
  current,
}: {
  current: Pick<Dashboard, 'id' | 'name'> | undefined;
}) {
  const { data: dashboards } = useQuery(dashboardsQueryOptions);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (name: string) => createDashboard({ data: { name } }),
    onSuccess: async (dashboard) => {
      await queryClient.invalidateQueries({
        queryKey: dashboardsQueryOptions.queryKey,
      });
      await navigate({
        to: '/dashboard/$dashboardId',
        params: { dashboardId: dashboard.id },
      });
      toast.success('Dashboard created');
    },
  });

  return (
    <Menu position="bottom-start" shadow="md" width={260}>
      <Menu.Target>
        <UnstyledButton
          className={classes.switcher}
          aria-label={`${current?.name ?? 'Dashboard'}, switch dashboard`}
        >
          <span className={classes.switcherName}>
            {current?.name ?? 'Dashboard'}
          </span>
          <IconChevronDown size={14} stroke={2.4} aria-hidden />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Dashboards</Menu.Label>
        {(dashboards ?? []).map((dashboard) => (
          <Menu.Item
            key={dashboard.id}
            rightSection={
              dashboard.id === current?.id ? (
                <IconCheck size={15} stroke={2} aria-hidden />
              ) : null
            }
            aria-current={dashboard.id === current?.id ? 'page' : undefined}
            renderRoot={(props) => (
              <Link
                to="/dashboard/$dashboardId"
                params={{ dashboardId: dashboard.id }}
                {...props}
              />
            )}
          >
            {dashboard.name}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconPlus size={16} stroke={1.8} />}
          onClick={() =>
            openTextPromptModal({
              title: 'New dashboard',
              label: 'Name',
              initialValue: '',
              onSubmit: (name) => create.mutateAsync(name),
            })
          }
        >
          New dashboard
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          Manage dashboards
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The row over the widgets: which dashboard is showing and how often it
 * refreshes, Edit widgets, the dashboard menu and New app.
 */
export function DeskToolbar({
  dashboard,
  onEdit,
  onRefresh,
}: {
  dashboard: Dashboard;
  onEdit: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className={classes.toolbar}>
      <div className={classes.meta}>
        <IconRefresh size={14} stroke={2.2} aria-hidden />
        <DashboardSwitcher current={dashboard} />
        <span aria-hidden>·</span>
        <span>{refreshText(dashboard.autoRefreshSeconds)}</span>
      </div>
      <div className={classes.actions}>
        <Button
          type="button"
          variant="default"
          leftSection={<IconPencil size={15} stroke={1.9} />}
          onClick={onEdit}
        >
          Edit widgets
        </Button>
        <DashboardMenu
          dashboard={dashboard}
          onEdit={onEdit}
          onRefresh={onRefresh}
        />
        <Button
          component={Link}
          to="/agent"
          leftSection={<IconPlus size={15} stroke={2.2} />}
          data-toolbar-new-app
        >
          New app
        </Button>
      </div>
    </div>
  );
}

function DashboardMenu({
  dashboard,
  onEdit,
  onRefresh,
}: {
  dashboard: Dashboard;
  onEdit: () => void;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: dashboards = [] } = useQuery(dashboardsQueryOptions);
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
    });

  const rename = useMutation({
    mutationFn: (name: string) =>
      renameDashboard({ data: { id: dashboard.id, name } }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Dashboard renamed');
    },
  });
  const saveDescription = useMutation({
    mutationFn: (description: string) =>
      setDashboardDescription({ data: { id: dashboard.id, description } }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Description updated');
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDashboard({ data: dashboard.id }),
    onSuccess: async () => {
      const next = dashboards.find((item) => item.id !== dashboard.id);
      if (next)
        await navigate({
          to: '/dashboard/$dashboardId',
          params: { dashboardId: next.id },
        });
      await invalidate();
      toast.success('Dashboard deleted');
    },
  });

  return (
    <Menu position="bottom-end" shadow="md" width={210}>
      <Menu.Target>
        <ActionIcon
          variant="default"
          size="input-sm"
          aria-label="Dashboard options"
        >
          <IconDots size={18} stroke={1.8} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconRefresh size={15} stroke={1.8} />}
          onClick={onRefresh}
        >
          Refresh all widgets
        </Menu.Item>
        <Menu.Item
          leftSection={<IconPencil size={15} stroke={1.8} />}
          onClick={onEdit}
        >
          Edit widgets
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconPencil size={15} stroke={1.8} />}
          onClick={() =>
            openTextPromptModal({
              title: 'Rename dashboard',
              label: 'Name',
              initialValue: dashboard.name,
              onSubmit: (name) => rename.mutateAsync(name),
            })
          }
        >
          Rename
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileText size={15} stroke={1.8} />}
          onClick={() =>
            openTextPromptModal({
              title: 'Edit description',
              label: 'Description',
              placeholder: 'What this dashboard is for',
              initialValue: dashboard.description ?? '',
              multiline: true,
              allowEmpty: true,
              onSubmit: (description) =>
                saveDescription.mutateAsync(description),
            })
          }
        >
          Edit description
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={15} stroke={1.8} />}
          disabled={dashboards.length <= 1}
          onClick={() =>
            modals.openConfirmModal({
              title: 'Delete dashboard',
              centered: true,
              children: (
                <Text size="sm">
                  Delete “{dashboard.name}”? Its widget layout is removed; the
                  Apps and their widgets stay.
                </Text>
              ),
              labels: { confirm: 'Delete', cancel: 'Cancel' },
              confirmProps: { color: 'red' },
              onConfirm: () => remove.mutate(),
            })
          }
        >
          Delete
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
