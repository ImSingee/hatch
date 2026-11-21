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
import { useState, type FormEvent } from 'react';
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
const ANY = '__any__';

function ResponseRouteModal({ onClose }: { onClose: () => void }) {
  const { data: sources } = useSuspenseQuery(notificationSourcesQueryOptions);
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('any');
  const [sourceId, setSourceId] = useState<string>(ANY);
  const [kind, setKind] = useState<string>(ANY);
  const [destinationId, setDestinationId] = useState<string | null>(null);

  const create = useNotificationMutation(
    (input: Parameters<typeof createResponseRouteFn>[0]['data']) =>
      createResponseRouteFn({ data: input }),
    { success: 'Response route created', onSuccess: () => onClose() },
  );

  const sourceOptions = [
    { value: ANY, label: sourceType === 'app' ? 'Any App' : 'Any Channel' },
    ...(sourceType === 'app' ? sources.apps : sources.channels).map(
      (source) => ({ value: source.id, label: source.name }),
    ),
  ];
  const kindOptions = [
    { value: ANY, label: 'Any kind' },
    ...kindsFor(sources, sourceType, sourceId === ANY ? null : sourceId),
  ];
  const targets = destinations
    .filter((destination) => destination.acceptsResponses)
    .map((destination) => ({
      value: destination.id,
      label: `${destination.name} (${DESTINATION_TYPE_LABEL[destination.type]})`,
    }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!destinationId) return;
    create.mutate({
      name: name.trim() || null,
      sourceType,
      sourceId: sourceType === 'any' || sourceId === ANY ? null : sourceId,
      kind: kind === ANY ? null : kind,
      destinationId,
    });
  };

  return (
    <Modal opened onClose={onClose} title="New response route" centered>
      <form onSubmit={submit}>
        <Stack gap="md">
          <Stack gap={6}>
            <Text size="sm" fw={600}>
              When someone answers a notification from
            </Text>
            <SegmentedControl
              value={sourceType}
              onChange={(value) => {
                setSourceType(value as SourceType);
                setSourceId(ANY);
                setKind(ANY);
              }}
              data={[
                { value: 'any', label: 'Anywhere' },
                { value: 'app', label: 'An App' },
                { value: 'channel', label: 'A Channel' },
              ]}
            />
          </Stack>
          {sourceType !== 'any' ? (
            <Select
              label={sourceType === 'app' ? 'App' : 'Channel'}
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
            label="Kind"
            data={kindOptions}
            value={kind}
            onChange={(value) => setKind(value ?? ANY)}
            allowDeselect={false}
            searchable
          />
          <Select
            label="Send the answer to"
            description="A webhook, or an App whose manifest sets notifications.destination.responses."
            placeholder="Choose a destination"
            data={targets}
            value={destinationId}
            onChange={setDestinationId}
            required
            searchable
            nothingFoundMessage="Add a webhook first"
          />
          <TextInput
            label="Name"
            description="Optional, shown in the list."
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={create.isPending}
              disabled={!destinationId}
            >
              Create response route
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
  const toggle = useNotificationMutation((enabled: boolean) =>
    updateResponseRouteFn({ data: { id: route.id, enabled } }),
  );
  return (
    <Switch
      checked={toggle.isPending ? toggle.variables : route.enabled}
      onChange={(event) => toggle.mutate(event.currentTarget.checked)}
      disabled={toggle.isPending}
      aria-label="Enable response route"
    />
  );
}

/** Where answers to notification reply forms are sent. */
export function ResponseRoutesSection() {
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
    { success: 'Response route deleted' },
  );

  const sourceLabel = (route: ResponseRouteView) => {
    if (route.sourceType === 'any') return 'Any source';
    if (!route.sourceId) {
      return route.sourceType === 'app' ? 'Any App' : 'Any Channel';
    }
    const list = route.sourceType === 'app' ? sources.apps : sources.channels;
    return (
      list.find((source) => source.id === route.sourceId)?.name ??
      (route.sourceType === 'app' ? 'Unavailable App' : 'Removed Channel')
    );
  };
  const kindLabel = (route: ResponseRouteView) => {
    if (!route.kind) return 'any kind';
    const match = kindsFor(sources, route.sourceType, route.sourceId).find(
      (entry) => entry.value === route.kind,
    );
    return match?.label ?? route.kind;
  };
  const target = (route: ResponseRouteView) =>
    destinations.find((destination) => destination.id === route.destinationId);

  const confirmDelete = (route: ResponseRouteView) =>
    modals.openConfirmModal({
      title: 'Delete this response route?',
      centered: true,
      children: (
        <Text size="sm">
          Answers to matching notifications stop being sent to{' '}
          {target(route)?.name ?? 'this destination'}.
        </Text>
      ),
      labels: { confirm: 'Delete response route', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(route.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title="Response routes"
        description="Where answers go when a notification asks a question. Each notification takes one answer; every matching route receives it."
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setCreating(true)}
          >
            New response route
          </Button>
        }
      />

      {routes.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          No response routes yet, so answers are recorded here but not sent
          anywhere.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620} type="native">
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Answers to</Table.Th>
                <Table.Th w="30%">Send to</Table.Th>
                <Table.Th w={90}>Enabled</Table.Th>
                <Table.Th w={48} aria-label="Actions" />
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
                            {destination?.name ?? 'Removed destination'}
                          </Text>
                          {stale ? (
                            <Text size="xs" c="red.8">
                              No longer accepts responses
                            </Text>
                          ) : null}
                        </Stack>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <ResponseRouteSwitch route={route} />
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label="Delete response route" withArrow>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label="Delete response route"
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
