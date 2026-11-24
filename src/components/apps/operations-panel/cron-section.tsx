import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconClock, IconHistory, IconPlayerPlay } from '@tabler/icons-react';
import { toast } from 'sonner';
import { useI18n, type PlainTranslationKey } from '~i18n';
import { formatDuration, formatExact, formatRelativeTime } from '~lib/format';
import { appOpsQueryOptions, cronRunsQueryOptions } from '~queries/apps';
import type { AppOps } from '~server/apps';
import { runCronJobFn } from '~server/apps';
import { SectionHeader } from './section-header';

const CRON_TRIGGER_LABELS: Record<string, PlainTranslationKey> = {
  scheduled: 'ops.cron.trigger.scheduled',
  manual: 'ops.cron.trigger.manual',
};

// Recent cron-trigger history (scheduled fires + manual "Run now"), newest
// first. Distinct from the backend log stream: structured per-run rows with
// trigger, status, and duration.
function CronHistory({ appId }: { appId: string }) {
  const { t, locale } = useI18n();
  const query = useQuery(cronRunsQueryOptions(appId));
  const runs = query.data ?? [];

  return (
    <Stack gap={6}>
      <Group gap={8} wrap="nowrap">
        <IconHistory size={16} stroke={1.8} />
        <Text fw={700} size="sm">
          {t('ops.cron.history')}
        </Text>
        {runs.length > 0 ? (
          <Text size="xs" c="dimmed">
            {runs.length}
          </Text>
        ) : null}
      </Group>
      {query.isLoading ? (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      ) : runs.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t('ops.cron.historyEmpty')}
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('ops.cron.column.job')}</Table.Th>
              <Table.Th w={110}>{t('executions.column.trigger')}</Table.Th>
              <Table.Th w={90}>{t('executions.column.status')}</Table.Th>
              <Table.Th w={80}>{t('executions.column.duration')}</Table.Th>
              <Table.Th w={120}>{t('ops.cron.column.when')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {runs.map((run) => (
              <Table.Tr key={run.id}>
                <Table.Td>
                  <Text size="sm" fw={600} truncate>
                    {run.jobName}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="default">
                    {CRON_TRIGGER_LABELS[run.trigger]
                      ? t(CRON_TRIGGER_LABELS[run.trigger])
                      : run.trigger}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="xs"
                    variant="light"
                    color={run.ok ? 'teal' : 'red'}
                  >
                    {run.ok
                      ? t('ops.cron.result.ok')
                      : t('ops.cron.result.fail')}
                    {run.status != null ? ` ${run.status}` : ''}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {formatDuration(run.durationMs)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip
                    label={formatExact(run.createdAt)}
                    withArrow
                    position="left"
                  >
                    <Text size="xs" c="dimmed">
                      {formatRelativeTime(run.createdAt, locale)}
                    </Text>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

/** Declared cron jobs with a manual "Run now" trigger, plus run history. */
export function CronSection({
  appId,
  cron,
  runtimeSupported = true,
}: {
  appId: string;
  cron: AppOps['cron'];
  runtimeSupported?: boolean;
}) {
  const qc = useQueryClient();
  const { t, locale } = useI18n();

  const runCron = useMutation({
    mutationFn: (name: string) => runCronJobFn({ data: { id: appId, name } }),
    onSuccess: (res, name) => {
      if (res.status >= 200 && res.status < 300) {
        toast.success(t('ops.cron.toast.ran', { name, status: res.status }));
      } else {
        toast.error(t('ops.cron.toast.returned', { name, status: res.status }));
      }
    },
    // A manual run records a history row on BOTH paths: success returns an HTTP
    // status, but a thrown failure (backend unreachable) also writes a `manual`
    // row and rethrows into onError. Invalidate in onSettled so the new row
    // shows immediately whether the call succeeded or threw.
    onSettled: () => {
      void qc.invalidateQueries(appOpsQueryOptions(appId));
      void qc.invalidateQueries(cronRunsQueryOptions(appId));
    },
  });

  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconClock size={16} stroke={1.8} />}
        title={t('ops.cron.title')}
      />
      {cron.jobs.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t('ops.cron.empty')}
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Tbody>
            {cron.jobs.map((job) => (
              <Table.Tr key={job.name}>
                <Table.Td>
                  <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
                    {job.name}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text
                    size="xs"
                    c="dimmed"
                    ff="monospace"
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {job.schedule}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap" align="center">
                    <Badge
                      size="xs"
                      variant="light"
                      color={job.method ? 'blue' : 'gray'}
                      style={{ flex: 'none' }}
                    >
                      {job.method
                        ? t('ops.cron.target.rpc')
                        : t('ops.cron.target.path')}
                    </Badge>
                    <Text size="xs" c="dimmed" ff="monospace" truncate>
                      {job.method ?? job.path}
                      {job.nextRun
                        ? ` · ${t('ops.cron.next', {
                            when: formatRelativeTime(job.nextRun, locale),
                          })}`
                        : ''}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td w={110}>
                  <Button
                    size="compact-sm"
                    variant="light"
                    leftSection={<IconPlayerPlay size={14} />}
                    loading={
                      runCron.isPending && runCron.variables === job.name
                    }
                    disabled={!runtimeSupported}
                    onClick={() => runCron.mutate(job.name)}
                  >
                    {t('ops.cron.runNow')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <CronHistory appId={appId} />
    </Stack>
  );
}
