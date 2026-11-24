import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
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
  IconDotsVertical,
  IconKey,
  IconPencil,
  IconPlus,
  IconSend,
  IconTrash,
} from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { Trans } from 'react-i18next';
import { useI18n } from '~i18n';
import {
  apnsStatusQueryOptions,
  notificationDestinationsQueryOptions,
} from '~queries/notifications';
import {
  createWebhookFn,
  deleteDestinationFn,
  rotateWebhookSecretFn,
  sendTestNotificationFn,
  updateDestinationFn,
  type DestinationView,
} from '~server/notifications';
import { SecretReveal } from './secret-reveal';
import { DESTINATION_TYPE_LABEL, DestinationTypeIcon } from './status';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

type Translate = ReturnType<typeof useI18n>['t'];

function ApnsStatusLine() {
  const { t } = useI18n();
  const { data } = useSuspenseQuery(apnsStatusQueryOptions);
  if (data.error) {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertCircle size={18} stroke={1.6} />}
      >
        {t('notifications.apns.misconfigured', { error: data.error })}
      </Alert>
    );
  }
  const environments =
    data.production && data.sandbox
      ? t('notifications.apns.environment.both')
      : data.production
        ? t('notifications.apns.environment.production')
        : data.sandbox
          ? t('notifications.apns.environment.sandbox')
          : null;
  return (
    <Text size="sm" c="dimmed">
      {environments === null
        ? t('notifications.apns.none')
        : data.source === 'builtin'
          ? t('notifications.apns.builtin', { environments })
          : t('notifications.apns.own', { environments })}
    </Text>
  );
}

function describe(t: Translate, destination: DestinationView): string {
  if (destination.device) {
    return [
      destination.device.userName ??
        t('notifications.destinations.unknownUser'),
      destination.device.platform === 'ios'
        ? 'iOS'
        : destination.device.platform,
      destination.device.environment === 'sandbox'
        ? t('notifications.destinations.developmentBuild')
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (destination.webhook) {
    return destination.lifecycleEvents
      ? t('notifications.destinations.webhookWithEdits', {
          url: destination.webhook.url,
        })
      : destination.webhook.url;
  }
  if (destination.app) {
    return destination.app.accepting
      ? [
          t('notifications.destinationType.app'),
          `/app/${destination.app.slug ?? destination.app.appId}`,
          destination.lifecycleEvents
            ? t('notifications.destinations.receivesEdits')
            : null,
          destination.acceptsResponses
            ? t('notifications.destinations.acceptsAnswers')
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : t('notifications.destinations.appNotAccepting');
  }
  return t(DESTINATION_TYPE_LABEL[destination.type]);
}

function WebhookModal({
  opened,
  onClose,
  editing,
}: {
  opened: boolean;
  onClose: () => void;
  editing: DestinationView | null;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(editing?.name ?? '');
  const [url, setUrl] = useState(editing?.webhook?.url ?? '');
  const [lifecycleEvents, setLifecycleEvents] = useState(
    editing?.lifecycleEvents ?? false,
  );
  const [secret, setSecret] = useState<string | null>(null);

  const create = useNotificationMutation(
    (input: { name: string; url: string; lifecycleEvents: boolean }) =>
      createWebhookFn({ data: input }),
    {
      success: t('notifications.webhook.added'),
      onSuccess: (result) => setSecret(result.secret),
    },
  );
  const update = useNotificationMutation(
    (input: {
      id: string;
      name: string;
      url: string;
      lifecycleEvents: boolean;
    }) => updateDestinationFn({ data: input }),
    {
      success: t('notifications.webhook.updated'),
      onSuccess: () => onClose(),
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (editing) update.mutate({ id: editing.id, name, url, lifecycleEvents });
    else create.mutate({ name, url, lifecycleEvents });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        editing
          ? t('notifications.webhook.edit')
          : secret
            ? t('notifications.webhook.added')
            : t('notifications.webhook.add')
      }
      centered
      closeOnClickOutside={!secret}
    >
      {secret ? (
        <Stack gap="md">
          <Text size="sm">
            <Trans
              t={t}
              i18nKey="notifications.webhook.signing"
              components={{
                header: <code />,
                signed: <code>{'<x-hatch-timestamp>.<body>'}</code>,
              }}
            />
          </Text>
          <SecretReveal kind="signingSecret" secret={secret} />
          <Group justify="flex-end">
            <Button onClick={onClose}>{t('common.done')}</Button>
          </Group>
        </Stack>
      ) : (
        <form onSubmit={submit}>
          <Stack gap="md">
            <TextInput
              label={t('common.name')}
              placeholder={t('notifications.webhook.namePlaceholder')}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              maxLength={80}
              data-autofocus
            />
            <TextInput
              label={t('notifications.webhook.url')}
              placeholder="https://example.com/hooks/hatch"
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              required
              type="url"
              description={t('notifications.webhook.urlDescription')}
            />
            <Checkbox
              label={t('notifications.webhook.lifecycle')}
              description={t('notifications.webhook.lifecycleDescription')}
              checked={lifecycleEvents}
              onChange={(event) =>
                setLifecycleEvents(event.currentTarget.checked)
              }
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                loading={create.isPending || update.isPending}
              >
                {editing ? t('common.save') : t('notifications.webhook.add')}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

function RotatedSecretModal({
  secret,
  onClose,
}: {
  secret: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      opened={secret !== null}
      onClose={onClose}
      title={t('notifications.webhook.newSecret')}
      centered
      closeOnClickOutside={false}
    >
      {secret ? (
        <Stack gap="md">
          <Text size="sm">{t('notifications.webhook.secretRotated')}</Text>
          <SecretReveal kind="signingSecret" secret={secret} />
          <Group justify="flex-end">
            <Button onClick={onClose}>{t('common.done')}</Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}

function RenameDeviceModal({
  device,
  onClose,
}: {
  device: DestinationView;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(device.name);
  const rename = useNotificationMutation(
    (input: { id: string; name: string }) =>
      updateDestinationFn({ data: input }),
    {
      success: t('notifications.device.renamed'),
      onSuccess: () => onClose(),
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate({ id: device.id, name: name.trim() });
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={t('notifications.device.rename')}
      centered
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label={t('common.name')}
            description={t('notifications.device.nameDescription')}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
            required
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              loading={rename.isPending}
              disabled={!name.trim()}
            >
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function DestinationsSection() {
  const { t } = useI18n();
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [webhookModal, setWebhookModal] = useState<{
    editing: DestinationView | null;
  } | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<DestinationView | null>(null);

  const toggle = useNotificationMutation(
    (input: { id: string; enabled: boolean }) =>
      updateDestinationFn({ data: input }),
  );
  const test = useNotificationMutation(
    (id: string) => sendTestNotificationFn({ data: id }),
    { success: t('notifications.destinations.testSent') },
  );
  const rotate = useNotificationMutation(
    (id: string) => rotateWebhookSecretFn({ data: id }),
    { onSuccess: (result) => setRotated(result.secret) },
  );
  const remove = useNotificationMutation(
    (id: string) => deleteDestinationFn({ data: id }),
    { success: t('notifications.destinations.removed') },
  );

  const confirmRotate = (destination: DestinationView) =>
    modals.openConfirmModal({
      title: t('notifications.webhook.rotateTitle', { name: destination.name }),
      centered: true,
      children: <Text size="sm">{t('notifications.webhook.rotateBody')}</Text>,
      labels: {
        confirm: t('notifications.webhook.rotate'),
        cancel: t('common.cancel'),
      },
      onConfirm: () => rotate.mutate(destination.id),
    });

  const confirmDelete = (destination: DestinationView) =>
    modals.openConfirmModal({
      title: t('notifications.destinations.removeTitle', {
        name: destination.name,
      }),
      centered: true,
      children: (
        <Text size="sm">
          {destination.type === 'device'
            ? t('notifications.destinations.removeDevice')
            : t('notifications.destinations.removeWebhook')}
        </Text>
      ),
      labels: { confirm: t('common.remove'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(destination.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title={t('notifications.destinations.title')}
        description={t('notifications.destinations.description')}
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setWebhookModal({ editing: null })}
          >
            {t('notifications.webhook.add')}
          </Button>
        }
      />
      <ApnsStatusLine />

      {destinations.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          {t('notifications.destinations.empty')}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620} type="native">
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>
                  {t('notifications.destinations.column.destination')}
                </Table.Th>
                <Table.Th w={90}>{t('common.enabled')}</Table.Th>
                <Table.Th w={48} aria-label={t('common.actions')} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {destinations.map((destination) => (
                <Table.Tr key={destination.id}>
                  <Table.Td>
                    <Group gap="sm" wrap="nowrap" align="flex-start">
                      <Box c="dimmed" pt={2} style={{ display: 'inline-flex' }}>
                        <DestinationTypeIcon type={destination.type} />
                      </Box>
                      <Stack gap={0} miw={0}>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" fw={700} truncate>
                            {destination.name}
                          </Text>
                          <Badge size="xs" variant="light" color="gray">
                            {t(DESTINATION_TYPE_LABEL[destination.type])}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed" truncate>
                          {describe(t, destination)}
                        </Text>
                        {destination.lastError ? (
                          <Text size="xs" c="red.8">
                            {destination.lastError}
                          </Text>
                        ) : null}
                      </Stack>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={
                        toggle.isPending &&
                        toggle.variables?.id === destination.id
                          ? toggle.variables.enabled
                          : destination.enabled
                      }
                      onChange={(event) =>
                        toggle.mutate({
                          id: destination.id,
                          enabled: event.currentTarget.checked,
                        })
                      }
                      aria-label={t('notifications.enableName', {
                        name: destination.name,
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
                            name: destination.name,
                          })}
                        >
                          <IconDotsVertical size={16} stroke={1.6} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconSend size={14} stroke={1.6} />}
                          disabled={!destination.enabled}
                          onClick={() => test.mutate(destination.id)}
                        >
                          {t('notifications.destinations.sendTest')}
                        </Menu.Item>
                        {destination.type === 'device' ? (
                          <Menu.Item
                            leftSection={<IconPencil size={14} stroke={1.6} />}
                            onClick={() => setRenaming(destination)}
                          >
                            {t('common.rename')}
                          </Menu.Item>
                        ) : null}
                        {destination.type === 'webhook' ? (
                          <>
                            <Menu.Item
                              leftSection={
                                <IconPencil size={14} stroke={1.6} />
                              }
                              onClick={() =>
                                setWebhookModal({ editing: destination })
                              }
                            >
                              {t('common.edit')}
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconKey size={14} stroke={1.6} />}
                              onClick={() => confirmRotate(destination)}
                            >
                              {t('notifications.webhook.rotate')}
                            </Menu.Item>
                          </>
                        ) : null}
                        {destination.type !== 'app' ? (
                          <Menu.Item
                            color="red"
                            leftSection={<IconTrash size={14} stroke={1.6} />}
                            onClick={() => confirmDelete(destination)}
                          >
                            {t('common.remove')}
                          </Menu.Item>
                        ) : null}
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {webhookModal ? (
        <WebhookModal
          key={webhookModal.editing?.id ?? 'new'}
          opened
          editing={webhookModal.editing}
          onClose={() => setWebhookModal(null)}
        />
      ) : null}
      {renaming ? (
        <RenameDeviceModal
          key={renaming.id}
          device={renaming}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      <RotatedSecretModal secret={rotated} onClose={() => setRotated(null)} />
    </Stack>
  );
}
