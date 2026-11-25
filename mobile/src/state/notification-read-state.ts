import { useQuery } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { pushSupported } from '../core/push-native';
import { useSession } from './session';

/** Under `[origin, 'notifications']`, so a received push refreshes it too. */
export const readStateKey = (origin: string | null) =>
  [origin, 'notifications', 'read-state'] as const;

/** How far this user has read the timeline, shared with the web. */
export function useNotificationReadState() {
  const { api, origin } = useSession();
  return useQuery({
    queryKey: readStateKey(origin),
    queryFn: ({ signal }) => api!.notificationReadState(signal),
    enabled: Boolean(api),
  });
}

/**
 * Keep the app icon's badge at the unread count: refreshed when the app comes
 * back and whenever a push or this app moves the read position.
 */
export function useUnreadBadge() {
  const readState = useNotificationReadState();
  const { refetch } = readState;
  const unread = readState.data?.unreadCount;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);
  useEffect(() => {
    if (!pushSupported || unread === undefined) return;
    void Notifications.setBadgeCountAsync(unread).catch(() => {});
  }, [unread]);
}
