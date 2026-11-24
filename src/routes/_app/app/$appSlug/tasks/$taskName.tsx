import { Anchor, Code } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
} from '@tanstack/react-router';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import {
  Callout,
  Column,
  Columns,
  EmptyLine,
  GroupCard,
  Section,
} from '~components/page/page';
import { SchemaRunForm } from '~components/runs/schema-run-form';
import { TriggersCard } from '~components/runs/triggers-card';
import { TaskAvailabilityNotice } from '~components/tasks/task-availability';
import { TaskRunList } from '~components/tasks/task-run-list';
import { TasksWindow } from '~components/tasks/tasks-window';
import { useErrorText, useI18n } from '~i18n';
import {
  appTaskRunsQueryOptions,
  appTasksQueryOptions,
} from '~queries/app-tasks';
import { runAppTaskFn } from '~server/app-tasks';
import { getAppBySlug } from '~server/apps';

export const Route = createFileRoute('/_app/app/$appSlug/tasks/$taskName')({
  loader: async ({ params }) => {
    const app = await getAppBySlug({ data: params.appSlug });
    if (!app) throw notFound();
    return app;
  },
  component: TaskRunPage,
});

/** One task: its input form, its latest runs and how it is triggered. */
function TaskRunPage() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const app = Route.useLoaderData();
  const { taskName } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(appTasksQueryOptions(app.id));
  const view = query.data ?? null;
  const task = view?.tasks.find((item) => item.name === taskName) ?? null;
  const runnable =
    app.status === 'deployed' && (app.compatibility?.isSupported ?? false);

  const run = useMutation({
    mutationFn: (input: unknown) =>
      runAppTaskFn({
        data: { id: app.id, task: taskName, input: input as never },
      }),
    onSuccess: (result) => {
      // Rejected input is recorded as a failed run, so link to it.
      if (result.status === 'failed') {
        toast.error(t('tasks.detail.inputRejected'));
      } else {
        toast.success(t('tasks.detail.queued'));
      }
      void queryClient.invalidateQueries({
        queryKey: appTaskRunsQueryOptions(app.id).queryKey.slice(0, 2),
      });
      void queryClient.invalidateQueries(appTasksQueryOptions(app.id));
      void navigate({
        to: '/app/$appSlug/tasks/runs/$runId',
        params: { appSlug: app.slug, runId: result.runId },
      });
    },
    onError: (error) => toast.error(errorText(error, 'tasks.detail.runFailed')),
    // The toast above reports the failure.
    meta: { errorToast: false },
  });

  return (
    <TasksWindow app={app} page="run" title={task?.title ?? taskName}>
      {query.isLoading ? null : (
        <TaskAvailabilityNotice app={app} hasTasks={Boolean(view)} />
      )}
      <Columns>
        <Column grow basis={420}>
          <Section
            title={task?.title ?? taskName}
            meta={task ? task.method : undefined}
            note={task ? t('tasks.detail.formNote') : undefined}
          >
            <GroupCard padded>
              {task ? (
                <SchemaRunForm
                  formKey={`${app.id}/${task.name}`}
                  inputSchema={task.inputSchema}
                  disabled={!runnable}
                  pending={run.isPending}
                  onSubmit={(input) => run.mutate(input)}
                  emptyText={t('tasks.detail.noInput')}
                />
              ) : (
                <EmptyLine>
                  {query.isLoading
                    ? t('tasks.detail.loading')
                    : t('tasks.detail.notDeclared', { task: taskName })}
                </EmptyLine>
              )}
            </GroupCard>
          </Section>
          <TaskRunList
            appId={app.id}
            appSlug={app.slug}
            task={taskName}
            limit={5}
          />
        </Column>
        <Column basis={320}>
          {task ? (
            <TriggersCard
              manualNote={t('tasks.detail.manualNote')}
              cronJobs={task.cron}
              cronEmptyNote={
                <Trans
                  t={t}
                  i18nKey="tasks.detail.cronEmpty"
                  components={{ code: <Code /> }}
                />
              }
              webhook={
                task.webhook.enabled && task.webhook.url
                  ? {
                      enabled: true,
                      url: task.webhook.url,
                      secret: view?.webhookSecret ?? null,
                      note: t('tasks.detail.webhookNote'),
                    }
                  : {
                      enabled: false,
                      note: (
                        <Trans
                          t={t}
                          i18nKey="tasks.detail.webhookOff"
                          components={{ code: <Code /> }}
                        />
                      ),
                    }
              }
            />
          ) : null}
          <Callout title={t('tasks.detail.calloutTitle')}>
            {t('tasks.detail.calloutBody')}
            <Anchor component={Link} to="/agent" size="sm">
              {t('tasks.detail.editWithAgent')}
            </Anchor>
          </Callout>
        </Column>
      </Columns>
    </TasksWindow>
  );
}
