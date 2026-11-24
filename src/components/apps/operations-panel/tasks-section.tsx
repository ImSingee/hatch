import { Anchor, Button, Group, Stack, Table, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconListCheck, IconPlayerPlay } from '@tabler/icons-react';
import { RunStatusBadge } from '~components/runs/run-status';
import { useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import type { AppTasksView } from '~server/app-tasks';
import { SectionHeader } from './section-header';

/** The App's tasks: load, triggers and each task's latest run. */
export function TasksSection({
  appSlug,
  tasks,
}: {
  appSlug: string;
  tasks: AppTasksView;
}) {
  const { t, locale } = useI18n();
  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <SectionHeader
          icon={<IconListCheck size={16} stroke={1.8} />}
          title={t('tasks.section.tasks')}
          meta={
            <Text size="xs" c="dimmed">
              {t('ops.tasks.meta', {
                running: tasks.running,
                queued: tasks.queued,
                concurrency: tasks.concurrency,
              })}
            </Text>
          }
        />
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlayerPlay size={14} stroke={1.8} />}
          renderRoot={(props) => (
            <Link to="/app/$appSlug/tasks" params={{ appSlug }} {...props} />
          )}
        >
          {t('ops.tasks.open')}
        </Button>
      </Group>
      <Table withTableBorder verticalSpacing={6}>
        <Table.Tbody>
          {tasks.tasks.map((task) => (
            <Table.Tr key={task.name}>
              <Table.Td>
                <Anchor
                  size="sm"
                  fw={600}
                  renderRoot={(props) => (
                    <Link
                      to="/app/$appSlug/tasks/$taskName"
                      params={{ appSlug, taskName: task.name }}
                      {...props}
                    />
                  )}
                >
                  {task.title ?? task.name}
                </Anchor>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {[
                    t('ops.tasks.trigger.manual'),
                    ...task.cron.map((job) => job.schedule),
                    ...(task.webhook.enabled
                      ? [t('ops.tasks.trigger.webhook')]
                      : []),
                  ].join(' · ')}
                </Text>
              </Table.Td>
              <Table.Td>
                {task.latestRun ? (
                  <Group gap={6} wrap="nowrap">
                    <RunStatusBadge status={task.latestRun.status} />
                    <Text size="xs" c="dimmed">
                      {formatRelativeTime(task.latestRun.createdAt, locale)}
                    </Text>
                  </Group>
                ) : (
                  <Text size="xs" c="dimmed">
                    {t('tasks.neverRun')}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
