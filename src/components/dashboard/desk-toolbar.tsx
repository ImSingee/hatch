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
import { useI18n } from '~i18n';
import { dashboardsQueryOptions } from '~queries/dashboards';
import {
  createDashboard,
  deleteDashboard,
  renameDashboard,
  setDashboardDescription,
  type Dashboard,
} from '~server/dashboards';
import { formatIntervalLabel } from './refresh-presets';
import classes from './desk-toolbar.module.css';

/** "Refreshes every 10s", or that automatic refresh is off. */
export function useRefreshText(): (seconds: number) => string {
  const { t, locale } = useI18n();
  return (seconds) =>
    seconds > 0
      ? t('dashboard.refresh.every', {
          interval: formatIntervalLabel(seconds, locale),
        })
      : t('dashboard.refresh.off');
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
  const { t } = useI18n();
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
      toast.success(t('dashboard.toast.created'));
    },
  });

  return (
    <Menu position="bottom-start" shadow="md" width={260}>
      <Menu.Target>
        <UnstyledButton
          className={classes.switcher}
          aria-label={t('dashboard.switcher.label', {
            name: current?.name ?? t('dashboard.fallbackName'),
          })}
        >
          <span className={classes.switcherName}>
            {current?.name ?? t('dashboard.fallbackName')}
          </span>
          <IconChevronDown size={14} stroke={2.4} aria-hidden />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('dashboard.switcher.heading')}</Menu.Label>
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
              title: t('dashboard.new'),
              label: t('common.name'),
              initialValue: '',
              onSubmit: (name) => create.mutateAsync(name),
            })
          }
        >
          {t('dashboard.new')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          {t('dashboard.manage')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The row over the widgets: which dashboard is showing and how often it
 * refreshes, Edit widgets, the dashboard menu and New app. Below 768 Edit
 * widgets lives only in the dashboard menu.
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
  const { t } = useI18n();
  const refreshText = useRefreshText();
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
          data-toolbar-edit
        >
          {t('dashboard.toolbar.editWidgets')}
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
          {t('dashboard.toolbar.newApp')}
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
  const { t } = useI18n();
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
      toast.success(t('dashboard.toast.renamed'));
    },
  });
  const saveDescription = useMutation({
    mutationFn: (description: string) =>
      setDashboardDescription({ data: { id: dashboard.id, description } }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('dashboard.toast.descriptionUpdated'));
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
      toast.success(t('dashboard.toast.deleted'));
    },
  });

  return (
    <Menu position="bottom-end" shadow="md" width={210}>
      <Menu.Target>
        <ActionIcon
          variant="default"
          size="input-sm"
          aria-label={t('dashboard.menu.options')}
        >
          <IconDots size={18} stroke={1.8} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconRefresh size={15} stroke={1.8} />}
          onClick={onRefresh}
        >
          {t('dashboard.menu.refreshAll')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconPencil size={15} stroke={1.8} />}
          onClick={onEdit}
        >
          {t('dashboard.toolbar.editWidgets')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconPencil size={15} stroke={1.8} />}
          onClick={() =>
            openTextPromptModal({
              title: t('dashboard.rename.title'),
              label: t('common.name'),
              initialValue: dashboard.name,
              onSubmit: (name) => rename.mutateAsync(name),
            })
          }
        >
          {t('common.rename')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileText size={15} stroke={1.8} />}
          onClick={() =>
            openTextPromptModal({
              title: t('dashboard.description.title'),
              label: t('dashboard.description.label'),
              placeholder: t('dashboard.description.placeholder'),
              initialValue: dashboard.description ?? '',
              multiline: true,
              allowEmpty: true,
              onSubmit: (description) =>
                saveDescription.mutateAsync(description),
            })
          }
        >
          {t('dashboard.description.title')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={15} stroke={1.8} />}
          disabled={dashboards.length <= 1}
          onClick={() =>
            modals.openConfirmModal({
              title: t('dashboard.delete.title'),
              centered: true,
              children: (
                <Text size="sm">
                  {t('dashboard.delete.deskBody', { name: dashboard.name })}
                </Text>
              ),
              labels: {
                confirm: t('common.delete'),
                cancel: t('common.cancel'),
              },
              confirmProps: { color: 'red' },
              onConfirm: () => remove.mutate(),
            })
          }
        >
          {t('common.delete')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
