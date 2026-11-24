import {
  ActionIcon,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSuspenseQuery } from '@tanstack/react-query';
import { IconArrowRight, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '~i18n';
import {
  notificationDestinationsQueryOptions,
  notificationResponseRoutesQueryOptions,
  notificationSourcesQueryOptions,
} from '~queries/notifications';
import {
  createResponseRouteFn,
  deleteResponseRouteFn,
  updateResponseRouteFn,
  type ResponseRouteView,
} from '~server/notifications';
import { kindsFor } from './routes-section';
import { DESTINATION_TYPE_LABEL } from './status';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

type SourceType = 'any' | 'app' | 'channel';
type TargetType = 'destination' | 'agent';
const ANY = '__any__';

function ResponseRouteModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { data: sources } = useSuspenseQuery(notificationSourcesQueryOptions);
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('any');
  const [sourceId, setSourceId] = useState<string>(ANY);
  const [kind, setKind] = useState<string>(ANY);
  const [targetType, setTargetType] = useState<TargetType>('destination');
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  const ready = targetType === 'agent' || Boolean(destinationId);

  const create = useNotificationMutation(
    (input: Parameters<typeof createResponseRouteFn>[0]['data']) =>
      createResponseRouteFn({ data: input }),
    {
      success: t('notifications.responseRoutes.created'),
      onSuccess: () => onClose(),
    },
  );

  const sourceOptions = [
    {
      value: ANY,
      label:
        sourceType === 'app'
          ? t('notifications.routes.anyApp')
          : t('notifications.routes.anyChannel'),
    },
    ...(sourceType === 'app' ? sources.apps : sources.channels).map(
      (source) => ({ value: source.id, label: source.name }),
    ),
  ];
  const kindOptions = [
    { value: ANY, label: t('notifications.routes.anyKindOption') },
    ...kindsFor(sources, sourceType, sourceId === ANY ? null : sourceId),
  ];
  const targets = destinations
    .filter((destination) => destination.acceptsResponses)
    .map((destination) => ({
      value: destination.id,
      label: t('notifications.routes.targetOption', {
        name: destination.name,
        type: t(DESTINATION_TYPE_LABEL[destination.type]),
      }),
    }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    create.mutate({
      name: name.trim() || null,
      sourceType,
      sourceId: sourceType === 'any' || sourceId === ANY ? null : sourceId,
      kind: kind === ANY ? null : kind,
      target:
        targetType === 'agent'
          ? {
              agent: {
                sessionId: null,
                instructions: instructions.trim() || null,
              },
            }
          : { destinationId: destinationId! },
    });
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={t('notifications.responseRoutes.new')}
      centered
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              {t('notifications.responseRoutes.when')}
            </Text>
            <SegmentedControl
              value={sourceType}
              onChange={(value) => {
                setSourceType(value as SourceType);
                setSourceId(ANY);
                setKind(ANY);
              }}
              data={[
                { value: 'any', label: t('notifications.routes.anywhere') },
                { value: 'app', label: t('notifications.routes.anApp') },
                {
                  value: 'channel',
                  label: t('notifications.routes.aChannel'),
                },
              ]}
            />
          </Stack>
          {sourceType !== 'any' ? (
            <Select
              label={
                sourceType === 'app'
                  ? t('notifications.destinationType.app')
                  : t('notifications.channels.column.channel')
              }
              data={sourceOptions}
              value={sourceId}
              onChange={(value) => {
                setSourceId(value ?? ANY);
                setKind(ANY);
              }}
              allowDeselect={false}
              searchable
            />
          ) : null}
          <Select
            label={t('notifications.kind')}
            data={kindOptions}
            value={kind}
            onChange={(value) => setKind(value ?? ANY)}
            allowDeselect={false}
            searchable
          />
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              {t('notifications.responseRoutes.sendTo')}
            </Text>
            <SegmentedControl
              value={targetType}
              onChange={(value) => setTargetType(value as TargetType)}
              data={[
                {
                  value: 'destination',
                  label: t('notifications.responseRoutes.target.destination'),
                },
                {
                  value: 'agent',
                  label: t('notifications.responseRoutes.target.agent'),
                },
              ]}
            />
          </Stack>
          {targetType === 'agent' ? (
            <Textarea
              label={t('notifications.responseRoutes.agentInstructions')}
              description={t(
                'notifications.responseRoutes.agentInstructionsDescription',
              )}
              placeholder={t(
                'notifications.responseRoutes.agentInstructionsPlaceholder',
              )}
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
              autosize
              minRows={2}
              maxRows={8}
              maxLength={2000}
            />
          ) : (
            <Select
              label={t('notifications.responseRoutes.destination')}
              description={t('notifications.responseRoutes.sendToDescription')}
              placeholder={t('notifications.responseRoutes.chooseDestination')}
              data={targets}
              value={destinationId}
              onChange={setDestinationId}
              required
              searchable
              nothingFoundMessage={t('notifications.responseRoutes.noTargets')}
            />
          )}
          <TextInput
            label={t('common.name')}
            description={t('notifications.responseRoutes.nameDescription')}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!ready}>
              {t('notifications.responseRoutes.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * A route's enabled switch with its own mutation: it is disabled while its
 * update is pending, so changes to one route land in click order whatever
 * happens to other routes.
 */
function ResponseRouteSwitch({ route }: { route: ResponseRouteView }) {
  const { t } = useI18n();
  const toggle = useNotificationMutation((enabled: boolean) =>
    updateResponseRouteFn({ data: { id: route.id, enabled } }),
  );
  return (
    <Switch
      checked={toggle.isPending ? toggle.variables : route.enabled}
      onChange={(event) => toggle.mutate(event.currentTarget.checked)}
      disabled={toggle.isPending}
      aria-label={t('notifications.responseRoutes.enable')}
    />
  );
}

/** Where answers to notification reply forms are sent. */
export function ResponseRoutesSection() {
  const { t } = useI18n();
  const { data: routes } = useSuspenseQuery(
    notificationResponseRoutesQueryOptions,
  );
  const { data: sources } = useSuspenseQuery(notificationSourcesQueryOptions);
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [creating, setCreating] = useState(false);

  const remove = useNotificationMutation(
    (id: string) => deleteResponseRouteFn({ data: id }),
    { success: t('notifications.responseRoutes.deleted') },
  );

  const sourceLabel = (route: ResponseRouteView) => {
    if (route.sourceType === 'any') return t('notifications.routes.anySource');
    if (!route.sourceId) {
      return route.sourceType === 'app'
        ? t('notifications.routes.anyApp')
        : t('notifications.routes.anyChannel');
    }
    const list = route.sourceType === 'app' ? sources.apps : sources.channels;
    return (
      list.find((source) => source.id === route.sourceId)?.name ??
      (route.sourceType === 'app'
        ? t('notifications.routes.unavailableApp')
        : t('notifications.routes.removedChannel'))
    );
  };
  const kindLabel = (route: ResponseRouteView) => {
    if (!route.kind) return t('notifications.routes.anyKind');
    const match = kindsFor(sources, route.sourceType, route.sourceId).find(
      (entry) => entry.value === route.kind,
    );
    return match?.label ?? route.kind;
  };
  const target = (route: ResponseRouteView) =>
    destinations.find((destination) => destination.id === route.destinationId);
  const targetLabel = (route: ResponseRouteView) =>
    route.targetType === 'agent'
      ? route.agentSessionId
        ? t('notifications.responseRoutes.agentFixed')
        : t('notifications.responseRoutes.agentPerNotification')
      : (target(route)?.name ?? t('notifications.routes.removedDestination'));

  const confirmDelete = (route: ResponseRouteView) => {
    const destination = target(route);
    return modals.openConfirmModal({
      title: t('notifications.responseRoutes.deleteTitle'),
      centered: true,
      children: (
        <Text size="sm">
          {route.targetType === 'agent'
            ? t('notifications.responseRoutes.deleteBodyAgent')
            : destination
              ? t('notifications.responseRoutes.deleteBody', {
                  name: destination.name,
                })
              : t('notifications.responseRoutes.deleteBodyRemoved')}
        </Text>
      ),
      labels: {
        confirm: t('notifications.responseRoutes.delete'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(route.id),
    });
  };

  return (
    <Stack gap="md">
      <SectionTitle
        title={t('notifications.responseRoutes.title')}
        description={t('notifications.responseRoutes.description')}
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setCreating(true)}
          >
            {t('notifications.responseRoutes.new')}
          </Button>
        }
      />

      {routes.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          {t('notifications.responseRoutes.empty')}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620} type="native">
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>
                  {t('notifications.responseRoutes.column.answersTo')}
                </Table.Th>
                <Table.Th w="30%">
                  {t('notifications.responseRoutes.column.sendTo')}
                </Table.Th>
                <Table.Th w={90}>{t('common.enabled')}</Table.Th>
                <Table.Th w={48} aria-label={t('common.actions')} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {routes.map((route) => {
                const destination = target(route);
                const stale =
                  destination !== undefined && !destination.acceptsResponses;
                return (
                  <Table.Tr key={route.id}>
                    <Table.Td>
                      <Stack gap={0} miw={0}>
                        <Text size="sm" fw={600} truncate>
                          {sourceLabel(route)} · {kindLabel(route)}
                        </Text>
                        {route.name ? (
                          <Text size="xs" c="dimmed" truncate>
                            {route.name}
                          </Text>
                        ) : null}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <IconArrowRight
                          size={14}
                          stroke={1.6}
                          color="var(--mantine-color-dimmed)"
                        />
                        <Stack gap={0} miw={0}>
                          <Text size="sm" truncate>
                            {targetLabel(route)}
                          </Text>
                          {route.agentInstructions ? (
                            <Text size="xs" c="dimmed" truncate>
                              {route.agentInstructions}
                            </Text>
                          ) : null}
                          {stale ? (
                            <Text size="xs" c="red.8">
                              {t('notifications.responseRoutes.stale')}
                            </Text>
                          ) : null}
                        </Stack>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <ResponseRouteSwitch route={route} />
                    </Table.Td>
                    <Table.Td>
                      <Tooltip
                        label={t('notifications.responseRoutes.delete')}
                        withArrow
                      >
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('notifications.responseRoutes.delete')}
                          onClick={() => confirmDelete(route)}
                        >
                          <IconTrash size={16} stroke={1.6} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {creating ? (
        <ResponseRouteModal onClose={() => setCreating(false)} />
      ) : null}
    </Stack>
  );
}
