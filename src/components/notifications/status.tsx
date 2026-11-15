import { Badge, Loader, Tooltip } from '@mantine/core';
import {
  IconAppWindow,
  IconArrowBackUp,
  IconArrowDown,
  IconArrowUp,
  IconBroadcast,
  IconCheck,
  IconChevronsDown,
  IconClock,
  IconDeviceMobile,
  IconMessageCheck,
  IconMessageQuestion,
  IconMinus,
  IconPencil,
  IconSparkles,
  IconUser,
  IconWebhook,
  IconX,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { NotificationSourceType } from '~/db/schema';
import type { NotificationStatus } from '~server/notifications';

type DeliveryStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'canceled';

const NOTIFICATION_META: Record<
  NotificationStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  unrouted: {
    label: 'Not routed',
    color: 'gray',
    icon: <IconMinus size={11} stroke={2.5} />,
  },
  pending: {
    label: 'Delivering',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  delivered: {
    label: 'Delivered',
    color: 'ember',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  partial: {
    label: 'Partly failed',
    color: 'yellow',
    icon: <IconX size={11} stroke={2.5} />,
  },
  failed: {
    label: 'Failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
};

export const NOTIFICATION_STATUS_OPTIONS = (
  Object.keys(NOTIFICATION_META) as NotificationStatus[]
).map((value) => ({ value, label: NOTIFICATION_META[value].label }));

export function NotificationStatusBadge({
  status,
}: {
  status: NotificationStatus;
}) {
  const meta = NOTIFICATION_META[status];
  return (
    <Badge
      color={meta.color}
      variant="light"
      radius="sm"
      leftSection={<span style={{ display: 'inline-flex' }}>{meta.icon}</span>}
    >
      {meta.label}
    </Badge>
  );
}

const DELIVERY_META: Record<
  DeliveryStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  pending: {
    label: 'Waiting',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  in_progress: {
    label: 'Sending',
    color: 'ember',
    icon: <Loader size={9} color="ember" />,
  },
  succeeded: {
    label: 'Delivered',
    color: 'ember',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  failed: {
    label: 'Failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
  canceled: {
    label: 'Not sent',
    color: 'gray',
    icon: <IconMinus size={11} stroke={2.5} />,
  },
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const meta = DELIVERY_META[status];
  return (
    <Badge
      color={meta.color}
      variant="light"
      radius="sm"
      leftSection={<span style={{ display: 'inline-flex' }}>{meta.icon}</span>}
    >
      {meta.label}
    </Badge>
  );
}

/** Edited and recalled notifications, next to the delivery status. */
export function NotificationRevisionBadge({
  editedAt,
  recalledAt,
}: {
  editedAt: string | null;
  recalledAt: string | null;
}) {
  if (recalledAt) {
    return (
      <Badge
        color="gray"
        variant="outline"
        radius="sm"
        leftSection={
          <span style={{ display: 'inline-flex' }}>
            <IconArrowBackUp size={11} stroke={2.5} />
          </span>
        }
      >
        Recalled
      </Badge>
    );
  }
  if (editedAt) {
    return (
      <Badge
        color="gray"
        variant="outline"
        radius="sm"
        leftSection={
          <span style={{ display: 'inline-flex' }}>
            <IconPencil size={11} stroke={2.5} />
          </span>
        }
      >
        Edited
      </Badge>
    );
  }
  return null;
}

/** Whether a notification with a reply form still waits for its answer. */
export function NotificationReplyBadge({
  hasReply,
  respondedAt,
  recalledAt,
}: {
  hasReply: boolean;
  respondedAt: string | null;
  recalledAt: string | null;
}) {
  if (!hasReply) return null;
  if (respondedAt) {
    return (
      <Badge
        color="ember"
        variant="outline"
        radius="sm"
        leftSection={
          <span style={{ display: 'inline-flex' }}>
            <IconMessageCheck size={11} stroke={2.5} />
          </span>
        }
      >
        Answered
      </Badge>
    );
  }
  if (recalledAt) return null;
  return (
    <Badge
      color="yellow"
      variant="light"
      radius="sm"
      leftSection={
        <span style={{ display: 'inline-flex' }}>
          <IconMessageQuestion size={11} stroke={2.5} />
        </span>
      }
    >
      Awaiting answer
    </Badge>
  );
}

export const REPLY_STATE_OPTIONS = [
  { value: 'awaiting', label: 'Awaiting answer' },
  { value: 'answered', label: 'Answered' },
];

const PRIORITY_META: Record<
  number,
  {
    label: string;
    effect: string | null;
    color: string;
    icon: ReactNode;
    description: string;
  }
> = {
  [-2]: {
    label: 'Lowest',
    effect: 'history only, not pushed to phones',
    color: 'gray',
    icon: <IconChevronsDown size={11} stroke={2.5} />,
    description:
      'Priority -2: kept in history and sent to webhooks and Apps, never pushed to phones.',
  },
  [-1]: {
    label: 'Low',
    effect: 'quiet on phones',
    color: 'gray',
    icon: <IconArrowDown size={11} stroke={2.5} />,
    description:
      'Priority -1: arrives on phones quietly, with no sound and no banner.',
  },
  0: {
    label: 'Normal',
    effect: null,
    color: 'gray',
    icon: null,
    description: 'Priority 0: a regular notification.',
  },
  1: {
    label: 'High',
    effect: 'time-sensitive on phones',
    color: 'ember',
    icon: <IconArrowUp size={11} stroke={2.5} />,
    description:
      'Priority 1: time-sensitive on phones, shown during Focus and Do Not Disturb.',
  },
};

/** For example "High (1) · time-sensitive on phones". */
export function notificationPriorityLabel(priority: number): string {
  const meta = PRIORITY_META[priority];
  if (!meta) return String(priority);
  const label = `${meta.label} (${priority})`;
  return meta.effect ? `${label} · ${meta.effect}` : label;
}

/** Non-normal priorities, next to the delivery status. */
export function NotificationPriorityBadge({ priority }: { priority: number }) {
  const meta = PRIORITY_META[priority];
  if (!meta || priority === 0) return null;
  return (
    <Tooltip label={meta.description} withArrow multiline maw={280}>
      <Badge
        color={meta.color}
        variant="outline"
        radius="sm"
        leftSection={
          <span style={{ display: 'inline-flex' }}>{meta.icon}</span>
        }
      >
        {meta.label}
      </Badge>
    </Tooltip>
  );
}

type DestinationType = 'device' | 'webhook' | 'app';

export const DESTINATION_TYPE_LABEL: Record<DestinationType, string> = {
  device: 'Device',
  webhook: 'Webhook',
  app: 'App',
};

export function DestinationTypeIcon({
  type,
  size = 16,
}: {
  type: DestinationType;
  size?: number;
}) {
  if (type === 'device') return <IconDeviceMobile size={size} stroke={1.6} />;
  if (type === 'webhook') return <IconWebhook size={size} stroke={1.6} />;
  return <IconAppWindow size={size} stroke={1.6} />;
}

export function SourceTypeIcon({
  type,
  size = 16,
}: {
  type: NotificationSourceType;
  size?: number;
}) {
  if (type === 'app') return <IconAppWindow size={size} stroke={1.6} />;
  if (type === 'channel') return <IconBroadcast size={size} stroke={1.6} />;
  if (type === 'user') return <IconUser size={size} stroke={1.6} />;
  return <IconSparkles size={size} stroke={1.6} />;
}
