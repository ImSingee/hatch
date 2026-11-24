import {
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { IconRefresh } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  hatchLinkWebUrl,
  isDocumentUrl,
} from '../../../packages/hatch-platform-api/deep-link';
import { Field } from '~components/system/field';
import { useErrorText, useI18n, type PlainTranslationKey } from '~i18n';
import { formatExact, formatRelativeTime } from '~lib/format';
import {
  NOTIFICATIONS_KEY,
  notificationDetailQueryOptions,
} from '~queries/notifications';
import { retryDeliveryFn, type DeliveryView } from '~server/notifications';
import {
  DESTINATION_TYPE_LABEL,
  DeliveryStatusBadge,
  DestinationTypeIcon,
  NotificationReplyBadge,
  NotificationRevisionBadge,
  NotificationStatusBadge,
  notificationPriorityLabelKey,
} from './status';
import { ReplySection } from './reply-section';

const SOURCE_TYPE_LABEL: Record<
  'app' | 'channel' | 'user',
  PlainTranslationKey
> = {
  app: 'notifications.destinationType.app',
  channel: 'notifications.channels.column.channel',
  user: 'notifications.detail.sourceUser',
};

export function NotificationDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const { data } = useSuspenseQuery(notificationDetailQueryOptions(id));
  const priorityKey = notificationPriorityLabelKey(data.priority);

  return (
    <Stack gap="xl">
      <Box component="section">
        <Group gap="sm" mb="md" wrap="wrap">
          <NotificationStatusBadge status={data.status} />
          <NotificationRevisionBadge
            editedAt={data.editedAt}
            recalledAt={data.recalledAt}
          />
          <NotificationReplyBadge
            hasReply={data.reply !== null}
            respondedAt={data.respondedAt}
            recalledAt={data.recalledAt}
          />
          <Text size="sm" c="dimmed">
            {t(
              data.deliveries.canceled > 0
                ? 'notifications.detail.summaryWithCanceled'
                : 'notifications.detail.summary',
              {
                succeeded: data.deliveries.succeeded,
                pending: data.deliveries.pending,
                failed: data.deliveries.failed,
                canceled: data.deliveries.canceled,
              },
            )}
          </Text>
        </Group>
        <Stack gap={8}>
          <Field
            label={t('notifications.detail.source')}
            value={
              data.sourceType === 'platform'
                ? t('notifications.detail.testSource', {
                    name: data.sourceName,
                  })
                : `${t(SOURCE_TYPE_LABEL[data.sourceType])} · ${data.sourceName}`
            }
          />
          <Field
            label={t('notifications.kind')}
            value={`${data.kindName} (${data.kind})`}
          />
          <Field
            label={t('notifications.detail.priority')}
            value={priorityKey ? t(priorityKey) : String(data.priority)}
          />
          <Field
            label={t('notifications.detail.occurred')}
            value={formatExact(data.occurredAt)}
          />
          <Field
            label={t('notifications.detail.received')}
            value={formatExact(data.createdAt)}
          />
          {data.editedAt ? (
            <Field
              label={t('notifications.badge.edited')}
              value={formatExact(data.editedAt)}
            />
          ) : null}
          {data.recalledAt ? (
            <Field
              label={t('notifications.badge.recalled')}
              value={t('notifications.detail.recalledAt', {
                time: formatExact(data.recalledAt),
              })}
            />
          ) : null}
          {data.dedupeKey ? (
            <Field
              label={t('notifications.detail.dedupeKey')}
              value={data.dedupeKey}
              mono
            />
          ) : null}
          <Field
            label={t('notifications.detail.id')}
            value={data.id}
            mono
            copyValue={data.id}
          />
          {data.url ? (
            <Group gap="md" wrap="nowrap" align="baseline">
              <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
                {t('notifications.detail.link')}
              </Text>
              <NotificationLink url={data.url} />
              {data.autoOpenUrl ? (
                <Tooltip label={t('notifications.detail.opensOnTapHint')}>
                  <Badge variant="light" color="gray" style={{ flex: 'none' }}>
                    {t('notifications.detail.opensOnTap')}
                  </Badge>
                </Tooltip>
              ) : null}
            </Group>
          ) : null}
        </Stack>
        {data.body ? (
          <Text size="sm" mt="lg" style={{ whiteSpace: 'pre-wrap' }}>
            {data.body}
          </Text>
        ) : null}
        {data.data ? (
          <Stack gap={6} mt="lg">
            <Text size="sm" fw={700}>
              {t('notifications.detail.data')}
            </Text>
            <Code block style={{ fontSize: 'var(--mantine-font-size-xs)' }}>
              {JSON.stringify(data.data, null, 2)}
            </Code>
          </Stack>
        ) : null}
      </Box>

      {data.reply ? (
        <>
          <Divider />
          <Box component="section">
            <Text fw={700} fz="lg" mb="xs">
              {t('notifications.detail.reply')}
            </Text>
            <ReplySection
              notificationId={id}
              reply={data.reply}
              response={data.response}
              recalledAt={data.recalledAt}
            />
            {data.response ? (
              <Box mt="lg">
                <Text fw={700} size="sm" mb="xs">
                  {t('notifications.detail.answerDeliveries')}
                </Text>
                {data.responseDeliveryList.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('notifications.detail.noResponseRoute')}
                  </Text>
                ) : (
                  <DeliveryTable
                    notificationId={id}
                    revision={data.revision}
                    deliveries={data.responseDeliveryList}
                  />
                )}
              </Box>
            ) : null}
          </Box>
        </>
      ) : null}

      <Divider />

      <Box component="section">
        <Text fw={700} fz="lg" mb="xs">
          {t('notifications.detail.deliveries')}
        </Text>
        {data.deliveryList.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('notifications.detail.noRoute')}
          </Text>
        ) : (
          <DeliveryTable
            notificationId={id}
            revision={data.revision}
            deliveries={data.deliveryList}
          />
        )}
      </Box>
    </Stack>
  );
}

function DeliveryTable({
  notificationId,
  revision,
  deliveries,
}: {
  notificationId: string;
  revision: number;
  deliveries: DeliveryView[];
}) {
  const { t } = useI18n();
  return (
    <Table.ScrollContainer minWidth={620} type="native">
      <Table verticalSpacing="sm" layout="fixed">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>
              {t('notifications.destinations.column.destination')}
            </Table.Th>
            <Table.Th w={130}>{t('common.status')}</Table.Th>
            <Table.Th w={80}>{t('notifications.detail.attempts')}</Table.Th>
            <Table.Th>{t('notifications.detail.outcome')}</Table.Th>
            <Table.Th w={110} aria-label={t('common.actions')} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {deliveries.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              notificationId={notificationId}
              revision={revision}
              delivery={delivery}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function DeliveryRow({
  notificationId,
  revision,
  delivery,
}: {
  notificationId: string;
  revision: number;
  delivery: DeliveryView;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryDeliveryFn({ data: delivery.id }),
    meta: { errorToast: false },
    onError: (error) => {
      toast.error(errorText(error, 'notifications.detail.retryFailed'));
    },
    onSuccess: () => toast.success(t('notifications.detail.retried')),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(
          notificationDetailQueryOptions(notificationId),
        ),
        queryClient.invalidateQueries({
          queryKey: [...NOTIFICATIONS_KEY, 'history'],
        }),
      ]),
  });

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={8} wrap="nowrap">
          <Box c="dimmed" style={{ display: 'inline-flex' }}>
            <DestinationTypeIcon type={delivery.destinationType} />
          </Box>
          <Stack gap={0} miw={0}>
            <Text size="sm" fw={600} truncate>
              {delivery.destinationName}
            </Text>
            <Text size="xs" c="dimmed">
              {delivery.destinationId
                ? t(DESTINATION_TYPE_LABEL[delivery.destinationType])
                : t('notifications.detail.destinationRemoved', {
                    type: t(DESTINATION_TYPE_LABEL[delivery.destinationType]),
                  })}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <DeliveryStatusBadge status={delivery.status} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {delivery.attempts}
        </Text>
      </Table.Td>
      <Table.Td>
        <DeliveryOutcome delivery={delivery} revision={revision} />
      </Table.Td>
      <Table.Td>
        {delivery.status === 'failed' && delivery.destinationId ? (
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} stroke={1.8} />}
            loading={retry.isPending}
            onClick={() => retry.mutate()}
          >
            {t('common.retry')}
          </Button>
        ) : null}
      </Table.Td>
    </Table.Tr>
  );
}

function DeliveryOutcome({
  delivery,
  revision,
}: {
  delivery: DeliveryView;
  revision: number;
}) {
  const { t, locale } = useI18n();
  const lines: {
    id: string;
    label: string;
    value: string;
    mono?: boolean;
    error?: boolean;
  }[] = [];
  if (delivery.status === 'canceled') {
    lines.push({
      id: 'recalled',
      label: t('notifications.badge.recalled'),
      value: t('notifications.outcome.recalledBeforeDelivery'),
    });
  } else if (revision > 1 && delivery.deliveredRevision !== null) {
    // Destinations that take edits and recalls are re-queued for every
    // change, so a finished delivery behind the latest revision never takes
    // them (a webhook with the option off, or an App that does not declare it).
    lines.push({
      id: 'changes',
      label: t('notifications.outcome.changes'),
      value:
        delivery.deliveredRevision >= revision
          ? t('notifications.outcome.changesReceived')
          : delivery.status === 'succeeded'
            ? t('notifications.outcome.changesNotSent')
            : delivery.status === 'failed'
              ? t('notifications.outcome.changesFailed')
              : t('notifications.outcome.changesSending'),
    });
  }
  if (delivery.result) {
    lines.push({
      id: 'result',
      label:
        delivery.destinationType === 'app'
          ? t('notifications.outcome.appResult')
          : t('notifications.outcome.result'),
      value: delivery.result,
    });
  }
  if (delivery.lastError) {
    lines.push({
      id: 'error',
      label: t('notifications.outcome.error'),
      value: delivery.lastError,
      error: true,
    });
  }
  if (delivery.httpStatus !== null) {
    lines.push({
      id: 'http',
      label: t('notifications.outcome.http'),
      value: String(delivery.httpStatus),
      mono: true,
    });
  }
  const when =
    delivery.nextAttemptAt && delivery.status === 'pending' && delivery.attempts
      ? t('notifications.outcome.nextAttempt', {
          when: formatRelativeTime(delivery.nextAttemptAt, locale),
        })
      : delivery.completedAt
        ? formatRelativeTime(delivery.completedAt, locale)
        : null;

  if (lines.length === 0 && !when) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      {lines.map((line) => (
        <Text
          key={line.id}
          size="xs"
          c={line.error ? 'red.8' : undefined}
          ff={line.mono ? 'monospace' : undefined}
          style={{ wordBreak: 'break-word' }}
        >
          <Text span size="xs" c="dimmed">
            {t('notifications.outcome.lineLabel', { label: line.label })}{' '}
          </Text>
          {line.value}
        </Text>
      ))}
      {when ? (
        <Tooltip
          label={formatExact(delivery.nextAttemptAt ?? delivery.completedAt)}
          withArrow
        >
          <Text size="xs" c="dimmed" w="fit-content">
            {when}
          </Text>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

/**
 * A notification links to a web page, to another app by its own scheme
 * (`mailto:`, `someapp://…`), or, by `hatch://` deep link, to a Hatch page:
 * that opens on the instance it names, here in this tab when that is this
 * instance. Other web pages open in a new tab; other schemes go to the app
 * the system has for them. A scheme that would run in this document is shown
 * as text only.
 */
function NotificationLink({ url }: { url: string }) {
  if (isDocumentUrl(url))
    return (
      <Text size="sm" truncate>
        {url}
      </Text>
    );
  const page = hatchLinkWebUrl(url, window.location.origin, {
    allowLoopbackHttp: true,
  });
  const href = page ?? url;
  const web = /^https?:/i.test(href);
  const here = web && new URL(href).origin === window.location.origin;
  return (
    <Anchor
      href={href}
      {...(web && !here ? { target: '_blank', rel: 'noreferrer' } : {})}
      size="sm"
      truncate
    >
      {url}
    </Anchor>
  );
}
