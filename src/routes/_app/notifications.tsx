import { Button, ThemeIcon } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createFileRoute,
  useParams,
} from '@tanstack/react-router';
import { IconBell, IconSettings } from '@tabler/icons-react';
import { DeskWindow } from '~components/desk/window';
import { NotificationHistory } from '~components/notifications/history-list';
import classes from '~components/notifications/notifications-window.module.css';
import { InsideWindowProvider } from '~components/page/window-context';
import { useI18n } from '~i18n';
import { useLiveNotifications } from '~components/notifications/use-live-notifications';
import {
  notificationDetailQueryOptions,
  notificationHistoryQueryOptions,
  notificationSourcesQueryOptions,
} from '~queries/notifications';

export const Route = createFileRoute('/_app/notifications')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.prefetchInfiniteQuery(
        notificationHistoryQueryOptions({}),
      ),
      context.queryClient.prefetchQuery(notificationSourcesQueryOptions),
    ]);
  },
  component: NotificationsLayout,
});

/**
 * The Notifications window: every notification on the left and the open one
 * on the right, like a chat. Each notification keeps its own URL.
 */
function NotificationsLayout() {
  const { t } = useI18n();
  useLiveNotifications();
  const { notificationId } = useParams({ strict: false });
  // The tab names the open notification, from the cache its page reads.
  const { data: openTitle } = useQuery({
    ...notificationDetailQueryOptions(notificationId ?? ''),
    enabled: Boolean(notificationId),
    select: (notification) => notification.title,
  });
  return (
    <DeskWindow
      fill
      title={t('notifications.window.title')}
      documentTitle={
        (notificationId && openTitle) || t('notifications.window.title')
      }
      tile={
        <ThemeIcon size={22} radius="xs" color="amber">
          <IconBell size={13} stroke={2.4} />
        </ThemeIcon>
      }
      toolbar={
        <Button
          component={Link}
          to="/settings/notifications"
          variant="light"
          color="gray"
          size="compact-sm"
          leftSection={<IconSettings size={14} stroke={1.8} />}
        >
          {t('notifications.window.deliverySettings')}
        </Button>
      }
      closeTo={
        notificationId
          ? {
              link: { to: '/notifications' },
              label: t('notifications.window.title'),
            }
          : undefined
      }
    >
      <div
        className={classes.split}
        data-open={notificationId ? '' : undefined}
      >
        <aside
          className={classes.list}
          aria-label={t('notifications.window.allNotifications')}
        >
          <NotificationHistory selected={notificationId} />
        </aside>
        <section className={classes.detail}>
          <InsideWindowProvider value>
            <Outlet />
          </InsideWindowProvider>
        </section>
      </div>
    </DeskWindow>
  );
}
