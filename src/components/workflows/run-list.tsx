import { Anchor, Center, Loader, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { formatDuration, formatRelative } from '~lib/format';
import { workflowRunsQueryOptions } from '~queries/workflows';
import {
  EmptyLine,
  GroupCard,
  Section,
  TableCard,
} from '~components/page/page';
import { RunStatusBadge } from './run-status';

export function WorkflowRunList({
  workflowId,
  workflowSlug,
  limit,
}: {
  workflowId: string;
  workflowSlug: string;
  /** Show only the latest runs, with a link to all of them. */
  limit?: number;
}) {
  const navigate = useNavigate();
  const query = useQuery({
    ...workflowRunsQueryOptions(workflowId),
    refetchInterval: (q) => {
      const runs = q.state.data ?? [];
      // Fast poll while a run is in flight so progress updates near-live.
      if (runs.some((r) => r.status === 'queued' || r.status === 'running')) {
        return 1500;
      }
      // Otherwise keep a slow idle poll so background-triggered runs (cron /
      // webhook) appear without a manual refresh. React Query pauses this while
      // the tab is hidden (refetchIntervalInBackground defaults false).
      return 15_000;
    },
  });

  const allRuns = query.data ?? [];
  const runs = limit ? allRuns.slice(0, limit) : allRuns;

  return (
    <Section
      title={limit ? 'Recent executions' : 'Executions'}
      meta={allRuns.length > 0 ? String(allRuns.length) : undefined}
      aside={
        limit && allRuns.length > 0 ? (
          <Anchor
            size="sm"
            underline="never"
            renderRoot={(props) => (
              <Link
                to="/workflow/$workflowSlug/executions"
                params={{ workflowSlug }}
                {...props}
              />
            )}
          >
            All executions ›
          </Anchor>
        ) : undefined
      }
    >
      {query.isLoading ? (
        <GroupCard>
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        </GroupCard>
      ) : runs.length === 0 ? (
        <GroupCard>
          <EmptyLine>
            No executions yet. Trigger this workflow to see its history here.
          </EmptyLine>
        </GroupCard>
      ) : (
        <TableCard>
          <Table.Thead>
            <Table.Tr>
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
                    params: { workflowSlug, runId: run.id },
                  })
                }
              >
                <Table.Td>
                  {/* Real link (not just the row onClick) so open-in-new-tab
                      and keyboard navigation work. stopPropagation keeps a
                      modified click from ALSO firing the row's onClick and
                      navigating the current tab. */}
                  <Link
                    to="/workflow/$workflowSlug/execution/$runId"
                    params={{ workflowSlug, runId: run.id }}
                    style={{ textDecoration: 'none' }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <RunStatusBadge status={run.status} />
                  </Link>
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
    </Section>
  );
}
