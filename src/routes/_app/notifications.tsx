import { Button, ThemeIcon } from '@mantine/core';
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
import { useLiveNotifications } from '~components/notifications/use-live-notifications';
import {
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
  useLiveNotifications();
  const { notificationId } = useParams({ strict: false });
  return (
    <DeskWindow
      fill
      title="Notifications"
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
          Delivery settings
        </Button>
      }
      closeTo={
        notificationId
          ? { link: { to: '/notifications' }, label: 'Notifications' }
          : undefined
      }
    >
      <div
        className={classes.split}
        data-open={notificationId ? '' : undefined}
      >
        <aside className={classes.list} aria-label="All notifications">
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
