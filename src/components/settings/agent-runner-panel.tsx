import {
  Alert,
  Badge,
  Button,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconPlugOff, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import type { AgentRunStatus } from '~/db/schema';
import { type PlainTranslationKey, useErrorText, useI18n } from '~i18n';
import { formatDuration, formatExact, formatRelativeTime } from '~lib/format';
import type {
  ActiveAgentRunInfo,
  AgentRunLeaseState,
  AgentRunnerState,
  AgentRunnerStatusSnapshot,
  ConnectedRunnerInfo,
} from '~server/agent-runner-status';

const STATE_META: Record<
  AgentRunnerState,
  { label: PlainTranslationKey; color: string }
> = {
  connected: { label: 'agentRunner.state.connected', color: 'teal' },
  offline: { label: 'agentRunner.state.offline', color: 'gray' },
  attention: { label: 'agentRunner.state.attention', color: 'yellow' },
};

const LEASE_META: Record<
  AgentRunLeaseState,
  { label: PlainTranslationKey; color: string; hint?: PlainTranslationKey }
> = {
  live: { label: 'agentRunner.lease.live', color: 'teal' },
  expired: {
    label: 'agentRunner.lease.expired',
    color: 'red',
    hint: 'agentRunner.lease.expiredHint',
  },
  missing: {
    label: 'agentRunner.lease.missing',
    color: 'orange',
    hint: 'agentRunner.lease.missingHint',
  },
};

const RUN_STATUS_LABELS: Record<AgentRunStatus, PlainTranslationKey> = {
  running: 'agentRunner.runStatus.running',
  blocked: 'agentRunner.runStatus.blocked',
  completed: 'agentRunner.runStatus.completed',
  failed: 'agentRunner.runStatus.failed',
  cancelled: 'agentRunner.runStatus.cancelled',
  interrupted: 'agentRunner.runStatus.interrupted',
};

export type AgentRunnerPanelProps = {
  snapshot: AgentRunnerStatusSnapshot | undefined;
  /** True during the very first load (no data yet). */
  isLoading: boolean;
  error: Error | null;
  onRefresh: () => Promise<unknown> | void;
};

export function AgentRunnerPanel({
  snapshot,
  isLoading,
  error,
  onRefresh,
}: AgentRunnerPanelProps) {
  const { t, locale } = useI18n();
  if (isLoading) return <PanelSkeleton />;
  if (!snapshot) return <LoadFailed error={error} onRefresh={onRefresh} />;
  return (
    <Stack gap="xl">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Badge
            size="lg"
            radius="sm"
            variant="light"
            color={STATE_META[snapshot.state].color}
          >
            {t(STATE_META[snapshot.state].label)}
          </Badge>
          {error ? (
            <Text size="xs" c="red">
              {t('agentRunner.refreshFailed')}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              {t('agentRunner.updated', {
                when: formatRelativeTime(snapshot.generatedAt, locale),
              })}
            </Text>
          )}
        </Group>
        <RefreshButton onRefresh={onRefresh} />
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg">
        <Stat
          label={t('agentRunner.stats.connectedRunners')}
          value={snapshot.summary.connectedRunners}
        />
        <Stat
          label={t('agentRunner.stats.activeRuns')}
          value={snapshot.summary.activeRuns}
        />
        <Stat
          label={t('agentRunner.stats.blockedRuns')}
          value={snapshot.summary.blockedRuns}
        />
        <Stat
          label={t('agentRunner.stats.staleLeases')}
          value={snapshot.summary.staleLeases}
        />
      </SimpleGrid>

      <Stack gap="xs">
        <Group justify="space-between" align="baseline">
          <Text fw={700}>{t('agentRunner.runners.title')}</Text>
          <Text size="xs" c="dimmed">
            {t('agentRunner.runners.timing', {
              heartbeat: formatDuration(snapshot.summary.heartbeatIntervalMs),
              ttl: formatDuration(snapshot.summary.leaseTtlMs),
            })}
          </Text>
        </Group>
        {snapshot.runners.length === 0 ? (
          <Alert
            variant="light"
            color="gray"
            icon={<IconPlugOff size={18} stroke={1.6} />}
          >
            {t('agentRunner.runners.empty')}
          </Alert>
        ) : (
          <RunnersTable runners={snapshot.runners} />
        )}
      </Stack>

      <Stack gap="xs">
        <Text fw={700}>{t('agentRunner.stats.activeRuns')}</Text>
        {snapshot.activeRuns.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('agentRunner.runs.empty')}
          </Text>
        ) : (
          <ActiveRunsTable runs={snapshot.activeRuns} />
        )}
      </Stack>
    </Stack>
  );
}

function RefreshButton({
  onRefresh,
}: {
  onRefresh: AgentRunnerPanelProps['onRefresh'];
}) {
  // Local busy state instead of the query's isFetching: the page also polls
  // every 5 seconds and the button must not blink on every background tick.
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="default"
      size="xs"
      leftSection={<IconRefresh size={14} stroke={1.8} />}
      loading={busy}
      onClick={() => {
        setBusy(true);
        void Promise.resolve(onRefresh()).finally(() => setBusy(false));
      }}
    >
      {t('common.refresh')}
    </Button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={26} fw={700} lh={1.2}>
        {value}
      </Text>
    </Stack>
  );
}

/** Relative timestamp with the exact time in a tooltip. */
function TimeCell({ value }: { value: string }) {
  const { locale } = useI18n();
  return (
    <Tooltip label={formatExact(value)} withArrow>
      <Text size="sm" c="dimmed" style={{ cursor: 'default' }}>
        {formatRelativeTime(value, locale)}
      </Text>
    </Tooltip>
  );
}

function RunnersTable({ runners }: { runners: ConnectedRunnerInfo[] }) {
  const { t } = useI18n();
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('agentRunner.runners.id')}</Table.Th>
            <Table.Th>{t('agentRunner.runners.protocol')}</Table.Th>
            <Table.Th>{t('agentRunner.stats.activeRuns')}</Table.Th>
            <Table.Th>{t('agentRunner.runners.connectedSince')}</Table.Th>
            <Table.Th>{t('agentRunner.runners.lastSeen')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runners.map((runner) => (
            <Table.Tr key={runner.runnerId}>
              <Table.Td>
                <Text size="sm" ff="monospace">
                  {runner.runnerId}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  v{runner.protocolVersion}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{runner.activeRunCount}</Text>
              </Table.Td>
              <Table.Td>
                <TimeCell value={runner.connectedAt} />
              </Table.Td>
              <Table.Td>
                <TimeCell value={runner.lastSeenAt} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function ActiveRunsTable({ runs }: { runs: ActiveAgentRunInfo[] }) {
  const { t } = useI18n();
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('agentRunner.runs.chat')}</Table.Th>
            <Table.Th>{t('common.status')}</Table.Th>
            <Table.Th>{t('agentRunner.runs.runner')}</Table.Th>
            <Table.Th>{t('agentRunner.runs.lease')}</Table.Th>
            <Table.Th>{t('agentRunner.runs.started')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runs.map((run) => (
            <Table.Tr key={run.runId}>
              <Table.Td maw={280}>
                <Text
                  size="sm"
                  fw={600}
                  truncate
                  renderRoot={(props) => (
                    <Link
                      to="/agent/$threadId"
                      params={{ threadId: run.sessionId }}
                      {...props}
                    />
                  )}
                >
                  {run.sessionTitle}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  variant="light"
                  color={run.status === 'blocked' ? 'yellow' : 'teal'}
                >
                  {t(RUN_STATUS_LABELS[run.status])}
                </Badge>
              </Table.Td>
              <Table.Td>
                <RunRunnerCell run={run} />
              </Table.Td>
              <Table.Td>
                <LeaseBadge lease={run.lease} />
              </Table.Td>
              <Table.Td>
                <TimeCell value={run.startedAt} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function RunRunnerCell({ run }: { run: ActiveAgentRunInfo }) {
  const { t } = useI18n();
  if (!run.runnerId) {
    return (
      <Text size="sm" c="dimmed">
        {t('agentRunner.runs.dispatching')}
      </Text>
    );
  }
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" ff="monospace">
        {run.runnerId}
      </Text>
      {!run.runnerConnected && (
        <Tooltip label={t('agentRunner.runs.runnerOfflineHint')} withArrow>
          <Badge size="xs" variant="light" color="gray">
            {t('agentRunner.runs.runnerOffline')}
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

function LeaseBadge({ lease }: { lease: AgentRunLeaseState }) {
  const { t } = useI18n();
  const meta = LEASE_META[lease];
  const badge = (
    <Badge size="sm" variant="light" color={meta.color}>
      {t(meta.label)}
    </Badge>
  );
  if (!meta.hint) return badge;
  return (
    <Tooltip label={t(meta.hint)} withArrow multiline maw={320}>
      {badge}
    </Tooltip>
  );
}

function LoadFailed({
  error,
  onRefresh,
}: {
  error: Error | null;
  onRefresh: AgentRunnerPanelProps['onRefresh'];
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  return (
    <Alert variant="light" color="red" title={t('agentRunner.loadFailed')}>
      <Stack gap="sm" align="flex-start">
        <Text size="sm">
          {error
            ? errorText(error, 'agentRunner.loadFailedBody')
            : t('agentRunner.unknownError')}
        </Text>
        <RefreshButton onRefresh={onRefresh} />
      </Stack>
    </Alert>
  );
}

function PanelSkeleton() {
  return (
    <Stack gap="xl" data-testid="agent-runner-loading">
      <Group justify="space-between">
        <Skeleton height={26} width={130} radius="sm" />
        <Skeleton height={30} width={92} radius="sm" />
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg">
        {[0, 1, 2, 3].map((i) => (
          <Stack key={i} gap={6}>
            <Skeleton height={12} width={110} radius="sm" />
            <Skeleton height={26} width={40} radius="sm" />
          </Stack>
        ))}
      </SimpleGrid>
      <Stack gap="xs">
        <Skeleton height={18} width={80} radius="sm" />
        <Skeleton height={96} radius="md" />
      </Stack>
      <Stack gap="xs">
        <Skeleton height={18} width={100} radius="sm" />
        <Skeleton height={96} radius="md" />
      </Stack>
    </Stack>
  );
}
