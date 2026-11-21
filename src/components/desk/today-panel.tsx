import { Button, Skeleton, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconCalendarEvent, IconRoute } from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { WorkflowRunStatus } from '~/db/schema';
import { allWorkflowRunsQueryOptions } from '~queries/workflows';
import classes from './today-panel.module.css';

const STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
};

/**
 * The ultrawide desk's today column: what ran today. The canvas puts an App
 * widget here; the platform has no widget of its own, so the column shows
 * today's Workflow runs, which every instance has data for.
 */
export function TodayPanel() {
  const runs = useQuery(allWorkflowRunsQueryOptions);
  const today = (runs.data ?? []).filter((run) =>
    dayjs(run.createdAt).isSame(dayjs(), 'day'),
  );

  return (
    <article className={classes.panel} aria-labelledby="today-panel-title">
      <header className={classes.header}>
        <span className={classes.tile} aria-hidden>
          <IconCalendarEvent size={15} stroke={2} />
        </span>
        <h2 id="today-panel-title" className={classes.title}>
          Today
        </h2>
        {runs.data ? (
          <span className={classes.meta}>
            {today.length} {today.length === 1 ? 'run' : 'runs'}
          </span>
        ) : null}
      </header>
      <Text size="sm" fw={700} c="dimmed">
        {dayjs().format('dddd, MMMM D')}
      </Text>
      {runs.isPending ? (
        <div className={classes.list} aria-hidden>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={44} radius="md" />
          ))}
        </div>
      ) : runs.isError ? (
        <div className={classes.empty} role="alert">
          <Text size="sm" fw={700}>
            Today’s runs could not be loaded
          </Text>
          <Button
            type="button"
            size="compact-sm"
            variant="default"
            onClick={() => void runs.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : today.length === 0 ? (
        <div className={classes.empty}>
          <IconRoute size={28} stroke={1.6} aria-hidden />
          <Text size="sm" fw={700} c="dimmed">
            Nothing has run today
          </Text>
        </div>
      ) : (
        <ul className={classes.list}>
          {today.slice(0, 8).map((run) => (
            <li key={run.id}>
              <Link
                to="/workflow/$workflowSlug/execution/$runId"
                params={{ workflowSlug: run.workflowSlug, runId: run.id }}
                className={classes.run}
              >
                <span className={classes.runName}>{run.workflowName}</span>
                <span className={classes.runMeta}>
                  {dayjs(run.createdAt).format('HH:mm')}
                </span>
                <span className={classes.status} data-status={run.status}>
                  {STATUS_LABEL[run.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className={classes.footer}>
        <Button component={Link} to="/workflows" variant="default" size="sm">
          All workflows
        </Button>
        <Link to="/executions" className={classes.more}>
          Executions ›
        </Link>
      </div>
    </article>
  );
}
