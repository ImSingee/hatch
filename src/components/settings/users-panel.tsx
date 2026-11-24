import {
  ActionIcon,
  Badge,
  Divider,
  Group,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { UserAvatar } from '~components/auth/user-avatar';
import { useI18n } from '~i18n';
import { usersPanelQueryOptions } from '~queries/users';
import {
  deleteUser,
  updateAllowSignup,
  type PlatformUser,
} from '~server/users';

export function UsersPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(usersPanelQueryOptions);

  const toggleSignup = useMutation({
    mutationFn: (allowSignup: boolean) =>
      updateAllowSignup({ data: { allowSignup } }),
    onSuccess: async ({ allowSignup }) => {
      await qc.invalidateQueries({
        queryKey: usersPanelQueryOptions.queryKey,
      });
      toast.success(
        allowSignup
          ? t('settings.users.signupEnabled')
          : t('settings.users.signupDisabled'),
      );
    },
  });

  const removeUser = useMutation({
    mutationFn: (userId: string) => deleteUser({ data: { userId } }),
    // Invalidate on failure too (error toast comes from the global mutation
    // handler): "User not found" / "last user" mean the list changed under
    // us, so refetch it.
    onSettled: () =>
      qc.invalidateQueries({ queryKey: usersPanelQueryOptions.queryKey }),
    onSuccess: () => toast.success(t('settings.users.deleted')),
  });

  const confirmDelete = (user: PlatformUser) =>
    modals.openConfirmModal({
      title: t('settings.users.confirmTitle', {
        name: user.name || user.email,
      }),
      centered: true,
      children: <Text size="sm">{t('settings.users.confirmBody')}</Text>,
      labels: {
        confirm: t('settings.users.delete'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => removeUser.mutate(user.id),
    });

  return (
    <Stack gap="md">
      <Group justify="space-between" gap="md" py="xs" wrap="nowrap">
        <Stack gap={2}>
          <Text fw={700}>{t('settings.users.allowSignup')}</Text>
          <Text size="sm" c="dimmed">
            {t('settings.users.allowSignupDescription')}
          </Text>
        </Stack>
        <Switch
          size="md"
          // While the mutation is in flight, show the state being requested
          // instead of the (still-unchanged) query data. On failure the
          // global mutation toast reports it and the switch snaps back to
          // the cached server value.
          checked={
            toggleSignup.isPending
              ? (toggleSignup.variables ?? data.allowSignup)
              : data.allowSignup
          }
          disabled={toggleSignup.isPending}
          onChange={(event) => toggleSignup.mutate(event.currentTarget.checked)}
          aria-label={t('settings.users.allowSignup')}
        />
      </Group>

      <Divider />

      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('settings.users.columnUser')}</Table.Th>
            <Table.Th>{t('settings.users.columnJoined')}</Table.Th>
            <Table.Th w={48} aria-label={t('common.actions')} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isCurrent={user.id === data.currentUserId}
              deleting={
                removeUser.isPending && removeUser.variables === user.id
              }
              onDelete={() => confirmDelete(user)}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function UserRow({
  user,
  isCurrent,
  deleting,
  onDelete,
}: {
  user: PlatformUser;
  isCurrent: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <UserAvatar
            userId={user.id}
            image={user.image}
            name={user.name || user.email}
            size={36}
          />
          <Stack gap={0} miw={0}>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={700} truncate>
                {user.name || user.email}
              </Text>
              {isCurrent && (
                <Badge size="xs" variant="light">
                  {t('settings.users.you')}
                </Badge>
              )}
              {user.emailVerified && (
                <Badge size="xs" variant="light" color="teal">
                  {t('settings.users.verified')}
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" truncate>
              {user.email}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
            new Date(user.createdAt),
          )}
        </Text>
      </Table.Td>
      <Table.Td>
        {isCurrent ? (
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled
            aria-label={t('settings.users.cannotDeleteSelf')}
          >
            <IconTrash size={16} stroke={1.6} />
          </ActionIcon>
        ) : (
          <Tooltip label={t('settings.users.delete')} withArrow>
            <ActionIcon
              variant="subtle"
              color="red"
              loading={deleting}
              onClick={onDelete}
              aria-label={t('settings.users.deleteName', { email: user.email })}
            >
              <IconTrash size={16} stroke={1.6} />
            </ActionIcon>
          </Tooltip>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
