import { Button } from '@mantine/core';
import { Link, createFileRoute } from '@tanstack/react-router';
import { IconListDetails } from '@tabler/icons-react';
import { DeskWindow } from '~components/desk/window';
import { NotificationsTile } from '~components/notifications/notifications-tile';
import { NotificationTimeline } from '~components/notifications/timeline/timeline';
import { useI18n } from '~/i18n';
import { notificationTimelineQueryOptions } from '~queries/notifications';

export const Route = createFileRoute('/_app/notifications/')({
  loader: ({ context }) =>
    context.queryClient.prefetchInfiniteQuery(notificationTimelineQueryOptions),
  component: NotificationsTimelinePage,
});

/** The default Notifications window: every notification as one live stream. */
function NotificationsTimelinePage() {
  const { t } = useI18n();
  return (
    <DeskWindow
      fill
      title={t('nav.notifications')}
      tile={<NotificationsTile />}
      toolbar={
        <Button
          component={Link}
          to="/notifications/log"
          variant="light"
          color="gray"
          size="compact-sm"
          leftSection={<IconListDetails size={14} stroke={1.8} />}
        >
          {t('notifications.timeline.deliveryLog')}
        </Button>
      }
    >
      <NotificationTimeline />
    </DeskWindow>
  );
}
