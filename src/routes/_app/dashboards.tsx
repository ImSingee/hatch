import { ActionIcon, Button, Switch, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  IconArrowRight,
  IconGripVertical,
  IconLayoutDashboard,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { SortableList, sortByIds } from '~components/desk/sortable-list';
import { DeskWindow } from '~components/desk/window';
import {
  GroupCard,
  Item,
  LeadTile,
  PageHeading,
  WindowBody,
} from '~components/page/page';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { useI18n } from '~i18n';
import { dashboardsQueryOptions } from '~queries/dashboards';
import {
  createDashboard,
  type Dashboard,
  deleteDashboard,
  renameDashboard,
  reorderDashboards,
  setDashboardPin,
} from '~server/dashboards';
import classes from './dashboards.module.css';

export const Route = createFileRoute('/_app/dashboards')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(dashboardsQueryOptions),
  component: DashboardsManagePage,
});

function DashboardsManagePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: dashboards } = useQuery(dashboardsQueryOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
    });

  const create = useMutation({
    // A new dashboard is named in the language of whoever creates it.
    mutationFn: () =>
      createDashboard({ data: { name: t('dashboards.defaultName') } }),
    onSuccess: (d) => {
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        (old) => (old ? [...old, d] : [d]),
      );
      void invalidate();
      toast.success(t('dashboard.toast.created'));
    },
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      renameDashboard({ data: input }),
    onSuccess: () => {
      void invalidate();
      toast.success(t('dashboard.toast.renamed'));
    },
  });

  const openRename = (d: Dashboard) =>
    openTextPromptModal({
      title: t('dashboard.rename.title'),
      label: t('common.name'),
      initialValue: d.name,
      onSubmit: (name) => rename.mutateAsync({ id: d.id, name }),
    });

  const setPin = useMutation({
    mutationKey: ['dashboard-pin'],
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setDashboardPin({ data: input }),
    // Flip the switch immediately; roll back if the server rejects it (the
    // global mutation error toast reports the failure).
    onMutate: async ({ id, pinned }) => {
      await queryClient.cancelQueries({
        queryKey: dashboardsQueryOptions.queryKey,
      });
      const previous = queryClient.getQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
      );
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        (old) => old?.map((d) => (d.id === id ? { ...d, pinned } : d)),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          dashboardsQueryOptions.queryKey,
          context.previous,
        );
      }
    },
    // Only refetch once the LAST in-flight pin toggle settles: an earlier
    // toggle's refetch would otherwise overwrite a newer optimistic flip.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: ['dashboard-pin'] }) === 1) {
        void invalidate();
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDashboard({ data: id }),
    onSuccess: () => {
      void invalidate();
      toast.success(t('dashboard.toast.deleted'));
    },
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderDashboards({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        (old) => sortByIds(old, orderedIds),
      );
    },
    // The server names the stale dashboard by id, which means nothing here.
    meta: { errorToast: false },
    onError: () => {
      toast.error(t('dashboards.reorderConflict'));
    },
    onSettled: () => void invalidate(),
  });

  const list = dashboards ?? [];

  const confirmDelete = (d: Dashboard) =>
    modals.openConfirmModal({
      title: t('dashboard.delete.title'),
      children: (
        <Text size="sm">{t('dashboards.deleteBody', { name: d.name })}</Text>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(d.id),
    });

  return (
    <DeskWindow title={t('dashboards.title')} maxWidth={880}>
      <WindowBody size={760}>
        <PageHeading
          description={t('dashboards.description')}
          actions={
            <Button
              leftSection={<IconPlus size={16} stroke={1.8} />}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('dashboard.new')}
            </Button>
          }
        />
        <GroupCard>
          <div className={classes.list}>
            <SortableList
              items={list}
              onReorder={(ids) => reorder.mutate(ids)}
              renderItem={(d) => (
                <Item
                  wrap
                  lead={
                    <>
                      <IconGripVertical
                        size={18}
                        stroke={1.6}
                        className={classes.grip}
                        aria-hidden
                      />
                      <LeadTile>
                        <IconLayoutDashboard size={18} stroke={1.6} />
                      </LeadTile>
                    </>
                  }
                  title={d.name}
                  trailing={
                    <>
                      <Tooltip
                        label={
                          d.pinned
                            ? t('dashboards.pinned')
                            : t('dashboards.notPinned')
                        }
                        withArrow
                      >
                        <Switch
                          size="sm"
                          checked={d.pinned}
                          onChange={(e) =>
                            setPin.mutate({
                              id: d.id,
                              pinned: e.currentTarget.checked,
                            })
                          }
                          aria-label={t('dashboards.pin')}
                        />
                      </Tooltip>
                      <Tooltip label={t('common.rename')} withArrow>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          onClick={() => openRename(d)}
                          aria-label={t('dashboard.rename.title')}
                        >
                          <IconPencil size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('common.delete')} withArrow>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          disabled={list.length <= 1}
                          onClick={() => confirmDelete(d)}
                          aria-label={t('dashboard.delete.title')}
                        >
                          <IconTrash size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                      <Button
                        variant="light"
                        size="xs"
                        rightSection={<IconArrowRight size={15} stroke={1.8} />}
                        onClick={() =>
                          navigate({
                            to: '/dashboard/$dashboardId',
                            params: { dashboardId: d.id },
                          })
                        }
                      >
                        {t('common.open')}
                      </Button>
                    </>
                  }
                />
              )}
            />
          </div>
        </GroupCard>
      </WindowBody>
    </DeskWindow>
  );
}
