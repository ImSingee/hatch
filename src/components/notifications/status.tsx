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
import { useI18n, type PlainTranslationKey } from '~i18n';
import type { NotificationStatus } from '~server/notifications';

type DeliveryStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'canceled';

const NOTIFICATION_META: Record<
  NotificationStatus,
  { label: PlainTranslationKey; color: string; icon: ReactNode }
> = {
  unrouted: {
    label: 'notifications.status.unrouted',
    color: 'gray',
    icon: <IconMinus size={11} stroke={2.5} />,
  },
  pending: {
    label: 'notifications.status.pending',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  delivered: {
    label: 'notifications.status.delivered',
    color: 'primary',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  partial: {
    label: 'notifications.status.partial',
    color: 'yellow',
    icon: <IconX size={11} stroke={2.5} />,
  },
  failed: {
    label: 'notifications.status.failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
};

/** Status filter options; `label` is translated at render. */
export const NOTIFICATION_STATUS_OPTIONS = (
  Object.keys(NOTIFICATION_META) as NotificationStatus[]
).map((value) => ({ value, label: NOTIFICATION_META[value].label }));

export function NotificationStatusBadge({
  status,
}: {
  status: NotificationStatus;
}) {
  const { t } = useI18n();
  const meta = NOTIFICATION_META[status];
  return (
    <Badge
      color={meta.color}
      variant="light"
      radius="sm"
      leftSection={<span style={{ display: 'inline-flex' }}>{meta.icon}</span>}
    >
      {t(meta.label)}
    </Badge>
  );
}

const DELIVERY_META: Record<
  DeliveryStatus,
  { label: PlainTranslationKey; color: string; icon: ReactNode }
> = {
  pending: {
    label: 'notifications.delivery.pending',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  in_progress: {
    label: 'notifications.delivery.inProgress',
    color: 'primary',
    icon: <Loader size={9} color="primary" />,
  },
  succeeded: {
    label: 'notifications.delivery.succeeded',
    color: 'primary',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  failed: {
    label: 'notifications.delivery.failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
  canceled: {
    label: 'notifications.delivery.canceled',
    color: 'gray',
    icon: <IconMinus size={11} stroke={2.5} />,
  },
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const { t } = useI18n();
  const meta = DELIVERY_META[status];
  return (
    <Badge
      color={meta.color}
      variant="light"
      radius="sm"
      leftSection={<span style={{ display: 'inline-flex' }}>{meta.icon}</span>}
    >
      {t(meta.label)}
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
  const { t } = useI18n();
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
        {t('notifications.badge.recalled')}
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
        {t('notifications.badge.edited')}
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
  const { t } = useI18n();
  if (!hasReply) return null;
  if (respondedAt) {
    return (
      <Badge
        color="primary"
        variant="outline"
        radius="sm"
        leftSection={
          <span style={{ display: 'inline-flex' }}>
            <IconMessageCheck size={11} stroke={2.5} />
          </span>
        }
      >
        {t('notifications.badge.answered')}
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
      {t('notifications.badge.awaiting')}
    </Badge>
  );
}

/** Reply state filter options; `label` is translated at render. */
export const REPLY_STATE_OPTIONS: {
  value: string;
  label: PlainTranslationKey;
}[] = [
  { value: 'awaiting', label: 'notifications.badge.awaiting' },
  { value: 'answered', label: 'notifications.badge.answered' },
];

const PRIORITY_META: Record<
  number,
  {
    label: PlainTranslationKey;
    /** Label with the priority number and its effect on phones. */
    full: PlainTranslationKey;
    color: string;
    icon: ReactNode;
    description: PlainTranslationKey;
  }
> = {
  [-2]: {
    label: 'notifications.priority.lowest',
    full: 'notifications.priority.lowest.full',
    color: 'gray',
    icon: <IconChevronsDown size={11} stroke={2.5} />,
    description: 'notifications.priority.lowest.description',
  },
  [-1]: {
    label: 'notifications.priority.low',
    full: 'notifications.priority.low.full',
    color: 'gray',
    icon: <IconArrowDown size={11} stroke={2.5} />,
    description: 'notifications.priority.low.description',
  },
  0: {
    label: 'notifications.priority.normal',
    full: 'notifications.priority.normal.full',
    color: 'gray',
    icon: null,
    description: 'notifications.priority.normal.description',
  },
  1: {
    label: 'notifications.priority.high',
    full: 'notifications.priority.high.full',
    color: 'primary',
    icon: <IconArrowUp size={11} stroke={2.5} />,
    description: 'notifications.priority.high.description',
  },
};

/**
 * Key for, for example, "High (1) · time-sensitive on phones"; null for a
 * priority without a name, which shows as its number.
 */
export function notificationPriorityLabelKey(
  priority: number,
): PlainTranslationKey | null {
  return PRIORITY_META[priority]?.full ?? null;
}

/** Non-normal priorities, next to the delivery status. */
export function NotificationPriorityBadge({ priority }: { priority: number }) {
  const { t } = useI18n();
  const meta = PRIORITY_META[priority];
  if (!meta || priority === 0) return null;
  return (
    <Tooltip label={t(meta.description)} withArrow multiline maw={280}>
      <Badge
        color={meta.color}
        variant="outline"
        radius="sm"
        leftSection={
          <span style={{ display: 'inline-flex' }}>{meta.icon}</span>
        }
      >
        {t(meta.label)}
      </Badge>
    </Tooltip>
  );
}

type DestinationType = 'device' | 'webhook' | 'app';

/** Destination type names; translated at render. */
export const DESTINATION_TYPE_LABEL: Record<
  DestinationType,
  PlainTranslationKey
> = {
  device: 'notifications.destinationType.device',
  webhook: 'notifications.destinationType.webhook',
  app: 'notifications.destinationType.app',
};

/** Plural destination type names, for option group headings. */
export const DESTINATION_TYPE_PLURAL: Record<
  DestinationType,
  PlainTranslationKey
> = {
  device: 'notifications.destinationType.devices',
  webhook: 'notifications.destinationType.webhooks',
  app: 'notifications.destinationType.apps',
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
