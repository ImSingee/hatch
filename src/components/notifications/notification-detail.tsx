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
import { formatExact, formatRelative } from '~lib/format';
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
  notificationPriorityLabel,
} from './status';
import { ReplySection } from './reply-section';

const SOURCE_TYPE_LABEL = {
  app: 'App',
  channel: 'Channel',
  user: 'User',
} as const;

export function NotificationDetail({ id }: { id: string }) {
  const { data } = useSuspenseQuery(notificationDetailQueryOptions(id));

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
            {data.deliveries.succeeded} delivered · {data.deliveries.pending} in
            progress · {data.deliveries.failed} failed
            {data.deliveries.canceled > 0
              ? ` · ${data.deliveries.canceled} not sent`
              : ''}
          </Text>
        </Group>
        <Stack gap={8}>
          <Field
            label="Source"
            value={
              data.sourceType === 'platform'
                ? `${data.sourceName} (test)`
                : `${SOURCE_TYPE_LABEL[data.sourceType]} · ${data.sourceName}`
            }
          />
          <Field label="Kind" value={`${data.kindName} (${data.kind})`} />
          <Field
            label="Priority"
            value={notificationPriorityLabel(data.priority)}
          />
          <Field label="Occurred" value={formatExact(data.occurredAt)} />
          <Field label="Received" value={formatExact(data.createdAt)} />
          {data.editedAt ? (
            <Field label="Edited" value={formatExact(data.editedAt)} />
          ) : null}
          {data.recalledAt ? (
            <Field
              label="Recalled"
              value={`${formatExact(data.recalledAt)} · removed from phones; content kept here`}
            />
          ) : null}
          {data.dedupeKey ? (
            <Field label="Dedupe key" value={data.dedupeKey} mono />
          ) : null}
          <Field label="ID" value={data.id} mono copyValue={data.id} />
          {data.url ? (
            <Group gap="md" wrap="nowrap" align="baseline">
              <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
                Link
              </Text>
              <NotificationLink url={data.url} />
              {data.autoOpenUrl ? (
                <Tooltip label="Tapping the phone notification opens this link instead of the notification.">
                  <Badge variant="light" color="gray" style={{ flex: 'none' }}>
                    Opens on tap
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
              Data
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
              Reply
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
                  Answer deliveries
                </Text>
                {data.responseDeliveryList.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No response route matched, so the answer is only recorded
                    here. Add a response route in Settings → Notifications.
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
          Deliveries
        </Text>
        {data.deliveryList.length === 0 ? (
          <Text size="sm" c="dimmed">
            No route matched this notification, so it was recorded without being
            delivered. Add a route in Settings → Notifications.
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
  return (
    <Table.ScrollContainer minWidth={620} type="native">
      <Table verticalSpacing="sm" layout="fixed">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Destination</Table.Th>
            <Table.Th w={130}>Status</Table.Th>
            <Table.Th w={80}>Attempts</Table.Th>
            <Table.Th>Outcome</Table.Th>
            <Table.Th w={110} aria-label="Actions" />
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
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryDeliveryFn({ data: delivery.id }),
    onSuccess: () => toast.success('Delivery queued again'),
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
              {DESTINATION_TYPE_LABEL[delivery.destinationType]}
              {delivery.destinationId ? '' : ' · removed'}
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
            Retry
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
  const lines: { label: string; value: string; mono?: boolean }[] = [];
  if (delivery.status === 'canceled') {
    lines.push({ label: 'Recalled', value: 'before it was delivered' });
  } else if (revision > 1 && delivery.deliveredRevision !== null) {
    // Destinations that take edits and recalls are re-queued for every
    // change, so a finished delivery behind the latest revision never takes
    // them (a webhook with the option off, or an App that does not declare it).
    lines.push({
      label: 'Changes',
      value:
        delivery.deliveredRevision >= revision
          ? 'latest edit or recall received'
          : delivery.status === 'succeeded'
            ? 'not sent here (destination takes no edits or recalls)'
            : delivery.status === 'failed'
              ? 'latest edit or recall failed'
              : 'sending the latest edit or recall',
    });
  }
  if (delivery.result) {
    lines.push({
      label: delivery.destinationType === 'app' ? 'App result' : 'Result',
      value: delivery.result,
    });
  }
  if (delivery.lastError) {
    lines.push({ label: 'Error', value: delivery.lastError });
  }
  if (delivery.httpStatus !== null) {
    lines.push({
      label: 'HTTP',
      value: String(delivery.httpStatus),
      mono: true,
    });
  }
  const when =
    delivery.nextAttemptAt && delivery.status === 'pending' && delivery.attempts
      ? `Next attempt ${formatRelative(delivery.nextAttemptAt)}`
      : delivery.completedAt
        ? formatRelative(delivery.completedAt)
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
          key={line.label}
          size="xs"
          c={line.label === 'Error' ? 'red.8' : undefined}
          ff={line.mono ? 'monospace' : undefined}
          style={{ wordBreak: 'break-word' }}
        >
          <Text span size="xs" c="dimmed">
            {line.label}:{' '}
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
export function NotificationLink({ url }: { url: string }) {
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
