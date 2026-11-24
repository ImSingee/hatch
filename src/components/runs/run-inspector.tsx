import { Badge, Code, Group, Text, Timeline } from '@mantine/core';
import type { ReactNode } from 'react';
import { useI18n } from '~i18n';
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
import {
  RunStatusBadge,
  RunStatusBullet,
  RunTriggerLabel,
  useRunErrorText,
} from './run-status';
import classes from './run-inspector.module.css';

function StepItem({ step }: { step: RunStepView }) {
  const { t } = useI18n();
  const runErrorText = useRunErrorText();
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
            {t('runs.steps.attempt', { attempt: step.attempt })}
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
          {runErrorText(step.error)}
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
 * The body of an App task run inspector: what the run produced (error or
 * output) above its step timeline, beside the summary, input and log. Extra
 * summary rows come first (e.g. the task a run belongs to).
 */
export function RunInspector({
  run,
  summaryRows,
}: {
  run: RunDetailView;
  summaryRows?: ReactNode;
}) {
  const { t } = useI18n();
  const runErrorText = useRunErrorText();
  const active = isActiveRun(run.status);
  return (
    <Columns>
      <Column grow basis={420}>
        {run.error ? (
          <Section title={t('runs.inspector.error')}>
            <Code block className={classes.error}>
              {runErrorText(run.error)}
            </Code>
          </Section>
        ) : null}
        {run.output != null ? (
          <Section title={t('runs.inspector.output')}>
            <Code block className={classes.code}>
              {prettyRunValue(run.output)}
            </Code>
          </Section>
        ) : null}
        <Section title={t('runs.inspector.steps')} meta={`${run.steps.length}`}>
          <GroupCard padded>
            {run.steps.length === 0 ? (
              <Text size="sm" c="dimmed">
                {active ? t('runs.steps.waiting') : t('runs.steps.empty')}
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
      </Column>
      <Column basis={340}>
        <Section title={t('runs.inspector.summary')}>
          <GroupCard>
            {summaryRows}
            <Row label={t('runs.inspector.status')}>
              <RunStatusBadge status={run.status} />
            </Row>
            <Row label={t('runs.inspector.trigger')}>
              <RunTriggerLabel trigger={run.trigger} />
            </Row>
            {run.version != null ? (
              <Row label={t('runs.inspector.version')}>v{run.version}</Row>
            ) : null}
            <Row label={t('runs.inspector.started')}>
              {formatExact(run.startedAt ?? run.createdAt)}
            </Row>
            <Row label={t('runs.inspector.duration')}>
              {formatDuration(run.durationMs)}
            </Row>
          </GroupCard>
        </Section>
        <Section title={t('runs.inspector.input')}>
          <Code block className={classes.code}>
            {prettyRunValue(run.input ?? {})}
          </Code>
        </Section>
        {run.log ? (
          <Section title={t('runs.inspector.log')}>
            <Code block className={classes.log}>
              {run.log}
            </Code>
          </Section>
        ) : null}
      </Column>
    </Columns>
  );
}
