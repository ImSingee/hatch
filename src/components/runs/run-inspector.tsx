import { Badge, Code, Group, Text, Timeline } from '@mantine/core';
import type { ReactNode } from 'react';
import {
  Column,
  Columns,
  GroupCard,
  Row,
  Section,
} from '~components/page/page';
import { formatDuration, formatExact } from '~lib/format';
import {
  isActiveRun,
  prettyRunValue,
  type RunDetailView,
  type RunStepView,
} from '~lib/runs';
import { RunStatusBadge, RunStatusBullet } from './run-status';
import classes from './run-inspector.module.css';

function StepItem({ step }: { step: RunStepView }) {
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
          {prettyRunValue(step.output)}
        </Code>
      ) : null}
    </Timeline.Item>
  );
}

/**
 * The body of a run inspector: step timeline, error and log beside the
 * summary, output and input of an App task run; extra summary rows come
 * first (e.g. the task a run belongs to).
 */
export function RunInspector({
  run,
  summaryRows,
  emptyStepsText = 'This run recorded no steps.',
}: {
  run: RunDetailView;
  summaryRows?: ReactNode;
  emptyStepsText?: string;
}) {
  const active = isActiveRun(run.status);
  return (
    <Columns>
      <Column grow basis={420}>
        <Section title="Steps" meta={`${run.steps.length}`}>
          <GroupCard padded>
            {run.steps.length === 0 ? (
              <Text size="sm" c="dimmed">
                {active ? 'Waiting for the first step…' : emptyStepsText}
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
                  <StepItem key={`${step.seq}-${step.attempt}`} step={step} />
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
            {summaryRows}
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
              {prettyRunValue(run.output)}
            </Code>
          </Section>
        ) : null}
        <Section title="Input">
          <Code block className={classes.code}>
            {prettyRunValue(run.input ?? {})}
          </Code>
        </Section>
      </Column>
    </Columns>
  );
}
