import { Button } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createFileRoute,
  useParams,
} from '@tanstack/react-router';
import { IconMessages, IconSettings } from '@tabler/icons-react';
import { DeskWindow } from '~components/desk/window';
import { NotificationHistory } from '~components/notifications/history-list';
import classes from '~components/notifications/notifications-window.module.css';
import { NotificationsTile } from '~components/notifications/notifications-tile';
import { InsideWindowProvider } from '~components/page/window-context';
import { useI18n } from '~/i18n';
import {
  notificationDetailQueryOptions,
  notificationHistoryQueryOptions,
  notificationSourcesQueryOptions,
} from '~queries/notifications';

export const Route = createFileRoute('/_app/notifications/log')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.prefetchInfiniteQuery(
        notificationHistoryQueryOptions({}),
      ),
      context.queryClient.prefetchQuery(notificationSourcesQueryOptions),
    ]);
  },
  component: DeliveryLogLayout,
});

/**
 * The delivery log: every notification on the left with filters, and the
 * open one on the right with where it was delivered and its answer. Each
 * notification keeps its own URL.
 */
function DeliveryLogLayout() {
  const { t } = useI18n();
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
      title={t('notifications.timeline.deliveryLog')}
      documentTitle={
        (notificationId && openTitle) || t('notifications.timeline.deliveryLog')
      }
      tile={<NotificationsTile />}
      toolbar={
        <>
          <Button
            component={Link}
            to="/notifications"
            variant="light"
            color="gray"
            size="compact-sm"
            leftSection={<IconMessages size={14} stroke={1.8} />}
          >
            {t('notifications.timeline.timeline')}
          </Button>
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
        </>
      }
      closeTo={
        notificationId
          ? {
              link: { to: '/notifications/log' },
              label: t('notifications.timeline.deliveryLog'),
            }
          : {
              link: { to: '/notifications' },
              label: t('nav.notifications'),
            }
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
