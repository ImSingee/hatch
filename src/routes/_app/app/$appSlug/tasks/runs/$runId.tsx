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
import { useI18n } from '~i18n';

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
  const { t } = useI18n();
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
      if (result.canceled) toast.success(t('taskRun.toast.canceled'));
      else toast.info(t('taskRun.toast.alreadyFinished'));
      void queryClient.invalidateQueries(appTaskRunQueryOptions(app.id, runId));
      void queryClient.invalidateQueries(appTasksQueryOptions(app.id));
    },
  });

  return (
    <DeskWindow
      fill
      maxWidth={1180}
      title={t('taskRun.title', { app: app.name })}
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      badge={<RunStatusBadge status={run.status} />}
      closeTo={{
        link: { to: '/app/$appSlug/tasks/runs', params },
        label: t('taskRun.closeLabel', { app: app.name }),
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
              {t('taskRun.backToRuns', { app: app.name })}
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
              {t('common.cancel')}
            </Button>
          ) : null}
        </Toolbar>
        <RunInspector
          run={run}
          summaryRows={
            <>
              <Row label={t('taskRun.row.task')}>
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
                <Row label={t('taskRun.row.queue')}>
                  {run.queuePosition === 1
                    ? t('taskRun.queue.next')
                    : t('taskRun.queue.ahead', {
                        count: run.queuePosition - 1,
                      })}
                </Row>
              ) : null}
              {run.cronName ? (
                <Row label={t('taskRun.row.schedule')}>{run.cronName}</Row>
              ) : null}
            </>
          }
        />
      </WindowBody>
    </DeskWindow>
  );
}
