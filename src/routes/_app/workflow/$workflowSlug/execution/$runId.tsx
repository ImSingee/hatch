import {
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Text,
  Timeline,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { IconPlayerStop } from '@tabler/icons-react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { DeskWindow } from '~components/desk/window';
import {
  Column,
  Columns,
  GroupCard,
  Row,
  Section,
  Toolbar,
  WindowBody,
} from '~components/page/page';
import {
  RunStatusBadge,
  RunStatusBullet,
} from '~components/workflows/run-status';
import { formatDuration, formatExact } from '~lib/format';
import {
  workflowRunQueryOptions,
  workflowRunsQueryOptions,
} from '~queries/workflows';
import {
  cancelWorkflowRunFn,
  getWorkflowBySlug,
  getWorkflowRun,
} from '~server/workflows';
import type { WorkflowRunStepView } from '~server/workflows/manage';
import classes from './execution.module.css';

export const Route = createFileRoute(
  '/_app/workflow/$workflowSlug/execution/$runId',
)({
  loader: async ({ params }) => {
    const workflow = await getWorkflowBySlug({ data: params.workflowSlug });
    if (!workflow) throw notFound();
    const run = await getWorkflowRun({ data: params.runId });
    // Scope the run to its workflow so a deep link like
    // /workflow/<A>/execution/<run-of-B> can't render or cancel B under A.
    if (!run || run.workflowId !== workflow.id) throw notFound();
    return { run, workflow };
  },
  component: WorkflowExecutionPage,
});

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function StepItem({ step }: { step: WorkflowRunStepView }) {
  return (
    <Timeline.Item
      lineVariant={step.status === 'failed' ? 'dashed' : 'solid'}
      bullet={<RunStatusBullet status={step.status} filled />}
    >
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text fw={700} size="sm">
          {step.name}
        </Text>
        {step.attempt > 1 ? (
          <Badge size="xs" variant="light" color="gray" radius="sm">
            attempt {step.attempt}
          </Badge>
        ) : null}
        <Text size="xs" c="dimmed">
          {formatDuration(step.durationMs)}
        </Text>
      </Group>
      {step.error ? (
        <Code
          block
          mt={6}
          style={{
            fontSize: 'var(--mantine-font-size-xs)',
            color: 'var(--mantine-color-red-7)',
          }}
        >
          {step.error}
        </Code>
      ) : null}
      {step.output != null && step.output !== '' ? (
        <Code block mt={6} style={{ fontSize: 'var(--mantine-font-size-xs)' }}>
          {pretty(step.output)}
        </Code>
      ) : null}
    </Timeline.Item>
  );
}

function WorkflowExecutionPage() {
  const initial = Route.useLoaderData();
  const { runId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    ...workflowRunQueryOptions(runId),
    initialData: initial.run,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === 'queued' || status === 'running' ? 1200 : false;
    },
  });
  const run = data ?? initial.run;
  const { workflow } = initial;
  const active = run.status === 'queued' || run.status === 'running';

  const cancel = useMutation({
    mutationFn: () => cancelWorkflowRunFn({ data: runId }),
    onSuccess: () => {
      toast.success('Execution canceled');
      void queryClient.invalidateQueries(workflowRunQueryOptions(runId));
      void queryClient.invalidateQueries(workflowRunsQueryOptions(workflow.id));
    },
  });

  return (
    <DeskWindow
      fill
      maxWidth={1180}
      title={`${workflow.name} · Execution`}
      tile={
        <AppGlyph
          icon={false}
          shape="workflow"
          name={workflow.name}
          seed={workflow.id}
          size="sm"
        />
      }
      badge={<RunStatusBadge status={run.status} />}
      closeTo={{
        link: {
          to: '/workflow/$workflowSlug/executions',
          params: { workflowSlug: workflow.slug },
        },
        label: "this workflow's executions",
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
                  to="/workflow/$workflowSlug/executions"
                  params={{ workflowSlug: workflow.slug }}
                  {...props}
                />
              )}
            >
              ‹ All executions of {workflow.name}
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
        <Columns>
          <Column grow basis={420}>
            <Section title="Steps" meta={`${run.steps.length}`}>
              <GroupCard padded>
                {run.steps.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {active
                      ? 'Waiting for the first step…'
                      : 'This execution recorded no steps.'}
                  </Text>
                ) : (
                  <Timeline
                    bulletSize={20}
                    lineWidth={2}
                    active={-1}
                    color="gray"
                    styles={{
                      itemBody: { paddingBottom: 'var(--mantine-spacing-md)' },
                    }}
                  >
                    {run.steps.map((step) => (
                      <StepItem
                        key={`${step.seq}-${step.attempt}`}
                        step={step}
                      />
                    ))}
                  </Timeline>
                )}
              </GroupCard>
            </Section>
            {run.error ? (
              <Section title="Error">
                <Code block className={classes.error}>
                  {run.error}
                </Code>
              </Section>
            ) : null}
            {run.log ? (
              <Section title="Log">
                <Code block className={classes.log}>
                  {run.log}
                </Code>
              </Section>
            ) : null}
          </Column>
          <Column basis={340}>
            <Section title="Summary">
              <GroupCard>
                <Row label="Status">
                  <RunStatusBadge status={run.status} />
                </Row>
                <Row label="Trigger">
                  <span className={classes.capitalize}>{run.trigger}</span>
                </Row>
                {run.version != null ? (
                  <Row label="Version">v{run.version}</Row>
                ) : null}
                <Row label="Started">
                  {formatExact(run.startedAt ?? run.createdAt)}
                </Row>
                <Row label="Duration">{formatDuration(run.durationMs)}</Row>
              </GroupCard>
            </Section>
            {run.output != null ? (
              <Section title="Output">
                <Code block className={classes.code}>
                  {pretty(run.output)}
                </Code>
              </Section>
            ) : null}
            <Section title="Input">
              <Code block className={classes.code}>
                {pretty(run.input ?? {})}
              </Code>
            </Section>
          </Column>
        </Columns>
      </WindowBody>
    </DeskWindow>
  );
}
