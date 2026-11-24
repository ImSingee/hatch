import { Anchor, Code } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
} from '@tanstack/react-router';
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
  const app = Route.useLoaderData();
  const { taskName } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(appTasksQueryOptions(app.id));
  const view = query.data ?? null;
  const task = view?.tasks.find((t) => t.name === taskName) ?? null;
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
        toast.error('Input rejected — see the run for details.');
      } else {
        toast.success('Run queued');
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
    onError: (error) => toast.error(error.message),
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
            note={
              task
                ? 'The form is built from the method’s request message. Every run is recorded under Runs.'
                : undefined
            }
          >
            <GroupCard padded>
              {task ? (
                <SchemaRunForm
                  formKey={`${app.id}/${task.name}`}
                  inputSchema={task.inputSchema}
                  disabled={!runnable}
                  pending={run.isPending}
                  onSubmit={(input) => run.mutate(input)}
                  emptyText="This task takes no input."
                />
              ) : (
                <EmptyLine>
                  {query.isLoading
                    ? 'Loading task…'
                    : `The active deployment declares no task "${taskName}".`}
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
              manualNote="Run on demand from this page or the CLI; input is validated against the request message before a run is queued."
              cronJobs={task.cron}
              cronEmptyNote={
                <>
                  No schedules declared. Add them under{' '}
                  <Code>tasks.definitions[].cron</Code> in the manifest.
                </>
              }
              webhook={
                task.webhook.enabled && task.webhook.url
                  ? {
                      enabled: true,
                      url: task.webhook.url,
                      secret: view?.webhookSecret ?? null,
                      note: 'POST a JSON body (or GET with query params) here; the platform verifies the secret and queues a run with it as input.',
                    }
                  : {
                      enabled: false,
                      note: (
                        <>
                          Webhook runs are off. Set <Code>webhook: true</Code>{' '}
                          on the task and redeploy.
                        </>
                      ),
                    }
              }
            />
          ) : null}
          <Callout title="Want it to work differently?">
            A task is a method of the App’s backend. Tell the Agent what to
            change and it updates and redeploys the App.
            <Anchor component={Link} to="/agent" size="sm">
              Edit with the Agent ›
            </Anchor>
          </Callout>
        </Column>
      </Columns>
    </TasksWindow>
  );
}
