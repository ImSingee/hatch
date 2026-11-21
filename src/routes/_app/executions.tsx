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
import { RunStatusBadge } from '~components/workflows/run-status';
import { formatDuration, formatRelative } from '~lib/format';
import { allWorkflowRunsQueryOptions } from '~queries/workflows';
import { listAllWorkflowRuns } from '~server/workflows';

export const Route = createFileRoute('/_app/executions')({
  loader: () => listAllWorkflowRuns(),
  component: ExecutionsPage,
});

function ExecutionsPage() {
  const initial = Route.useLoaderData();
  const navigate = useNavigate();
  const query = useQuery({
    ...allWorkflowRunsQueryOptions,
    initialData: initial,
    // Live-refresh while any execution is still in flight.
    refetchInterval: (q) => {
      const runs = q.state.data ?? [];
      return runs.some((r) => r.status === 'queued' || r.status === 'running')
        ? 1500
        : false;
    },
  });

  const runs = query.data ?? [];

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
          lead={`Run history across every workflow · ${runs.length} execution${runs.length === 1 ? '' : 's'}`}
        >
          <Button component={Link} to="/workflows" variant="default">
            Workflows
          </Button>
        </Toolbar>
        {runs.length === 0 ? (
          <EmptyState
            tone="accent"
            icon={<IconTimeline size={26} stroke={1.6} />}
            title="No executions yet"
          >
            Trigger a workflow manually, on a schedule, or via webhook and every
            run will show up here.
          </EmptyState>
        ) : (
          <TableCard>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Workflow</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Trigger</Table.Th>
                <Table.Th>Steps</Table.Th>
                <Table.Th>Duration</Table.Th>
                <Table.Th>Started</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {runs.map((run) => (
                <Table.Tr
                  key={run.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() =>
                    navigate({
                      to: '/workflow/$workflowSlug/execution/$runId',
                      params: {
                        workflowSlug: run.workflowSlug,
                        runId: run.id,
                      },
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
                          to="/workflow/$workflowSlug/execution/$runId"
                          params={{
                            workflowSlug: run.workflowSlug,
                            runId: run.id,
                          }}
                          onClick={(event) => event.stopPropagation()}
                        />
                      )}
                    >
                      <AppGlyph
                        icon={false}
                        shape="workflow"
                        name={run.workflowName}
                        seed={run.workflowId}
                        size="sm"
                      />
                      <Text size="sm" fw={600} truncate>
                        {run.workflowName}
                      </Text>
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
