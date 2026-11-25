import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authClient } from '~auth/client';
import {
  usePlatformEvent,
  usePlatformResync,
} from '~components/system/platform-events';
import { notificationReadStateQueryOptions } from '~queries/notifications';

/**
 * The signed-in user's read position and unread count, kept current by new
 * and edited notifications and by reading on another device or tab.
 */
export function useNotificationReadState() {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const query = useQuery(notificationReadStateQueryOptions);
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: notificationReadStateQueryOptions.queryKey,
    });
  usePlatformEvent('notification.created', refresh);
  usePlatformEvent('notification.updated', refresh);
  usePlatformEvent('notification.deleted', refresh);
  usePlatformEvent('notification.read', (event) => {
    if (session && event.reader === `user:${session.user.id}`) refresh();
  });
  usePlatformResync(refresh);
  return query;
}
