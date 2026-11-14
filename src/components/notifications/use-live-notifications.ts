import { useQueryClient } from '@tanstack/react-query';
import {
  usePlatformEvent,
  usePlatformResync,
} from '~components/system/platform-events';
import { NOTIFICATIONS_KEY } from '~queries/notifications';

/**
 * Keep notification history and detail views current: refetch on new,
 * edited, recalled and deleted notifications and delivery updates, and after
 * the event stream reconnects.
 */
export function useLiveNotifications() {
  const queryClient = useQueryClient();
  const refreshHistory = () =>
    queryClient.invalidateQueries({
      queryKey: [...NOTIFICATIONS_KEY, 'history'],
    });
  const refreshDetail = (id: string) =>
    queryClient.invalidateQueries({
      queryKey: [...NOTIFICATIONS_KEY, 'detail', id],
    });

  usePlatformEvent('notification.created', () => {
    void refreshHistory();
  });
  usePlatformEvent('notification.updated', (event) => {
    void refreshHistory();
    void refreshDetail(event.notificationId);
  });
  usePlatformEvent('notification.deleted', (event) => {
    void refreshHistory();
    // An open detail page leaves on its own; only drop cached copies.
    queryClient.removeQueries({
      queryKey: [...NOTIFICATIONS_KEY, 'detail', event.notificationId],
      type: 'inactive',
    });
  });
  usePlatformEvent('notification.delivery.updated', (event) => {
    void refreshHistory();
    void refreshDetail(event.notificationId);
  });
  usePlatformResync(() => {
    void queryClient.invalidateQueries({
      queryKey: [...NOTIFICATIONS_KEY, 'history'],
    });
    void queryClient.invalidateQueries({
      queryKey: [...NOTIFICATIONS_KEY, 'detail'],
    });
  });
}
