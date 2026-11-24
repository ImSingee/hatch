import { useQueryClient } from '@tanstack/react-query';
import {
  usePlatformEvent,
  usePlatformResync,
} from '~components/system/platform-events';
import { NOTIFICATIONS_KEY } from '~queries/notifications';
import { forgetNotification } from './use-delete-notification';

/**
 * Keep the notification timeline, history and detail views current: refetch on new,
 * edited, recalled and deleted notifications and delivery updates, and after
 * the event stream reconnects.
 */
export function useLiveNotifications() {
  const queryClient = useQueryClient();
  const refreshHistory = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: [...NOTIFICATIONS_KEY, 'history'],
      }),
      queryClient.invalidateQueries({
        queryKey: [...NOTIFICATIONS_KEY, 'timeline'],
      }),
    ]);
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
    // An open detail page leaves on its own; its copy goes once it has.
    forgetNotification(queryClient, event.notificationId);
  });
  usePlatformEvent('notification.delivery.updated', (event) => {
    void refreshHistory();
    void refreshDetail(event.notificationId);
  });
  usePlatformResync(() => {
    void refreshHistory();
    void queryClient.invalidateQueries({
      queryKey: [...NOTIFICATIONS_KEY, 'detail'],
    });
  });
}
