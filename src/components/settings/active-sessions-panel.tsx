import {
  Alert,
  Badge,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconAlertCircle } from '@tabler/icons-react';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { useI18n } from '~i18n';
import {
  accountSessionsQueryOptions,
  signOutSession,
  type AccountSession,
} from '~queries/account-sessions';
import classes from './active-sessions-panel.module.css';
import {
  DEVICE_ICONS,
  describeUserAgent,
  formatSessionTime,
} from './session-device';

const REVOKE_KEY = ['auth', 'account-sessions', 'revoke'];

export function ActiveSessionsPanel() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const sessions = useQuery(accountSessionsQueryOptions);

  // Failures are toasted by the global mutation handler and leave the list
  // untouched, so the same control retries.
  const revoke = useMutation({
    mutationKey: REVOKE_KEY,
    networkMode: 'always',
    retry: false,
    mutationFn: (sessionId: string) => signOutSession(sessionId),
    onSuccess: (_result, sessionId) => {
      queryClient.setQueryData(
        accountSessionsQueryOptions.queryKey,
        (current) => current?.filter((session) => session.id !== sessionId),
      );
      toast.success(t('account.sessions.signedOut'));
      // Stay pending until the list is refetched, so the controls cannot act
      // on a stale list.
      return queryClient.invalidateQueries({
        queryKey: accountSessionsQueryOptions.queryKey,
      });
    },
  });
  const revokingIds = useMutationState({
    filters: { mutationKey: REVOKE_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });

  // Read the mutation cache synchronously: a confirm dialog opened before a
  // request started must not send a duplicate.
  const isRevoking = (sessionId: string) =>
    queryClient.isMutating({
      mutationKey: REVOKE_KEY,
      predicate: (mutation) => mutation.state.variables === sessionId,
    }) > 0;

  const confirmRevoke = (session: AccountSession) => {
    const { label } = describeUserAgent(session.userAgent, t);
    modals.openConfirmModal({
      title: t('account.sessions.confirmTitle', { device: label }),
      centered: true,
      children: (
        <Text size="sm">
          {t('account.sessions.confirmBody', {
            when: formatSessionTime(session.updatedAt, locale, t),
          })}
        </Text>
      ),
      labels: {
        confirm: t('account.sessions.confirm'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        if (!isRevoking(session.id)) revoke.mutate(session.id);
      },
    });
  };

  const ordered = sessions.data
    ? // The current session leads; the rest keep newest-first order.
      [
        ...sessions.data.filter((session) => session.isCurrent),
        ...sessions.data.filter((session) => !session.isCurrent),
      ]
    : [];

  return (
    <Stack gap="md">
      <Stack gap={2}>
        <Text fw={700}>{t('account.sessions.title')}</Text>
        <Text size="sm" c="dimmed">
          {t('account.sessions.description')}
        </Text>
      </Stack>

      {sessions.isPending ? (
        <ActiveSessionsSkeleton />
      ) : sessions.isLoadingError ? (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title={t('account.sessions.loadFailed')}
          color="red"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{t('account.sessions.loadFailedBody')}</Text>
            <Button
              type="button"
              size="xs"
              variant="light"
              color="red"
              loading={sessions.isFetching}
              onClick={() => void sessions.refetch()}
            >
              {t('common.tryAgain')}
            </Button>
          </Stack>
        </Alert>
      ) : ordered.length > 0 ? (
        <ul className={classes.list} aria-label={t('account.sessions.title')}>
          {ordered.map((session) => (
            <ActiveSessionRow
              key={session.id}
              session={session}
              revoking={revokingIds.includes(session.id)}
              onRevoke={() => confirmRevoke(session)}
            />
          ))}
        </ul>
      ) : (
        <Text size="sm" c="dimmed" className={classes.empty}>
          {t('account.sessions.empty')}
        </Text>
      )}
    </Stack>
  );
}

function ActiveSessionRow({
  session,
  revoking,
  onRevoke,
}: {
  session: AccountSession;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const { t, locale } = useI18n();
  const device = describeUserAgent(session.userAgent, t);
  const DeviceIcon = DEVICE_ICONS[device.kind];
  const lastActive = formatSessionTime(session.updatedAt, locale, t);

  return (
    <li className={classes.row}>
      <Group
        gap="sm"
        wrap="nowrap"
        align="flex-start"
        className={classes.identity}
      >
        <ThemeIcon
          variant="light"
          color={session.isCurrent ? undefined : 'gray'}
          size="lg"
          radius="md"
        >
          <DeviceIcon size={18} stroke={1.7} />
        </ThemeIcon>
        <Stack gap={4} miw={0} flex={1}>
          <Group gap={8} wrap="nowrap" miw={0}>
            <Text
              size="sm"
              fw={700}
              truncate
              title={session.userAgent ?? undefined}
            >
              {device.label}
            </Text>
            {session.isCurrent && (
              <Badge size="sm" variant="light" className={classes.badge}>
                {t('account.sessions.current')}
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            <Trans
              t={t}
              i18nKey="account.sessions.lastActive"
              values={{ when: lastActive }}
              components={{ time: <time dateTime={session.updatedAt} /> }}
            />
          </Text>
        </Stack>
      </Group>

      {!session.isCurrent && (
        <Button
          type="button"
          size="xs"
          variant="subtle"
          color="red"
          aria-label={t('account.sessions.signOutName', {
            device: device.label,
            when: lastActive,
          })}
          loading={revoking}
          onClick={onRevoke}
          className={classes.action}
        >
          {t('account.sessions.signOut')}
        </Button>
      )}
    </li>
  );
}

function ActiveSessionsSkeleton() {
  const { t } = useI18n();
  return (
    <Stack gap="xs" aria-label={t('account.sessions.loading')} aria-busy>
      {[0, 1].map((key) => (
        <Group key={key} gap="sm" wrap="nowrap" py="xs">
          <Skeleton height={34} width={34} radius="md" />
          <Stack gap={5} flex={1}>
            <Skeleton height={14} width="35%" radius="sm" />
            <Skeleton height={10} width="45%" radius="sm" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}
