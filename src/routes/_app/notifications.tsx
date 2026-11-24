import { Outlet, createFileRoute } from '@tanstack/react-router';
import { useLiveNotifications } from '~components/notifications/use-live-notifications';

export const Route = createFileRoute('/_app/notifications')({
  component: NotificationsLayout,
});

/** The timeline and the delivery log both follow live notification events. */
function NotificationsLayout() {
  useLiveNotifications();
  return <Outlet />;
}
