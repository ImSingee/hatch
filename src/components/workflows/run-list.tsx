import { Anchor } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { RunTable } from '~components/runs/run-table';
import { workflowRunsQueryOptions } from '~queries/workflows';

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
    <RunTable
      title={limit ? 'Recent executions' : 'Executions'}
      runs={runs}
      total={allRuns.length}
      loading={query.isLoading}
      emptyText="No executions yet. Trigger this workflow to see its history here."
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
      renderLink={(run, children) => (
        // Real link (not just the row onClick) so open-in-new-tab and
        // keyboard navigation work. stopPropagation keeps a modified click
        // from ALSO firing the row's onClick and navigating the current tab.
        <Link
          to="/workflow/$workflowSlug/execution/$runId"
          params={{ workflowSlug, runId: run.id }}
          style={{ textDecoration: 'none' }}
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </Link>
      )}
      onOpen={(run) =>
        void navigate({
          to: '/workflow/$workflowSlug/execution/$runId',
          params: { workflowSlug, runId: run.id },
        })
      }
    />
  );
}
