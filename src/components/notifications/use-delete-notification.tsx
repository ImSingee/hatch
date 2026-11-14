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
 * reports it missing instead of showing the stale copy. Call it once no
 * mounted page reads the detail anymore, or that page would refetch it.
 */
export function forgetNotification(queryClient: QueryClient, id: string) {
  queryClient.removeQueries({
    queryKey: [...NOTIFICATIONS_KEY, 'detail', id],
  });
}

/**
 * Confirm and delete a notification from history. Errors are toasted by the
 * global mutation handler; history refreshes either way.
 */
export function useDeleteNotification(
  options: { onDeleted?: (id: string) => Promise<void> | void } = {},
) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => deleteNotificationFn({ data: id }),
    onSuccess: async (_result, id) => {
      toast.success('Notification deleted', {
        id: notificationDeletedToastId(id),
      });
      await options.onDeleted?.(id);
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
          <Text size="sm" fw={500} lineClamp={2}>
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
      onConfirm: () => remove.mutate(notification.id),
    });

  return { confirmDelete, isPending: remove.isPending };
}
