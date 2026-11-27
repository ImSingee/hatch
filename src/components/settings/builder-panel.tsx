import {
  Badge,
  Button,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconHammer, IconListCheck } from '@tabler/icons-react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { CANCELABLE, STATUS } from '~components/apps/deployment-status';
import { GroupCard, Section } from '~components/page/page';
import { useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import {
  builderOverviewQueryOptions,
  deploymentRequestsQueryOptions,
} from '~queries/apps';
import { type BuilderOverview, cancelAppDeploymentFn } from '~server/apps';

type Status = BuilderOverview['status'];
type Entry = BuilderOverview['queue'][number];

/**
 * The dedicated Builders and every unfinished deployment of every App, in
 * the order they were requested; a queued, waiting or building one can be
 * canceled from here.
 */
export function BuilderPanel() {
  const { t } = useI18n();
  const { data } = useSuspenseQuery(builderOverviewQueryOptions);
  const online = data.status.builders.filter((builder) => builder.online);
  return (
    <Stack gap="xl">
      <Section
        title={t('settings.builder.builders.title')}
        meta={
          data.status.configured
            ? t('settings.builder.builders.online', { count: online.length })
            : undefined
        }
      >
        <BuilderStatus status={data.status} anyOnline={online.length > 0} />
      </Section>
      <Section
        title={t('settings.builder.queue.title')}
        meta={t('settings.builder.queue.count', { count: data.queue.length })}
        note={
          data.truncated
            ? t('settings.builder.queue.truncated', {
                count: data.queue.length,
              })
            : t('settings.builder.queue.note')
        }
      >
        {data.queue.length === 0 ? (
          <GroupCard padded>
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon size={32} radius="xl" variant="light" color="gray">
                <IconListCheck size={18} stroke={1.6} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                {t('settings.builder.queue.empty')}
              </Text>
            </Group>
          </GroupCard>
        ) : (
          <GroupCard>
            <Table.ScrollContainer minWidth={900}>
              <Table verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={56}>
                      {t('settings.builder.queue.column.position')}
                    </Table.Th>
                    <Table.Th>
                      {t('settings.builder.queue.column.app')}
                    </Table.Th>
                    <Table.Th>{t('common.status')}</Table.Th>
                    <Table.Th>
                      {t('settings.builder.queue.column.deployment')}
                    </Table.Th>
                    <Table.Th>
                      {t('settings.builder.queue.column.requested')}
                    </Table.Th>
                    <Table.Th w={110} aria-label={t('common.actions')} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.queue.map((entry) => (
                    <QueueRow key={entry.deployment.id} entry={entry} />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </GroupCard>
        )}
      </Section>
    </Stack>
  );
}

function BuilderStatus({
  status,
  anyOnline,
}: {
  status: Status;
  anyOnline: boolean;
}) {
  const { t, locale } = useI18n();
  if (!status.configured) {
    return (
      <GroupCard padded dashed>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ThemeIcon size={32} radius="xl" variant="light" color="gray">
            <IconHammer size={18} stroke={1.6} />
          </ThemeIcon>
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              {t('settings.builder.notConfigured.title')}
            </Text>
            <Text size="sm" c="dimmed">
              {t('settings.builder.notConfigured.body')}
            </Text>
          </Stack>
        </Group>
      </GroupCard>
    );
  }
  return (
    <Stack gap="sm">
      {anyOnline ? null : (
        <Text component="output" size="sm" c="orange" display="block">
          {t('settings.builder.offline')}
        </Text>
      )}
      {status.builders.length === 0 ? null : (
        <GroupCard>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('settings.builder.builders.column.id')}</Table.Th>
                <Table.Th>{t('common.status')}</Table.Th>
                <Table.Th>
                  {t('settings.builder.builders.column.running')}
                </Table.Th>
                <Table.Th>
                  {t('settings.builder.builders.column.lastSeen')}
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {status.builders.map((builder) => (
                <Table.Tr key={builder.id}>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {builder.id}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="sm"
                      variant="light"
                      color={builder.online ? 'green' : 'gray'}
                    >
                      {t(
                        builder.online
                          ? 'settings.builder.builders.statusOnline'
                          : 'settings.builder.builders.statusOffline',
                      )}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {t('settings.builder.builders.slots', {
                        running: builder.running,
                        concurrency: builder.concurrency,
                      })}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {formatRelativeTime(builder.lastSeenAt, locale)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </GroupCard>
      )}
    </Stack>
  );
}

function QueueRow({ entry }: { entry: Entry }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { app, deployment } = entry;
  const status = STATUS[deployment.status] ?? STATUS.failed;
  const cancel = useMutation({
    mutationFn: () =>
      cancelAppDeploymentFn({
        data: { id: app.id, deploymentId: deployment.id },
      }),
    onSuccess: () => toast.success(t('deployments.request.canceled')),
    onError: () => toast.error(t('deployments.request.cancelFailed')),
    onSettled: () => {
      void qc.invalidateQueries(builderOverviewQueryOptions);
      void qc.invalidateQueries(deploymentRequestsQueryOptions(app.id));
    },
  });
  return (
    <Table.Tr>
      <Table.Td>
        <Text
          size="sm"
          ff="monospace"
          c={entry.queuePosition ? undefined : 'dimmed'}
        >
          {entry.queuePosition ? `#${entry.queuePosition}` : '—'}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <AppGlyph name={app.name} seed={app.id} />
          <Stack gap={0} miw={0}>
            <Text
              size="sm"
              fw={700}
              truncate
              renderRoot={(props) => (
                <Link
                  to="/app/$appSlug/manage"
                  params={{ appSlug: app.slug }}
                  {...props}
                />
              )}
            >
              {app.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {app.slug}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <Stack gap={2} align="flex-start">
          <Badge
            size="sm"
            variant="light"
            color={status.color}
            leftSection={status.active ? <Loader size={10} /> : undefined}
          >
            {t(status.label)}
          </Badge>
          <Text size="xs" c="dimmed">
            {entry.builderId
              ? t('settings.builder.queue.onBuilder', { id: entry.builderId })
              : t(
                  deployment.build === 'builder'
                    ? 'deployments.request.build.builder'
                    : 'deployments.request.build.local',
                )}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap={0} miw={0}>
          <Text size="sm" lineClamp={1}>
            {deployment.message}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {deployment.commit.slice(0, 7)}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {formatRelativeTime(deployment.createdAt, locale)}
        </Text>
      </Table.Td>
      <Table.Td>
        {CANCELABLE.has(deployment.status) ? (
          <Button
            size="compact-sm"
            variant="default"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
            aria-label={t('settings.builder.queue.cancelNamed', {
              name: app.name,
            })}
          >
            {t('deployments.request.cancel')}
          </Button>
        ) : null}
      </Table.Td>
    </Table.Tr>
  );
}
