import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState, Linking } from 'react-native';
import { notificationUrlAction } from '../core/deep-link';
import {
  foregroundPresentation,
  pushChange,
  pushTap,
  verifiedTapUrl,
  type PushTap,
} from '../core/push';
import { linkInbox } from './link-inbox';
import {
  nativePushPlatform,
  pushRegistrar,
  pushSupported,
} from './push-registrar';
import { allowDevelopmentLoopback, useSession } from './session';

// Show new Hatch notifications as banners while the app is open too. A recall
// arriving now removes the notification it recalls (same identifier).
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const { data } = notification.request.content;
    if (pushChange(data) === 'recalled') {
      await Notifications.dismissNotificationAsync(
        notification.request.identifier,
      ).catch(() => {});
    }
    return foregroundPresentation(data);
  },
});

/**
 * Without the filtering entitlement a recall leaves a silent "recalled"
 * placeholder in Notification Center; clear those once the app is open.
 */
async function clearRecalledPlaceholders() {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter((entry) => pushChange(entry.request.content.data) === 'recalled')
      .map((entry) =>
        Notifications.dismissNotificationAsync(entry.request.identifier),
      ),
  );
}

/**
 * Opens the notification itself on the instance that sent it. Only the
 * extension writes this payload after decrypting it with the instance's key,
 * so it may switch to that instance without asking.
 */
function openNotification(target: PushTap) {
  linkInbox.put({
    link: {
      instance: target.origin,
      target: { kind: 'notification', id: target.notificationId },
    },
    trusted: true,
    from: 'system',
  });
}

/**
 * Opens a verified tap URL. A Hatch page (the instance's own address or a
 * `hatch:` deep link) opens in the app, on the instance that sent the push
 * unless the link names another one, which then asks before switching;
 * anything else leaves for the system. Returns false when nothing could open
 * it.
 */
async function openTapUrl(target: PushTap, url: string) {
  const action = notificationUrlAction(url, target.origin, {
    allowDevelopmentLoopback,
  });
  switch (action.open) {
    case 'page':
      linkInbox.put({
        link: action.link,
        trusted: action.link.instance === target.origin,
        from: 'system',
      });
      return true;
    case 'outside':
      try {
        await Linking.openURL(action.url);
        return true;
      } catch {
        return false;
      }
    case 'none':
      return false;
  }
}

/**
 * Keeps the active instance's push registration fresh and hands notification
 * taps to the link inbox, which opens them on the instance that sent them.
 * Mounted once inside the session.
 */
export function usePushLifecycle() {
  const { ready, origin, api } = useSession();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!pushSupported || !origin || !api) return;
    void pushRegistrar.refresh(origin, api).catch(() => {});
    // Register the token this listener received. Requesting a token again
    // here would fire the listener again (Expo warns of an infinite loop).
    const subscription = Notifications.addPushTokenListener((token) => {
      void pushRegistrar
        .refresh(origin, api, String(token.data))
        .catch(() => {});
    });
    return () => subscription.remove();
  }, [origin, api]);

  useEffect(() => {
    if (!pushSupported) return;
    void clearRecalledPlaceholders().catch(() => {});
    const state = AppState.addEventListener('change', (next) => {
      if (next === 'active') void clearRecalledPlaceholders().catch(() => {});
    });
    // New, edited and recalled notifications all change the history list.
    const received = Notifications.addNotificationReceivedListener(
      (notification) => {
        const target = pushTap(notification.request.content.data, {
          allowDevelopmentLoopback,
        });
        if (!target) return;
        void queryClient.invalidateQueries({
          queryKey: [target.origin, 'notifications'],
        });
        void queryClient.invalidateQueries({
          queryKey: [target.origin, 'notification', target.notificationId],
        });
      },
    );
    return () => {
      state.remove();
      received.remove();
    };
  }, [queryClient]);

  useEffect(() => {
    // Wait for the saved instance to be restored before taking a cold-start tap.
    if (!pushSupported || !ready) return;
    const open = async (response: Notifications.NotificationResponse) => {
      const target = pushTap(response.notification.request.content.data, {
        allowDevelopmentLoopback,
      });
      if (!target) return;
      // The sender asked for the link instead of the notification. If it is
      // not verified or nothing can open it, the notification opens and
      // still shows its link.
      const url = await verifiedTapUrl(target, nativePushPlatform);
      if (url && (await openTapUrl(target, url))) return;
      openNotification(target);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      Notifications.clearLastNotificationResponse();
      void open(last);
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        Notifications.clearLastNotificationResponse();
        void open(response);
      },
    );
    return () => subscription.remove();
  }, [ready]);
}
