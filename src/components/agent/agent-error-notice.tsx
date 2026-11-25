import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import type { StopReason } from '@earendil-works/pi-ai';
import {
  IconAlertTriangle,
  IconPlayerStop,
  IconRefresh,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useI18n, type PlainTranslationKey } from '~i18n';
import classes from './chat.module.css';

/** The failed turn's automatic retry, on this browser's clock. */
export type AutoRetryStatus = {
  /** Consecutive failures so far; the scheduled retry is this attempt. */
  attempt: number;
  maxAttempts: number;
  /** Epoch ms of the scheduled retry; null once stopped or exhausted. */
  nextRetryAt: number | null;
  /** A retry is held until the Agent Runner settles the failed run. */
  waitingForRunner: boolean;
};

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function AutoRetryLine({
  status,
  scheduledAt,
}: {
  status: AutoRetryStatus;
  scheduledAt: number | null;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useInterval(() => setNow(Date.now()), 1000, {
    autoInvoke: scheduledAt !== null,
  });

  let text: string;
  const progress = { attempt: status.attempt, max: status.maxAttempts };
  if (scheduledAt !== null) {
    const remaining = scheduledAt - now;
    text =
      remaining > 0
        ? t('agent.autoRetry.in', {
            ...progress,
            remaining: formatRemaining(remaining),
          })
        : t('agent.autoRetry.now', progress);
  } else if (status.waitingForRunner) {
    text = t('agent.autoRetry.waitingForRunner', progress);
  } else if (status.attempt > status.maxAttempts) {
    text = t('agent.autoRetry.exhausted', { count: status.maxAttempts });
  } else {
    text = t('agent.autoRetry.stopped');
  }
  return (
    <Text size="xs" c="dimmed" data-testid="agent-auto-retry-status">
      {text}
    </Text>
  );
}

/** Retry actions for the failed turn the notice belongs to. */
export type RetryControls = {
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  autoRetry?: AutoRetryStatus;
  onStopAutoRetry?: () => void;
  stoppingAutoRetry?: boolean;
};

/**
 * Failure sentences the platform itself stores on interrupted or failed runs
 * (`src/server/agent-runs.ts`, the run events route). They are persisted as
 * English text, so the notice recognises them and shows the translation;
 * provider and model errors stay as they arrived.
 */
const PLATFORM_RUN_ERRORS: Record<string, PlainTranslationKey> = {
  'Agent run was interrupted because its Agent Runner stayed disconnected past the lease window.':
    'agent.error.platform.leaseExpired',
  'Agent run was interrupted because the Agent Runner restarted.':
    'agent.error.platform.runnerRestarted',
  'Agent run was interrupted because its Agent Runner went away.':
    'agent.error.platform.runnerGone',
  'Agent run was interrupted.': 'agent.error.platform.interrupted',
  'Agent run is no longer active (its runner went away).':
    'agent.error.platform.noLongerActive',
  'Agent run failed.': 'agent.error.platform.failed',
};

export function AgentErrorNotice({
  message,
  live = false,
  onRetry,
  retrying = false,
  retryDisabled = false,
  autoRetry,
  onStopAutoRetry,
  stoppingAutoRetry = false,
}: RetryControls & {
  message?: string;
  /** Announce a newly arrived live error; persisted history stays quiet. */
  live?: boolean;
}) {
  const { t } = useI18n();
  const scheduledAt =
    autoRetry && autoRetry.attempt > 0 ? autoRetry.nextRetryAt : null;
  // An automatic retry is pending, with or without a known time.
  const retryPending =
    scheduledAt !== null ||
    (autoRetry !== undefined &&
      autoRetry.attempt > 0 &&
      autoRetry.waitingForRunner);
  return (
    <Alert
      className={classes.agentErrorNotice}
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={18} stroke={1.7} aria-hidden />}
      title={t('agent.error.title')}
      role={live ? 'alert' : 'note'}
    >
      <Stack gap="xs" align="flex-start" className={classes.agentErrorBody}>
        <Text component="div" size="sm" className={classes.agentErrorDetail}>
          {(() => {
            const text = message?.trim();
            if (!text) return t('agent.error.unknown');
            const key = Object.hasOwn(PLATFORM_RUN_ERRORS, text)
              ? PLATFORM_RUN_ERRORS[text]
              : undefined;
            return key ? t(key) : text;
          })()}
        </Text>
        {autoRetry && autoRetry.attempt > 0 ? (
          // Remount per schedule: the ticking interval starts on mount.
          <AutoRetryLine
            key={scheduledAt ?? 'idle'}
            status={autoRetry}
            scheduledAt={scheduledAt}
          />
        ) : null}
        {onRetry ? (
          <Group gap="xs">
            <Button
              type="button"
              size="compact-sm"
              variant="default"
              leftSection={<IconRefresh size={14} stroke={1.8} aria-hidden />}
              onClick={onRetry}
              loading={retrying}
              disabled={retrying || retryDisabled}
              aria-busy={retrying || undefined}
            >
              {retryPending ? t('agent.error.retryNow') : t('common.retry')}
            </Button>
            {retryPending && onStopAutoRetry ? (
              <Button
                type="button"
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={
                  <IconPlayerStop size={14} stroke={1.8} aria-hidden />
                }
                onClick={onStopAutoRetry}
                loading={stoppingAutoRetry}
                disabled={stoppingAutoRetry || retrying}
              >
                {t('agent.error.stopRetrying')}
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Alert>
  );
}

/** What the terminal stop reason says about why the reply ended early. */
function endedEarlyKey(
  stopReason: StopReason | undefined,
): PlainTranslationKey {
  switch (stopReason) {
    case 'length':
      return 'agent.endedEarly.length';
    case 'toolUse':
      return 'agent.endedEarly.toolUse';
    default:
      return 'agent.endedEarly.stopped';
  }
}

/**
 * A completed reply that did not end normally — truncated output or a turn
 * that stopped mid-work. Not a failure, so no retry; the notice explains why
 * the answer may look unfinished.
 */
export function EndedEarlyNotice({
  stopReason,
  live = false,
}: {
  stopReason?: StopReason;
  /** Announce a newly arrived live end; persisted history stays quiet. */
  live?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Alert
      className={classes.agentErrorNotice}
      color="yellow"
      variant="light"
      icon={<IconAlertTriangle size={18} stroke={1.7} aria-hidden />}
      title={t('agent.endedEarly.title')}
      role={live ? 'alert' : 'note'}
    >
      <Text component="div" size="sm" className={classes.agentErrorDetail}>
        {t(endedEarlyKey(stopReason))}
      </Text>
    </Alert>
  );
}
