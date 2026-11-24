import { createFileRoute } from '@tanstack/react-router';
import { IconBell } from '@tabler/icons-react';
import { EmptyState, WindowBody } from '~components/page/page';

export const Route = createFileRoute('/_app/notifications/log/')({
  component: NoNotificationOpen,
});

/** The right half before a notification is picked. */
function NoNotificationOpen() {
  return (
    <WindowBody tone="sheet">
      <EmptyState
        icon={<IconBell size={26} stroke={1.6} />}
        title="Pick a notification"
      >
        See what it said, where it was delivered, and any reply.
      </EmptyState>
    </WindowBody>
  );
}
