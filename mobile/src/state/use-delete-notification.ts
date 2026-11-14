import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { Alert } from 'react-native';
import type { NotificationSummary } from '../core';
import { errorText } from '../ui/primitives';
import { dismissPresentedNotification } from './push';
import { useSession } from './session';

type HistoryPage = { items: NotificationSummary[]; nextCursor: string | null };

/**
 * Drop a deleted notification's cached detail so reopening it fetches and
 * shows "not found" instead of the stale copy. A detail screen that is still
 * leaving keeps observing it until it unmounts; removing it before then would
 * only make that screen refetch, so wait for its last observer to go.
 */
function evictWhenUnused(queryClient: QueryClient, queryKey: QueryKey) {
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
 * Ask, then delete a notification from the instance's history. Deleting is
 * workspace-wide and sends nothing, so only this phone's Notification Center
 * copy is removed along with it.
 */
export function useDeleteNotification(
  options: { onDeleted?: (id: string) => void } = {},
) {
  const { api, origin } = useSession();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api!.deleteNotification(id),
    onSuccess: (_result, id) => {
      if (!origin) return;
      // Drop it from the list right away; the refetch below confirms it.
      queryClient.setQueryData<InfiniteData<HistoryPage>>(
        [origin, 'notifications'],
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.filter((item) => item.id !== id),
            })),
          },
      );
      void dismissPresentedNotification(origin, id).catch(() => {});
      options.onDeleted?.(id);
      evictWhenUnused(queryClient, [origin, 'notification', id]);
    },
    onError: (error) =>
      Alert.alert('Couldn’t delete notification', errorText(error)),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: [origin, 'notifications'] }),
  });

  const confirmDelete = (notification: Pick<NotificationSummary, 'id'>) =>
    Alert.alert(
      'Delete this notification?',
      'It is removed from history for everyone on this instance and can’t be restored. Other phones and destinations keep the copy they already received.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => remove.mutate(notification.id),
        },
      ],
    );

  return { confirmDelete, isPending: remove.isPending };
}
