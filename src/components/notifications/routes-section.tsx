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
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSuspenseQuery } from '@tanstack/react-query';
import { IconArrowRight, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '~i18n';
import {
  notificationDestinationsQueryOptions,
  notificationGroupsQueryOptions,
  notificationRoutesQueryOptions,
  notificationSourcesQueryOptions,
} from '~queries/notifications';
import {
  createRouteFn,
  deleteRouteFn,
  updateRouteFn,
  type NotificationSourcesView,
  type RouteView,
} from '~server/notifications';
import { DESTINATION_TYPE_LABEL } from './status';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

type SourceType = 'any' | 'app' | 'channel';
const ANY = '__any__';

export function kindsFor(
  sources: NotificationSourcesView,
  sourceType: SourceType,
  sourceId: string | null,
) {
  const pool = [
    ...(sourceType !== 'channel' ? sources.apps : []),
    ...(sourceType !== 'app' ? sources.channels : []),
  ].filter((source) => !sourceId || source.id === sourceId);
  const seen = new Map<string, string>();
  for (const source of pool) {
    for (const entry of source.kinds) {
      if (!seen.has(entry.kind)) {
        seen.set(entry.kind, `${entry.name} · ${entry.kind}`);
      }
    }
  }
  return [...seen].map(([value, label]) => ({ value, label }));
}

function useTargets() {
  const { t } = useI18n();
  const { data: groups } = useSuspenseQuery(notificationGroupsQueryOptions);
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  return useMemo(() => {
    const options = [
      ...(groups.length
        ? [
            {
              group: t('notifications.groups.title'),
              items: groups.map((group) => ({
                value: `group:${group.id}`,
                label: group.name,
              })),
            },
          ]
        : []),
      ...(destinations.length
        ? [
            {
              group: t('notifications.destinations.title'),
              items: destinations.map((destination) => ({
                value: `destination:${destination.id}`,
                label: t('notifications.routes.targetOption', {
                  name: destination.name,
                  type: t(DESTINATION_TYPE_LABEL[destination.type]),
                }),
              })),
            },
          ]
        : []),
    ];
    const label = (route: RouteView) =>
      route.targetType === 'group'
        ? (groups.find((group) => group.id === route.targetId)?.name ??
          t('notifications.routes.removedGroup'))
        : (destinations.find((d) => d.id === route.targetId)?.name ??
          t('notifications.routes.removedDestination'));
    return { options, label };
  }, [groups, destinations, t]);
}

function RouteModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { data: sources } = useSuspenseQuery(notificationSourcesQueryOptions);
  const targets = useTargets();
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('any');
  const [sourceId, setSourceId] = useState<string>(ANY);
  const [kind, setKind] = useState<string>(ANY);
  const [target, setTarget] = useState<string | null>(null);

  const create = useNotificationMutation(
    (input: Parameters<typeof createRouteFn>[0]['data']) =>
      createRouteFn({ data: input }),
    { success: t('notifications.routes.created'), onSuccess: () => onClose() },
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    const [targetType, targetId] = target.split(':') as [
      'group' | 'destination',
      string,
    ];
    create.mutate({
      name: name.trim() || null,
      sourceType,
      sourceId: sourceType === 'any' || sourceId === ANY ? null : sourceId,
      kind: kind === ANY ? null : kind,
      targetType,
      targetId,
    });
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={t('notifications.routes.new')}
      centered
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              {t('notifications.routes.when')}
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
          <Select
            label={t('notifications.routes.deliverTo')}
            placeholder={t('notifications.routes.chooseTarget')}
            data={targets.options}
            value={target}
            onChange={setTarget}
            required
            searchable
            nothingFoundMessage={t('notifications.routes.noTargets')}
          />
          <TextInput
            label={t('common.name')}
            description={t('notifications.routes.nameDescription')}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!target}>
              {t('notifications.routes.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function RoutesSection() {
  const { t } = useI18n();
  const { data: routes } = useSuspenseQuery(notificationRoutesQueryOptions);
  const { data: sources } = useSuspenseQuery(notificationSourcesQueryOptions);
  const targets = useTargets();
  const [creating, setCreating] = useState(false);

  const toggle = useNotificationMutation(
    (input: { id: string; enabled: boolean }) => updateRouteFn({ data: input }),
  );
  const remove = useNotificationMutation(
    (id: string) => deleteRouteFn({ data: id }),
    { success: t('notifications.routes.deleted') },
  );

  const sourceLabel = (route: RouteView) => {
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
  const kindLabel = (route: RouteView) => {
    if (!route.kind) return t('notifications.routes.anyKind');
    const match = kindsFor(sources, route.sourceType, route.sourceId).find(
      (entry) => entry.value === route.kind,
    );
    return match?.label ?? route.kind;
  };

  const confirmDelete = (route: RouteView) =>
    modals.openConfirmModal({
      title: t('notifications.routes.deleteTitle'),
      centered: true,
      children: (
        <Text size="sm">
          {t('notifications.routes.deleteBody', {
            target: targets.label(route),
          })}
        </Text>
      ),
      labels: {
        confirm: t('notifications.routes.delete'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(route.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title={t('notifications.routes.title')}
        description={t('notifications.routes.description')}
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setCreating(true)}
          >
            {t('notifications.routes.new')}
          </Button>
        }
      />

      {routes.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          {t('notifications.routes.empty')}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620} type="native">
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('notifications.routes.column.match')}</Table.Th>
                <Table.Th w="30%">
                  {t('notifications.routes.deliverTo')}
                </Table.Th>
                <Table.Th w={90}>{t('common.enabled')}</Table.Th>
                <Table.Th w={48} aria-label={t('common.actions')} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {routes.map((route) => (
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
                      <Text size="sm" truncate>
                        {targets.label(route)}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={
                        toggle.isPending && toggle.variables?.id === route.id
                          ? toggle.variables.enabled
                          : route.enabled
                      }
                      onChange={(event) =>
                        toggle.mutate({
                          id: route.id,
                          enabled: event.currentTarget.checked,
                        })
                      }
                      aria-label={t('notifications.routes.enable')}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={t('notifications.routes.delete')} withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={t('notifications.routes.delete')}
                        onClick={() => confirmDelete(route)}
                      >
                        <IconTrash size={16} stroke={1.6} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {creating ? <RouteModal onClose={() => setCreating(false)} /> : null}
    </Stack>
  );
}
