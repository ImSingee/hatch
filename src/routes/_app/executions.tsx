import { Button, Group, Table, Text, ThemeIcon } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { IconTimeline } from '@tabler/icons-react';
import { DeskWindow } from '~components/desk/window';
import {
  EmptyState,
  TableCard,
  Toolbar,
  WindowBody,
} from '~components/page/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { RunStatusBadge } from '~components/runs/run-status';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { formatDuration, formatRelative } from '~lib/format';
import { isActiveRun, type RunListItem } from '~lib/runs';
import { recentTaskRunsQueryOptions } from '~queries/app-tasks';
import { listRecentTaskRunsFn } from '~server/app-tasks';

export const Route = createFileRoute('/_app/executions')({
  loader: () => listRecentTaskRunsFn(),
  component: ExecutionsPage,
});

const TRIGGER_LABEL: Record<string, PlainTranslationKey> = {
  manual: 'runTrigger.manual',
  cron: 'runTrigger.cron',
  webhook: 'runTrigger.webhook',
  app: 'runTrigger.app',
};

/** Fast refresh while a run is in flight; slow idle poll picks up new ones. */
const pollActive = (runs: { status: RunListItem['status'] }[] | undefined) =>
  (runs ?? []).some((run) => isActiveRun(run.status)) ? 1500 : 15_000;

function ExecutionsPage() {
  const { t } = useI18n();
  const initial = Route.useLoaderData();
  const navigate = useNavigate();
  const taskQuery = useQuery({
    ...recentTaskRunsQueryOptions,
    initialData: initial,
    refetchInterval: (q) => pollActive(q.state.data),
  });
  // Newest first, as the server returns them.
  const rows = taskQuery.data ?? [];

  return (
    <DeskWindow
      fill
      title={t('nav.executions')}
      tile={
        <ThemeIcon size={22} radius="xs" color="dark">
          <IconTimeline size={13} stroke={2.4} />
        </ThemeIcon>
      }
      closeTo={{ link: { to: '/apps' }, label: t('nav.allApps') }}
    >
      <WindowBody>
        <Toolbar lead={t('executions.lead', { count: rows.length })}>
          <Button component={Link} to="/apps" variant="default">
            {t('executions.apps')}
          </Button>
        </Toolbar>
        {rows.length === 0 ? (
          <EmptyState
            tone="accent"
            icon={<IconTimeline size={26} stroke={1.6} />}
            title={t('executions.emptyTitle')}
          >
            {t('executions.emptyBody')}
          </EmptyState>
        ) : (
          <TableCard>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('executions.column.source')}</Table.Th>
                <Table.Th>{t('executions.column.status')}</Table.Th>
                <Table.Th>{t('executions.column.trigger')}</Table.Th>
                <Table.Th>{t('executions.column.steps')}</Table.Th>
                <Table.Th>{t('executions.column.duration')}</Table.Th>
                <Table.Th>{t('executions.column.started')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((run) => (
                <Table.Tr
                  key={run.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() =>
                    void navigate({
                      to: '/app/$appSlug/tasks/runs/$runId',
                      params: { appSlug: run.appSlug, runId: run.id },
                    })
                  }
                >
                  <Table.Td>
                    {/* Real link (not just the row onClick) so open-in-new-tab
                        and keyboard navigation work. stopPropagation keeps a
                        modified click from ALSO firing the row's onClick and
                        navigating the current tab. */}
                    <Group
                      gap="sm"
                      wrap="nowrap"
                      style={{
                        minWidth: 0,
                        color: 'inherit',
                        textDecoration: 'none',
                      }}
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/app/$appSlug/tasks/runs/$runId"
                          params={{ appSlug: run.appSlug, runId: run.id }}
                          onClick={(event) => event.stopPropagation()}
                        />
                      )}
                    >
                      <AppGlyph name={run.appName} seed={run.appId} size="sm" />
                      <Text size="sm" fw={600} truncate>
                        {run.appName}
                      </Text>
                      <Text size="xs" c="dimmed" truncate>
                        {run.taskName}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <RunStatusBadge status={run.status} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {TRIGGER_LABEL[run.trigger]
                        ? t(TRIGGER_LABEL[run.trigger])
                        : run.trigger}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {run.stepCount}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {formatDuration(run.durationMs)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {formatRelative(run.startedAt ?? run.createdAt)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </TableCard>
        )}
      </WindowBody>
    </DeskWindow>
  );
}
