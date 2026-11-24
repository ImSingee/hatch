import { Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { Toolbar } from '~components/page/page';
import { TaskRunList } from '~components/tasks/task-run-list';
import { TasksWindow } from '~components/tasks/tasks-window';
import { useI18n } from '~i18n';
import { appTasksQueryOptions } from '~queries/app-tasks';
import { getAppBySlug } from '~server/apps';

export const Route = createFileRoute('/_app/app/$appSlug/tasks/runs/')({
  validateSearch: z.object({ task: z.string().min(1).optional() }),
  loader: async ({ params }) => {
    const app = await getAppBySlug({ data: params.appSlug });
    if (!app) throw notFound();
    return app;
  },
  component: TaskRunsPage,
});

/** Every run of the App's tasks, optionally narrowed to one task. */
function TaskRunsPage() {
  const { t } = useI18n();
  const app = Route.useLoaderData();
  const { task } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: view } = useQuery(appTasksQueryOptions(app.id));
  const options = (view?.tasks ?? []).map((item) => ({
    value: item.name,
    label: item.title ?? item.name,
  }));
  return (
    <TasksWindow app={app} page="runs" title={t('tasks.runs.title')}>
      <Toolbar lead={t('tasks.runs.lead')}>
        <Select
          aria-label={t('tasks.runs.filterLabel')}
          placeholder={t('tasks.runs.allTasks')}
          clearable
          data={options}
          value={task ?? null}
          onChange={(value) =>
            void navigate({ search: value ? { task: value } : {} })
          }
          w={220}
        />
      </Toolbar>
      <TaskRunList
        key={task ?? 'all'}
        appId={app.id}
        appSlug={app.slug}
        task={task}
        showTask={!task}
      />
    </TasksWindow>
  );
}
