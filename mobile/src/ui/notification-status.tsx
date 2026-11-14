import { Tag } from './primitives';

const notificationLabels: Record<string, string> = {
  unrouted: 'Not routed',
  pending: 'Sending',
  delivered: 'Delivered',
  partial: 'Partly failed',
  failed: 'Failed',
};

/** Overall state of a notification across its destinations. */
export function NotificationStatusTag({ status }: { status: string }) {
  const label = notificationLabels[status] ?? status;
  const tone =
    status === 'delivered'
      ? 'lime'
      : status === 'failed' || status === 'partial'
        ? 'danger'
        : status === 'pending'
          ? 'outline'
          : 'quiet';
  return <Tag tone={tone} label={label} />;
}

/** Shown beside the status when the source changed the notification. */
export function NotificationChangeTag({
  editedAt,
  recalledAt,
}: {
  editedAt: string | null;
  recalledAt: string | null;
}) {
  if (recalledAt) return <Tag tone="quiet" label="Recalled" />;
  if (editedAt) return <Tag tone="quiet" label="Edited" />;
  return null;
}

const deliveryLabels: Record<string, string> = {
  pending: 'Waiting',
  in_progress: 'Sending',
  succeeded: 'Delivered',
  failed: 'Failed',
  canceled: 'Not sent',
};

export function DeliveryStatusTag({ status }: { status: string }) {
  return (
    <Tag
      tone={
        status === 'succeeded'
          ? 'lime'
          : status === 'failed'
            ? 'danger'
            : 'outline'
      }
      label={deliveryLabels[status] ?? status}
    />
  );
}

export function notificationTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
