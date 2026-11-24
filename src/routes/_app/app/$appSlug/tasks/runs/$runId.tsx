import { Anchor, Button } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { IconPlayerStop } from '@tabler/icons-react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { DeskWindow } from '~components/desk/window';
import { Row, Toolbar, WindowBody } from '~components/page/page';
import { RunInspector } from '~components/runs/run-inspector';
import { RunStatusBadge } from '~components/runs/run-status';
import { isActiveRun } from '~lib/runs';
import {
  appTaskRunQueryOptions,
  appTasksQueryOptions,
} from '~queries/app-tasks';
import { cancelAppTaskRunFn, getAppTaskRunFn } from '~server/app-tasks';
import { getAppBySlug } from '~server/apps';

export const Route = createFileRoute('/_app/app/$appSlug/tasks/runs/$runId')({
  loader: async ({ params }) => {
    const app = await getAppBySlug({ data: params.appSlug });
    if (!app) throw notFound();
    // Scoped to the App, so /app/<A>/tasks/runs/<run of B> cannot show B.
    const run = await getAppTaskRunFn({
      data: { id: app.id, runId: params.runId },
    });
    if (!run) throw notFound();
    return { app, run };
  },
  component: TaskRunInspectorPage,
});

function TaskRunInspectorPage() {
  const initial = Route.useLoaderData();
  const { runId } = Route.useParams();
  const { app } = initial;
  const queryClient = useQueryClient();
  const { data } = useQuery({
    ...appTaskRunQueryOptions(app.id, runId),
    initialData: initial.run,
  });
  const run = data ?? initial.run;
  const active = isActiveRun(run.status);
  const params = { appSlug: app.slug };

  const cancel = useMutation({
    mutationFn: () => cancelAppTaskRunFn({ data: { id: app.id, runId } }),
    onSuccess: (result) => {
      if (result.canceled) toast.success('Run canceled');
      else toast.info('The run had already finished');
      void queryClient.invalidateQueries(appTaskRunQueryOptions(app.id, runId));
      void queryClient.invalidateQueries(appTasksQueryOptions(app.id));
    },
  });

  return (
    <DeskWindow
      fill
      maxWidth={1180}
      title={`${app.name} · Run`}
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      badge={<RunStatusBadge status={run.status} />}
      closeTo={{
        link: { to: '/app/$appSlug/tasks/runs', params },
        label: `${app.name} task runs`,
      }}
    >
      <WindowBody>
        <Toolbar
          lead={
            <Anchor
              size="sm"
              underline="never"
              renderRoot={(props) => (
                <Link
                  to="/app/$appSlug/tasks/runs"
                  params={params}
                  {...props}
                />
              )}
            >
              ‹ All runs of {app.name}
            </Anchor>
          }
        >
          {active ? (
            <Button
              color="red"
              variant="light"
              leftSection={<IconPlayerStop size={16} stroke={1.8} />}
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          ) : null}
        </Toolbar>
        <RunInspector
          run={run}
          summaryRows={
            <>
              <Row label="Task">
                <Anchor
                  size="sm"
                  renderRoot={(props) => (
                    <Link
                      to="/app/$appSlug/tasks/$taskName"
                      params={{ appSlug: app.slug, taskName: run.taskName }}
                      {...props}
                    />
                  )}
                >
                  {run.taskName}
                </Anchor>
              </Row>
              {run.queuePosition != null ? (
                <Row label="Queue">
                  {run.queuePosition === 1
                    ? 'Next to start'
                    : `${run.queuePosition - 1} run(s) ahead`}
                </Row>
              ) : null}
              {run.cronName ? <Row label="Schedule">{run.cronName}</Row> : null}
            </>
          }
        />
      </WindowBody>
    </DeskWindow>
  );
}
