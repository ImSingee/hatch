import { Button, Group, Table, Text, ThemeIcon } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { IconTimeline } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { DeskWindow } from '~components/desk/window';
import {
  EmptyState,
  TableCard,
  Toolbar,
  WindowBody,
} from '~components/page/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { RunStatusBadge } from '~components/runs/run-status';
import { formatDuration, formatRelative } from '~lib/format';
import { isActiveRun, type RunListItem } from '~lib/runs';
import { recentTaskRunsQueryOptions } from '~queries/app-tasks';
import { allWorkflowRunsQueryOptions } from '~queries/workflows';
import { listRecentTaskRunsFn } from '~server/app-tasks';
import { listAllWorkflowRuns } from '~server/workflows';

export const Route = createFileRoute('/_app/executions')({
  loader: async () => {
    const [workflowRuns, taskRuns] = await Promise.all([
      listAllWorkflowRuns(),
      listRecentTaskRunsFn(),
    ]);
    return { workflowRuns, taskRuns };
  },
  component: ExecutionsPage,
});

/** One row of the merged history, with where it links to. */
type ExecutionRow = RunListItem & {
  sourceKind: 'workflow' | 'task';
  sourceId: string;
  sourceName: string;
  /** Task name, for App task runs. */
  detail: string | null;
  link: (
    props: Record<string, unknown>,
    onClick: (event: { stopPropagation(): void }) => void,
  ) => ReactNode;
  open: () => void;
};

/** Live-refresh while any run is still in flight. */
const pollActive = (runs: { status: RunListItem['status'] }[] | undefined) =>
  (runs ?? []).some((run) => isActiveRun(run.status)) ? 1500 : false;

function ExecutionsPage() {
  const initial = Route.useLoaderData();
  const navigate = useNavigate();
  const workflowQuery = useQuery({
    ...allWorkflowRunsQueryOptions,
    initialData: initial.workflowRuns,
    refetchInterval: (q) => pollActive(q.state.data),
  });
  const taskQuery = useQuery({
    ...recentTaskRunsQueryOptions,
    initialData: initial.taskRuns,
    refetchInterval: (q) => pollActive(q.state.data),
  });

  const rows: ExecutionRow[] = [
    ...(workflowQuery.data ?? []).map((run): ExecutionRow => ({
      ...run,
      sourceKind: 'workflow',
      sourceId: run.workflowId,
      sourceName: run.workflowName,
      detail: null,
      link: (props, onClick) => (
        <Link
          {...props}
          to="/workflow/$workflowSlug/execution/$runId"
          params={{ workflowSlug: run.workflowSlug, runId: run.id }}
          onClick={onClick}
        />
      ),
      open: () =>
        void navigate({
          to: '/workflow/$workflowSlug/execution/$runId',
          params: { workflowSlug: run.workflowSlug, runId: run.id },
        }),
    })),
    ...(taskQuery.data ?? []).map((run): ExecutionRow => ({
      ...run,
      sourceKind: 'task',
      sourceId: run.appId,
      sourceName: run.appName,
      detail: run.taskName,
      link: (props, onClick) => (
        <Link
          {...props}
          to="/app/$appSlug/tasks/runs/$runId"
          params={{ appSlug: run.appSlug, runId: run.id }}
          onClick={onClick}
        />
      ),
      open: () =>
        void navigate({
          to: '/app/$appSlug/tasks/runs/$runId',
          params: { appSlug: run.appSlug, runId: run.id },
        }),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <DeskWindow
      fill
      title="Executions"
      tile={
        <ThemeIcon size={22} radius="xs" color="dark">
          <IconTimeline size={13} stroke={2.4} />
        </ThemeIcon>
      }
      closeTo={{ link: { to: '/workflows' }, label: 'Workflows' }}
    >
      <WindowBody>
        <Toolbar
          lead={`Run history across Workflows and App tasks · ${rows.length} execution${rows.length === 1 ? '' : 's'}`}
        >
          <Button component={Link} to="/workflows" variant="default">
            Workflows
          </Button>
          <Button component={Link} to="/apps" variant="default">
            Apps
          </Button>
        </Toolbar>
        {rows.length === 0 ? (
          <EmptyState
            tone="accent"
            icon={<IconTimeline size={26} stroke={1.6} />}
            title="No executions yet"
          >
            Run a Workflow or an App task manually, on a schedule, or via
            webhook and every run will show up here.
          </EmptyState>
        ) : (
          <TableCard>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Source</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Trigger</Table.Th>
                <Table.Th>Steps</Table.Th>
                <Table.Th>Duration</Table.Th>
                <Table.Th>Started</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((run) => (
                <Table.Tr
                  key={`${run.sourceKind}-${run.id}`}
                  style={{ cursor: 'pointer' }}
                  onClick={run.open}
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
                      renderRoot={(props) =>
                        run.link(props, (event) => event.stopPropagation())
                      }
                    >
                      <AppGlyph
                        icon={run.sourceKind === 'task'}
                        shape={
                          run.sourceKind === 'workflow' ? 'workflow' : 'app'
                        }
                        name={run.sourceName}
                        seed={run.sourceId}
                        size="sm"
                      />
                      <Text size="sm" fw={600} truncate>
                        {run.sourceName}
                      </Text>
                      {run.detail ? (
                        <Text size="xs" c="dimmed" truncate>
                          {run.detail}
                        </Text>
                      ) : null}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <RunStatusBadge status={run.status} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" tt="capitalize">
                      {run.trigger}
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
