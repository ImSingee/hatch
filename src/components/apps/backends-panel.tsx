import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconServerBolt, IconSettings } from '@tabler/icons-react';
import { AppGlyph } from '~components/apps/app-glyph';
import {
  BackendControls,
  BackendLastExit,
  BackendStatus,
  BackendTime,
} from '~components/apps/backend-controls';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { appBackendsQueryOptions } from '~queries/apps';
import type { AppBackendView } from '~server/apps';

const MODE_LABELS: Record<AppBackendView['mode'], PlainTranslationKey> = {
  serverless: 'backends.mode.serverless',
  'long-running': 'backends.mode.longRunning',
};

export function BackendsPanel() {
  const { t } = useI18n();
  const { data: backends } = useSuspenseQuery(appBackendsQueryOptions);

  if (backends.length === 0) {
    return (
      <Stack align="center" gap="xs" py={80} px="md">
        <ThemeIcon size={52} radius="xl" variant="light" color="primary">
          <IconServerBolt size={26} stroke={1.5} />
        </ThemeIcon>
        <Text fw={700} mt="xs">
          {t('backends.empty.title')}
        </Text>
        <Text size="sm" c="dimmed" ta="center" maw={440}>
          {t('backends.empty.body')}
        </Text>
        <Button component={Link} to="/apps" mt="md" variant="default">
          {t('backends.empty.backToApps')}
        </Button>
      </Stack>
    );
  }

  return (
    <Table.ScrollContainer minWidth={1080}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('backends.column.app')}</Table.Th>
            <Table.Th>{t('common.status')}</Table.Th>
            <Table.Th>{t('backends.column.mode')}</Table.Th>
            <Table.Th>{t('backends.column.pidPort')}</Table.Th>
            <Table.Th>{t('backends.column.started')}</Table.Th>
            <Table.Th>{t('backends.column.lastStopped')}</Table.Th>
            <Table.Th>{t('backends.column.lastExit')}</Table.Th>
            <Table.Th w={150} aria-label={t('common.actions')} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {backends.map((backend) => (
            <BackendRow key={backend.id} backend={backend} />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function BackendRow({ backend }: { backend: AppBackendView }) {
  const { t } = useI18n();
  const { runtime } = backend;
  const running = runtime.state === 'running';

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <AppGlyph name={backend.name} seed={backend.id} />
          <Stack gap={0} miw={0}>
            <Text
              size="sm"
              fw={700}
              truncate
              renderRoot={(props) => (
                <Link
                  to="/app/$appSlug/manage"
                  params={{ appSlug: backend.slug }}
                  {...props}
                />
              )}
            >
              {backend.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {backend.slug}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <BackendStatus runtime={runtime} />
      </Table.Td>
      <Table.Td>
        <Badge
          size="sm"
          variant="light"
          color={backend.mode === 'long-running' ? 'primary' : 'gray'}
        >
          {t(MODE_LABELS[backend.mode])}
        </Badge>
      </Table.Td>
      <Table.Td>
        {running && runtime.pid != null ? (
          <Text size="sm" ff="monospace">
            {runtime.pid} · :{runtime.port}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <BackendTime value={runtime.startedAt} />
      </Table.Td>
      <Table.Td>
        <BackendTime value={runtime.stoppedAt} />
      </Table.Td>
      <Table.Td>
        <BackendLastExit runtime={runtime} />
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          <BackendControls
            appId={backend.id}
            runtime={runtime}
            name={backend.name}
            runtimeSupported={backend.compatibility?.isSupported ?? false}
          />
          <Tooltip label={t('backends.manageApp')} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              renderRoot={(props) => (
                <Link
                  to="/app/$appSlug/manage"
                  params={{ appSlug: backend.slug }}
                  {...props}
                />
              )}
              aria-label={t('backends.manageNamed', { name: backend.name })}
            >
              <IconSettings size={16} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
