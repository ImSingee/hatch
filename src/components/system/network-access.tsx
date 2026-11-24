import { Code, Group, Stack, Text } from '@mantine/core';
import type { NetworkAccessView } from '~/network-policy';
import { useI18n } from '~i18n';

export function NetworkAccessDetails({
  access,
  appPlatformChannels = false,
}: {
  access: NetworkAccessView | null;
  appPlatformChannels?: boolean;
}) {
  const { t } = useI18n();
  if (!access) {
    return (
      <Text size="sm" c="dimmed">
        {t('permissions.notDeployed')}
      </Text>
    );
  }

  const summary =
    access.mode === 'blocked'
      ? t('network.blocked')
      : access.mode === 'restricted'
        ? t('network.restricted')
        : access.legacy
          ? t('network.unrestrictedLegacy')
          : t('network.unrestricted');

  return (
    <Stack gap={5} style={{ minWidth: 0 }}>
      <Text size="sm">{summary}</Text>
      {access.destinations.length > 0 ? (
        <Group gap={6} wrap="wrap">
          {access.destinations.map((destination) => (
            <Code key={destination}>{destination}</Code>
          ))}
        </Group>
      ) : null}
      <Text size="xs" c="dimmed">
        {appPlatformChannels
          ? t('network.coverageWithPlatformChannels')
          : t('network.coverage')}
      </Text>
    </Stack>
  );
}
