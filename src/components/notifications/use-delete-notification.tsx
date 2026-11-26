import { Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { notificationHeadline } from '../../../packages/hatch-platform-api/notification-content';
import { useErrorText, useI18n } from '~i18n';
import { NOTIFICATIONS_KEY } from '~queries/notifications';
import {
  deleteNotificationFn,
  type NotificationSummaryView,
} from '~server/notifications';

/**
 * One toast per deleted notification, whether this tab deleted it or another
 * member did (the platform event can arrive before the mutation resolves).
 */
export function notificationDeletedToastId(id: string) {
  return `notification-deleted-${id}`;
}

/**
 * Drop the cached detail of a deleted notification so going back to its page
 * reports it missing instead of showing the stale copy. A detail page that is
 * still open keeps reading it until it leaves; removing it before then would
 * only make that page refetch, so wait for its last observer to go.
 */
export function forgetNotification(queryClient: QueryClient, id: string) {
  const queryKey = [...NOTIFICATIONS_KEY, 'detail', id];
  const cache = queryClient.getQueryCache();
  const query = cache.find({ queryKey, exact: true });
  if (!query) return;
  const evict = () => queryClient.removeQueries({ queryKey, exact: true });
  if (query.getObserversCount() === 0) {
    evict();
    return;
  }
  const unsubscribe = cache.subscribe((event) => {
    if (event.query !== query) return;
    if (event.type === 'removed') unsubscribe();
    else if (
      event.type === 'observerRemoved' &&
      query.getObserversCount() === 0
    ) {
      unsubscribe();
      evict();
    }
  });
}

/**
 * Confirm and delete a notification from history. Errors are toasted here,
 * translated by their stable code; history refreshes either way. `onDeleted` runs
 * only while the component that asked is still mounted, so a slow response
 * never acts on a page the user has since left.
 */
export function useDeleteNotification(
  options: { onDeleted?: (id: string) => void } = {},
) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => deleteNotificationFn({ data: id }),
    meta: { errorToast: false },
    onError: (error) => {
      toast.error(errorText(error, 'notifications.delete.failed'));
    },
    onSuccess: (_result, id) => {
      toast.success(t('notifications.delete.done'), {
        id: notificationDeletedToastId(id),
      });
      forgetNotification(queryClient, id);
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: [...NOTIFICATIONS_KEY, 'history'],
      }),
  });

  const confirmDelete = (
    notification: Pick<
      NotificationSummaryView,
      'id' | 'format' | 'title' | 'summary' | 'recalledAt' | 'deliveries'
    >,
  ) =>
    modals.openConfirmModal({
      title: t('notifications.delete.title'),
      centered: true,
      children: (
        <Stack gap="xs">
          <Text size="sm" fw={600} lineClamp={2}>
            {notificationHeadline(notification)}
          </Text>
          <Text size="sm">{t('notifications.delete.body')}</Text>
          <Text size="sm" c="dimmed">
            {!notification.recalledAt && notification.deliveries.succeeded > 0
              ? t('notifications.delete.delivered')
              : t('notifications.delete.undelivered')}
          </Text>
        </Stack>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        remove.mutate(notification.id, {
          onSuccess: (_result, id) => options.onDeleted?.(id),
        }),
    });

  return { confirmDelete, isPending: remove.isPending };
}
