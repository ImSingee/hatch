import { Badge, Loader, ThemeIcon } from '@mantine/core';
import { IconCheck, IconClock, IconHandStop, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { RunStatus, RunStepStatus } from '~lib/runs';

/**
 * Run/step status visuals. The theme avoids green badges, so a healthy
 * "succeeded" reads as the accent (paired with a check icon) rather
 * than the conventional green.
 */
const RUN_META: Record<
  RunStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  queued: {
    label: 'Queued',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  running: {
    label: 'Running',
    color: 'primary',
    icon: <Loader size={9} color="primary" />,
  },
  succeeded: {
    label: 'Succeeded',
    color: 'primary',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  failed: {
    label: 'Failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
  canceled: {
    label: 'Canceled',
    color: 'gray',
    icon: <IconHandStop size={11} stroke={2.5} />,
  },
};

export function runStatusColor(status: RunStatus): string {
  return RUN_META[status].color;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
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
      {meta.label}
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
