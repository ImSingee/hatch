import { Alert, Anchor, Button, Center, Text } from '@mantine/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { RunTable } from '~components/runs/run-table';
import { appTaskRunsInfiniteQueryOptions } from '~queries/app-tasks';

const PAGE = 50;

/**
 * Run history of an App's tasks, newest first. With `limit` it shows only
 * the latest runs and links to the full list; otherwise it grows a page at
 * a time by following the server's cursor.
 */
export function TaskRunList({
  appId,
  appSlug,
  task,
  limit,
  showTask = !task,
}: {
  appId: string;
  appSlug: string;
  /** Only runs of this task. */
  task?: string;
  limit?: number;
  showTask?: boolean;
}) {
  const navigate = useNavigate();
  const query = useInfiniteQuery(
    appTaskRunsInfiniteQueryOptions(appId, task, limit ?? PAGE),
  );
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? [];
  const failed = query.isError && !query.data;
  const open = (runId: string) =>
    navigate({
      to: '/app/$appSlug/tasks/runs/$runId',
      params: { appSlug, runId },
    });
  return (
    <RunTable
      title={limit ? 'Recent runs' : 'Runs'}
      runs={runs}
      loading={query.isLoading}
      emptyText={
        failed
          ? 'Could not load run history.'
          : task
            ? 'No runs of this task yet. Run it to see its history here.'
            : 'No task runs yet. Run a task to see its history here.'
      }
      leadColumns={
        showTask
          ? [
              {
                header: 'Task',
                cell: (run) => (
                  <Text size="sm" fw={600}>
                    {run.taskName}
                  </Text>
                ),
              },
            ]
          : []
      }
      aside={
        limit && runs.length > 0 ? (
          <Anchor
            size="sm"
            underline="never"
            renderRoot={(props) => (
              <Link
                to="/app/$appSlug/tasks/runs"
                params={{ appSlug }}
                search={task ? { task } : {}}
                {...props}
              />
            )}
          >
            All runs ›
          </Anchor>
        ) : undefined
      }
      footer={
        failed ? (
          <Alert color="red" variant="light" mt="sm" py="xs">
            <Center>
              <Text size="sm" mr="sm">
                Could not load run history.
              </Text>
              <Button
                type="button"
                variant="default"
                size="xs"
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </Center>
          </Alert>
        ) : !limit && query.hasNextPage ? (
          <Center mt="sm">
            <Button
              type="button"
              variant="default"
              size="xs"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Show more
            </Button>
          </Center>
        ) : null
      }
      renderLink={(run, children) => (
        // A real link keeps open-in-new-tab and keyboard navigation working;
        // stopPropagation keeps a modified click from also opening the row.
        <Link
          to="/app/$appSlug/tasks/runs/$runId"
          params={{ appSlug, runId: run.id }}
          style={{ textDecoration: 'none' }}
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </Link>
      )}
      onOpen={(run) => void open(run.id)}
    />
  );
}
