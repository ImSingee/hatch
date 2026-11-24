import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import {
  IconClock,
  IconHandClick,
  IconPlayerPlay,
  IconWebhook,
} from '@tabler/icons-react';
import {
  Column,
  Columns,
  EmptyLine,
  GroupCard,
  Section,
} from '~components/page/page';
import { RunStatusBadge } from '~components/runs/run-status';
import { TaskAvailabilityNotice } from '~components/tasks/task-availability';
import { TaskRunList } from '~components/tasks/task-run-list';
import { TasksWindow } from '~components/tasks/tasks-window';
import { useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import { appTasksQueryOptions } from '~queries/app-tasks';
import type { AppTaskView } from '~server/app-tasks';
import { getAppBySlug } from '~server/apps';

export const Route = createFileRoute('/_app/app/$appSlug/tasks/')({
  loader: async ({ params }) => {
    const app = await getAppBySlug({ data: params.appSlug });
    if (!app) throw notFound();
    return app;
  },
  component: TasksPage,
});

function TaskTriggers({ task }: { task: AppTaskView }) {
  const { t } = useI18n();
  return (
    <Group gap={6}>
      <Badge
        variant="light"
        color="gray"
        radius="sm"
        leftSection={<IconHandClick size={11} />}
      >
        {t('runTrigger.manual')}
      </Badge>
      {task.cron.length > 0 ? (
        <Badge
          variant="light"
          color="gray"
          radius="sm"
          leftSection={<IconClock size={11} />}
        >
          {task.cron.length === 1
            ? task.cron[0].schedule
            : t('tasks.schedules', { count: task.cron.length })}
        </Badge>
      ) : null}
      {task.webhook.enabled ? (
        <Badge
          variant="light"
          color="gray"
          radius="sm"
          leftSection={<IconWebhook size={11} />}
        >
          {t('runTrigger.webhook')}
        </Badge>
      ) : null}
    </Group>
  );
}

/** The Run tab: every task with its triggers, latest run and a Run button. */
function TasksPage() {
  const { t, locale } = useI18n();
  const app = Route.useLoaderData();
  const query = useQuery(appTasksQueryOptions(app.id));
  const view = query.data ?? null;
  const notice = query.isLoading ? null : (
    <TaskAvailabilityNotice app={app} hasTasks={Boolean(view)} />
  );

  return (
    <TasksWindow app={app} page="run">
      {notice}
      <Columns>
        <Column grow basis={440}>
          <Section
            title={t('tasks.section.tasks')}
            meta={view ? String(view.tasks.length) : undefined}
            note={
              view
                ? t('tasks.concurrency', { count: view.concurrency })
                : undefined
            }
          >
            <GroupCard padded>
              {!view ? (
                <EmptyLine>
                  {query.isLoading ? t('tasks.loading') : t('tasks.empty')}
                </EmptyLine>
              ) : (
                <Stack gap="lg">
                  {view.tasks.map((task) => (
                    <Group
                      key={task.name}
                      justify="space-between"
                      wrap="nowrap"
                      align="flex-start"
                    >
                      <Stack gap={6} style={{ minWidth: 0 }}>
                        <Group gap={8}>
                          <Text fw={700}>{task.title ?? task.name}</Text>
                          <Text size="xs" c="dimmed" ff="monospace">
                            {task.method}
                          </Text>
                        </Group>
                        {task.description ? (
                          <Text size="sm" c="dimmed">
                            {task.description}
                          </Text>
                        ) : null}
                        <TaskTriggers task={task} />
                        <Text size="xs" c="dimmed">
                          {task.running > 0 || task.queued > 0
                            ? t('tasks.activity', {
                                running: task.running,
                                queued: task.queued,
                              })
                            : task.latestRun
                              ? t('tasks.lastRun', {
                                  when: formatRelativeTime(
                                    task.latestRun.createdAt,
                                    locale,
                                  ),
                                })
                              : t('tasks.neverRun')}
                        </Text>
                      </Stack>
                      <Group gap={8} wrap="nowrap">
                        {task.latestRun ? (
                          <RunStatusBadge status={task.latestRun.status} />
                        ) : null}
                        <Button
                          leftSection={
                            <IconPlayerPlay size={16} stroke={1.8} />
                          }
                          renderRoot={(props) => (
                            <Link
                              to="/app/$appSlug/tasks/$taskName"
                              params={{
                                appSlug: app.slug,
                                taskName: task.name,
                              }}
                              {...props}
                            />
                          )}
                        >
                          {t('tasks.run')}
                        </Button>
                      </Group>
                    </Group>
                  ))}
                </Stack>
              )}
            </GroupCard>
          </Section>
        </Column>
        <Column basis={420}>
          <TaskRunList appId={app.id} appSlug={app.slug} limit={5} />
        </Column>
      </Columns>
    </TasksWindow>
  );
}
