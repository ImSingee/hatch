import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
  IconAlertCircle,
  IconCode,
  IconDotsVertical,
  IconKey,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { Trans } from 'react-i18next';
import { useI18n } from '~i18n';
import { notificationChannelsQueryOptions } from '~queries/notifications';
import {
  createChannelFn,
  deleteChannelFn,
  rotateChannelTokenFn,
  updateChannelFn,
  type ChannelView,
} from '~server/notifications';
import {
  EMPTY_KIND,
  KindsEditor,
  KindsProblemText,
  kindsError,
  toKindInput,
  type KindDraft,
} from './kinds-editor';
import { CopyableCode, SecretReveal } from './secret-reveal';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

function curlExample(
  channel: ChannelView,
  token: string,
  title: string,
): string {
  const kind = channel.kinds[0]?.kind ?? 'example';
  return [
    `curl -X POST '${channel.pushUrl}' \\`,
    `  -H 'x-hatch-secret: ${token}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify({ kind, title })}'`,
  ].join('\n');
}

function PushInstructions({
  channel,
  token,
}: {
  channel: ChannelView;
  token: string | null;
}) {
  const { t } = useI18n();
  return (
    <Stack gap="sm">
      {token ? <SecretReveal kind="channelToken" secret={token} /> : null}
      <CopyableCode kind="pushUrl" value={channel.pushUrl} />
      <CopyableCode
        kind="example"
        value={curlExample(
          channel,
          token ?? t('notifications.channels.tokenPlaceholder'),
          t('notifications.channels.exampleTitle'),
        )}
      />
      <Text size="xs" c="dimmed">
        <Trans
          t={t}
          i18nKey="notifications.channels.bodyFields"
          components={{ code: <code /> }}
        />
      </Text>
    </Stack>
  );
}

function ChannelModal({
  editing,
  onClose,
}: {
  editing: ChannelView | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [kinds, setKinds] = useState<KindDraft[]>(
    editing
      ? editing.kinds.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          description: entry.description ?? '',
        }))
      : [EMPTY_KIND],
  );
  const [created, setCreated] = useState<{
    channel: ChannelView;
    token: string;
  } | null>(null);
  const { t } = useI18n();
  const invalid = kindsError(kinds);

  const save = useNotificationMutation(
    async (input: {
      name: string;
      description: string | null;
      kinds: ReturnType<typeof toKindInput>;
    }) => {
      if (editing) {
        await updateChannelFn({ data: { id: editing.id, ...input } });
        return null;
      }
      return createChannelFn({ data: input });
    },
    {
      success: editing
        ? t('notifications.channels.updated')
        : t('notifications.channels.created'),
      onSuccess: (result) => {
        if (result) setCreated(result);
        else onClose();
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    save.mutate({
      name,
      description: description.trim() || null,
      kinds: toKindInput(kinds),
    });
  };

  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      centered
      closeOnClickOutside={!created}
      title={
        created
          ? t('notifications.channels.created')
          : editing
            ? t('notifications.channels.edit')
            : t('notifications.channels.new')
      }
    >
      {created ? (
        <Stack gap="md">
          <PushInstructions channel={created.channel} token={created.token} />
          <Group justify="flex-end">
            <Button onClick={onClose}>{t('common.done')}</Button>
          </Group>
        </Stack>
      ) : (
        <form onSubmit={submit}>
          <Stack gap="md">
            <TextInput
              label={t('common.name')}
              placeholder={t('notifications.channels.namePlaceholder')}
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
            <KindsEditor value={kinds} onChange={setKinds} />
            {invalid && kinds.some((entry) => entry.kind || entry.name) ? (
              <Text size="xs" c="red.8">
                <KindsProblemText problem={invalid} />
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                loading={save.isPending}
                disabled={Boolean(invalid)}
              >
                {editing
                  ? t('common.save')
                  : t('notifications.channels.create')}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

function InstructionsModal({
  state,
  onClose,
}: {
  state: { channel: ChannelView; token: string | null } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      opened={state !== null}
      onClose={onClose}
      size="lg"
      centered
      closeOnClickOutside={!state?.token}
      title={
        state?.token
          ? t('notifications.channels.newToken')
          : t('notifications.channels.pushTitle')
      }
    >
      {state ? (
        <Stack gap="md">
          {state.token ? (
            <Alert
              color="gray"
              variant="light"
              icon={<IconAlertCircle size={18} stroke={1.6} />}
            >
              {t('notifications.channels.tokenRotated')}
            </Alert>
          ) : null}
          <PushInstructions channel={state.channel} token={state.token} />
          <Group justify="flex-end">
            <Button onClick={onClose}>{t('common.done')}</Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}

export function ChannelsSection() {
  const { t } = useI18n();
  const { data: channels } = useSuspenseQuery(notificationChannelsQueryOptions);
  const [modal, setModal] = useState<{ editing: ChannelView | null } | null>(
    null,
  );
  const [instructions, setInstructions] = useState<{
    channel: ChannelView;
    token: string | null;
  } | null>(null);

  const toggle = useNotificationMutation(
    (input: { id: string; enabled: boolean }) =>
      updateChannelFn({ data: input }),
  );
  const rotate = useNotificationMutation(
    (channel: ChannelView) =>
      rotateChannelTokenFn({ data: channel.id }).then((result) => ({
        channel,
        token: result.token,
      })),
    { onSuccess: (result) => setInstructions(result) },
  );
  const remove = useNotificationMutation(
    (id: string) => deleteChannelFn({ data: id }),
    { success: t('notifications.channels.deleted') },
  );

  const confirmRotate = (channel: ChannelView) =>
    modals.openConfirmModal({
      title: t('notifications.channels.rotateTitle', { name: channel.name }),
      centered: true,
      children: <Text size="sm">{t('notifications.channels.rotateBody')}</Text>,
      labels: {
        confirm: t('notifications.channels.rotate'),
        cancel: t('common.cancel'),
      },
      onConfirm: () => rotate.mutate(channel),
    });
  const confirmDelete = (channel: ChannelView) =>
    modals.openConfirmModal({
      title: t('notifications.channels.deleteTitle', { name: channel.name }),
      centered: true,
      children: <Text size="sm">{t('notifications.channels.deleteBody')}</Text>,
      labels: {
        confirm: t('notifications.channels.delete'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(channel.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title={t('notifications.channels.title')}
        description={t('notifications.channels.description')}
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setModal({ editing: null })}
          >
            {t('notifications.channels.new')}
          </Button>
        }
      />

      {channels.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          {t('notifications.channels.empty')}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620} type="native">
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="32%">
                  {t('notifications.channels.column.channel')}
                </Table.Th>
                <Table.Th>{t('notifications.kinds.title')}</Table.Th>
                <Table.Th w={90}>{t('common.enabled')}</Table.Th>
                <Table.Th w={48} aria-label={t('common.actions')} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {channels.map((channel) => (
                <Table.Tr key={channel.id}>
                  <Table.Td>
                    <Text size="sm" fw={700} truncate>
                      {channel.name}
                    </Text>
                    {channel.description ? (
                      <Text size="xs" c="dimmed" truncate>
                        {channel.description}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6}>
                      {channel.kinds.map((entry) => (
                        <Badge
                          key={entry.kind}
                          variant="light"
                          color="gray"
                          radius="sm"
                          title={entry.kind}
                        >
                          {entry.name}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={
                        toggle.isPending && toggle.variables?.id === channel.id
                          ? toggle.variables.enabled
                          : channel.enabled
                      }
                      onChange={(event) =>
                        toggle.mutate({
                          id: channel.id,
                          enabled: event.currentTarget.checked,
                        })
                      }
                      aria-label={t('notifications.enableName', {
                        name: channel.name,
                      })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={t('notifications.actionsFor', {
                            name: channel.name,
                          })}
                        >
                          <IconDotsVertical size={16} stroke={1.6} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconCode size={14} stroke={1.6} />}
                          onClick={() =>
                            setInstructions({ channel, token: null })
                          }
                        >
                          {t('notifications.channels.howToPush')}
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconPencil size={14} stroke={1.6} />}
                          onClick={() => setModal({ editing: channel })}
                        >
                          {t('common.edit')}
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconKey size={14} stroke={1.6} />}
                          onClick={() => confirmRotate(channel)}
                        >
                          {t('notifications.channels.rotate')}
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} stroke={1.6} />}
                          onClick={() => confirmDelete(channel)}
                        >
                          {t('common.delete')}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {modal ? (
        <ChannelModal
          key={modal.editing?.id ?? 'new'}
          editing={modal.editing}
          onClose={() => setModal(null)}
        />
      ) : null}
      <InstructionsModal
        state={instructions}
        onClose={() => setInstructions(null)}
      />
    </Stack>
  );
}
