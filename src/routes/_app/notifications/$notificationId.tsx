import { Button, Center, Loader } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
} from '@tanstack/react-router';
import { IconArrowLeft, IconTrash } from '@tabler/icons-react';
import { Suspense } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { NotificationDetail } from '~components/notifications/notification-detail';
import {
  forgetNotification,
  notificationDeletedToastId,
  useDeleteNotification,
} from '~components/notifications/use-delete-notification';
import { useLiveNotifications } from '~components/notifications/use-live-notifications';
import { usePlatformEvent } from '~components/system/platform-events';
import { notificationDetailQueryOptions } from '~queries/notifications';

export const Route = createFileRoute('/_app/notifications/$notificationId')({
  loader: async ({ context, params }) => {
    try {
      return await context.queryClient.ensureQueryData(
        notificationDetailQueryOptions(params.notificationId),
      );
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw notFound();
      }
      throw error;
    }
  },
  component: NotificationDetailPage,
});

function NotificationDetailPage() {
  const loaded = Route.useLoaderData();
  const { notificationId } = Route.useParams();
  const navigate = useNavigate();
  // The header follows edits; the loader's copy covers the first render.
  const notification =
    useQuery(notificationDetailQueryOptions(notificationId)).data ?? loaded;
  useLiveNotifications();
  const queryClient = useQueryClient();
  const leave = () => navigate({ to: '/notifications', replace: true });
  const { confirmDelete, isPending } = useDeleteNotification({
    onDeleted: leave,
  });
  // Another member (or tab) deleted it while it was open.
  usePlatformEvent('notification.deleted', (event) => {
    if (event.notificationId !== notificationId) return;
    toast.info('This notification was deleted', {
      id: notificationDeletedToastId(notificationId),
    });
    void leave().then(() => forgetNotification(queryClient, notificationId));
  });
  return (
    <Page
      title={notification.title}
      description={`${notification.kindName} from ${notification.sourceName}`}
      size={960}
      actions={
        <>
          <Button
            component={Link}
            to="/notifications"
            variant="default"
            leftSection={<IconArrowLeft size={16} stroke={1.6} />}
          >
            All notifications
          </Button>
          <Button
            variant="default"
            color="red"
            c="red.7"
            leftSection={<IconTrash size={16} stroke={1.6} />}
            loading={isPending}
            onClick={() => confirmDelete(notification)}
          >
            Delete
          </Button>
        </>
      }
    >
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <NotificationDetail id={notificationId} />
      </Suspense>
    </Page>
  );
}
