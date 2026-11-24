import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconBell } from '@tabler/icons-react';
import { Trans } from 'react-i18next';
import { useI18n } from '~i18n';
import type { NormalizedManifest } from '~server/apps/manifest';
import { SectionHeader } from './section-header';

/** Read-only view of what the live deployment declares for notifications. */
export function NotificationsSection({
  notifications,
}: {
  notifications: NonNullable<NormalizedManifest['notifications']>;
}) {
  const { t } = useI18n();
  const count = notifications.kinds.length;
  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconBell size={16} stroke={1.8} />}
        title={t('ops.notifications.title')}
        meta={
          <Text size="xs" c="dimmed">
            {notifications.destination
              ? t('ops.notifications.kindsAccepting', { count })
              : t('ops.notifications.kinds', { count })}
          </Text>
        }
      />
      {notifications.kinds.length > 0 ? (
        <Group gap={6}>
          {notifications.kinds.map((entry) => (
            <Badge
              key={entry.kind}
              variant="light"
              color="gray"
              radius="sm"
              title={entry.description ?? entry.kind}
            >
              {entry.name} · {entry.kind}
            </Badge>
          ))}
        </Group>
      ) : null}
      <Text size="xs" c="dimmed">
        <Trans
          t={t}
          i18nKey={
            notifications.destination
              ? 'ops.notifications.routeDestination'
              : 'ops.notifications.route'
          }
          components={{
            link: (
              <Anchor component={Link} to="/settings/notifications" size="xs" />
            ),
          }}
        />
      </Text>
    </Stack>
  );
}
