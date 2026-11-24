import { Badge, Loader, ThemeIcon } from '@mantine/core';
import { IconCheck, IconClock, IconHandStop, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useI18n, type PlainTranslationKey } from '~i18n';
import type { RunStatus, RunStepStatus } from '~lib/runs';

/**
 * Run/step status visuals. The theme avoids green badges, so a healthy
 * "succeeded" reads as the accent (paired with a check icon) rather
 * than the conventional green.
 */
const RUN_META: Record<
  RunStatus,
  { label: PlainTranslationKey; color: string; icon: ReactNode }
> = {
  queued: {
    label: 'runStatus.queued',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  running: {
    label: 'runStatus.running',
    color: 'primary',
    icon: <Loader size={9} color="primary" />,
  },
  succeeded: {
    label: 'runStatus.succeeded',
    color: 'primary',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  failed: {
    label: 'runStatus.failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
  canceled: {
    label: 'runStatus.canceled',
    color: 'gray',
    icon: <IconHandStop size={11} stroke={2.5} />,
  },
};

const TRIGGER_LABELS: Record<string, PlainTranslationKey> = {
  manual: 'runTrigger.manual',
  cron: 'runTrigger.cron',
  webhook: 'runTrigger.webhook',
  app: 'runTrigger.app',
};

/** How a run started, translated; an unknown trigger shows as recorded. */
export function RunTriggerLabel({ trigger }: { trigger: string }) {
  const { t } = useI18n();
  const key = TRIGGER_LABELS[trigger];
  return key ? t(key) : trigger;
}

export function runStatusColor(status: RunStatus): string {
  return RUN_META[status].color;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { t } = useI18n();
  const meta = RUN_META[status];
  return (
    <Badge
      color={meta.color}
      variant={status === 'running' ? 'filled' : 'light'}
      radius="sm"
      leftSection={
        status === 'running' ? null : (
          <span style={{ display: 'inline-flex' }}>{meta.icon}</span>
        )
      }
    >
      {t(meta.label)}
    </Badge>
  );
}

/** A small bullet for a run/step status, used as a Timeline bullet. */
export function RunStatusBullet({
  status,
  filled,
}: {
  status: RunStatus | RunStepStatus;
  filled?: boolean;
}) {
  const color =
    status === 'failed' ? 'red' : status === 'running' ? 'gray' : 'primary';
  const icon =
    status === 'failed' ? (
      <IconX size={11} stroke={2.5} />
    ) : status === 'running' ? (
      <Loader size={9} />
    ) : (
      <IconCheck size={11} stroke={2.5} />
    );
  return (
    <ThemeIcon
      size={20}
      radius="xl"
      color={color}
      variant={filled ? 'filled' : 'light'}
    >
      {icon}
    </ThemeIcon>
  );
}
