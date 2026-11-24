import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSuspenseQuery } from '@tanstack/react-query';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '~i18n';
import {
  notificationDestinationsQueryOptions,
  notificationGroupsQueryOptions,
} from '~queries/notifications';
import {
  createGroupFn,
  deleteGroupFn,
  updateGroupFn,
  type GroupView,
} from '~server/notifications';
import { DESTINATION_TYPE_PLURAL } from './status';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

function GroupModal({
  editing,
  onClose,
}: {
  editing: GroupView | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [members, setMembers] = useState<string[]>(
    editing?.destinationIds ?? [],
  );
  const [autoAddDevices, setAutoAddDevices] = useState(
    editing?.autoAddDevices ?? false,
  );

  const save = useNotificationMutation(
    (input: {
      name: string;
      description: string | null;
      autoAddDevices: boolean;
      destinationIds: string[];
    }) =>
      editing
        ? updateGroupFn({ data: { id: editing.id, ...input } })
        : createGroupFn({ data: input }),
    {
      success: editing
        ? t('notifications.groups.updated')
        : t('notifications.groups.created'),
      onSuccess: () => onClose(),
    },
  );

  const options = (['device', 'webhook', 'app'] as const)
    .map((type) => ({
      group: t(DESTINATION_TYPE_PLURAL[type]),
      items: destinations
        .filter((destination) => destination.type === type)
        .map((destination) => ({
          value: destination.id,
          label: destination.name,
        })),
    }))
    .filter((group) => group.items.length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      name,
      description: description.trim() || null,
      autoAddDevices,
      destinationIds: members,
    });
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={
        editing ? t('notifications.groups.edit') : t('notifications.groups.new')
      }
      centered
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label={t('common.name')}
            placeholder={t('notifications.groups.namePlaceholder')}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            maxLength={80}
            data-autofocus
          />
          <TextInput
            label={t('notifications.description')}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            maxLength={500}
          />
          <MultiSelect
            label={t('notifications.destinations.title')}
            placeholder={
              members.length
                ? undefined
                : t('notifications.groups.chooseDestinations')
            }
            data={options}
            value={members}
            onChange={setMembers}
            searchable
            nothingFoundMessage={t('notifications.groups.noDestinations')}
          />
          <Switch
            label={t('notifications.groups.autoAdd')}
            description={t('notifications.groups.autoAddDescription')}
            checked={autoAddDevices}
            onChange={(event) => setAutoAddDevices(event.currentTarget.checked)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {editing ? t('common.save') : t('notifications.groups.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function GroupsSection() {
  const { t } = useI18n();
  const { data: groups } = useSuspenseQuery(notificationGroupsQueryOptions);
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [modal, setModal] = useState<{ editing: GroupView | null } | null>(
    null,
  );
  const remove = useNotificationMutation(
    (id: string) => deleteGroupFn({ data: id }),
    { success: t('notifications.groups.deleted') },
  );
  const nameOf = new Map(destinations.map((d) => [d.id, d.name]));

  const confirmDelete = (group: GroupView) =>
    modals.openConfirmModal({
      title: t('notifications.groups.deleteTitle', { name: group.name }),
      centered: true,
      children: <Text size="sm">{t('notifications.groups.deleteBody')}</Text>,
      labels: {
        confirm: t('notifications.groups.delete'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(group.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title={t('notifications.groups.title')}
        description={t('notifications.groups.description')}
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setModal({ editing: null })}
          >
            {t('notifications.groups.new')}
          </Button>
        }
      />

      {groups.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          {t('notifications.groups.empty')}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620} type="native">
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="32%">
                  {t('notifications.groups.column.group')}
                </Table.Th>
                <Table.Th>{t('notifications.destinations.title')}</Table.Th>
                <Table.Th w={84} aria-label={t('common.actions')} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {groups.map((group) => (
                <Table.Tr key={group.id}>
                  <Table.Td>
                    <Text size="sm" fw={700} truncate>
                      {group.name}
                    </Text>
                    {group.description ? (
                      <Text size="xs" c="dimmed" truncate>
                        {group.description}
                      </Text>
                    ) : null}
                    {group.autoAddDevices ? (
                      <Text size="xs" c="dimmed">
                        {t('notifications.groups.autoAdds')}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    {group.destinationIds.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        {t('notifications.groups.emptyMembers')}
                      </Text>
                    ) : (
                      <Group gap={6}>
                        {group.destinationIds.map((id) => (
                          <Badge
                            key={id}
                            variant="light"
                            color="gray"
                            radius="sm"
                          >
                            {nameOf.get(id) ??
                              t('notifications.groups.removedMember')}
                          </Badge>
                        ))}
                      </Group>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Tooltip label={t('notifications.groups.edit')} withArrow>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={t('notifications.editName', {
                            name: group.name,
                          })}
                          onClick={() => setModal({ editing: group })}
                        >
                          <IconPencil size={16} stroke={1.6} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip
                        label={t('notifications.groups.delete')}
                        withArrow
                      >
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('notifications.deleteName', {
                            name: group.name,
                          })}
                          onClick={() => confirmDelete(group)}
                        >
                          <IconTrash size={16} stroke={1.6} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {modal ? (
        <GroupModal
          key={modal.editing?.id ?? 'new'}
          editing={modal.editing}
          onClose={() => setModal(null)}
        />
      ) : null}
    </Stack>
  );
}
