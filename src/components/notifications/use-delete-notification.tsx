import { Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
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
 * Confirm and delete a notification from history. Errors are toasted by the
 * global mutation handler; history refreshes either way. `onDeleted` runs
 * only while the component that asked is still mounted, so a slow response
 * never acts on a page the user has since left.
 */
export function useDeleteNotification(
  options: { onDeleted?: (id: string) => void } = {},
) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => deleteNotificationFn({ data: id }),
    onSuccess: (_result, id) => {
      toast.success('Notification deleted', {
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
      'id' | 'title' | 'recalledAt' | 'deliveries'
    >,
  ) =>
    modals.openConfirmModal({
      title: 'Delete this notification?',
      centered: true,
      children: (
        <Stack gap="xs">
          <Text size="sm" fw={600} lineClamp={2}>
            {notification.title}
          </Text>
          <Text size="sm">
            It is removed from history with its delivery records, for everyone
            in the workspace. This cannot be undone.
          </Text>
          <Text size="sm" c="dimmed">
            {!notification.recalledAt && notification.deliveries.succeeded > 0
              ? 'Nothing is sent: phones, webhooks and Apps keep the copy they already received, and deliveries that have not happened yet are dropped.'
              : 'Nothing is sent, and deliveries that have not happened yet are dropped.'}
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        remove.mutate(notification.id, {
          onSuccess: (_result, id) => options.onDeleted?.(id),
        }),
    });

  return { confirmDelete, isPending: remove.isPending };
}
