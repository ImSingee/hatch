import {
  ActionIcon,
  Badge,
  Group,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { StatusDot } from '~components/apps/operations-panel/section-header';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { formatExact, formatRelativeTime } from '~lib/format';
import { appBackendsQueryOptions, appOpsQueryOptions } from '~queries/apps';
import {
  restartAppBackendFn,
  startAppBackendFn,
  stopAppBackendFn,
  type AppBackendRuntime,
} from '~server/apps';

function backendStatusLabel(runtime: AppBackendRuntime): PlainTranslationKey {
  if (runtime.state === 'running') return 'backends.status.running';
  if (runtime.state === 'starting') return 'backends.status.starting';
  // Stopped but still marked keep-alive: it crashed and the platform has an
  // automatic restart pending (backoff timer).
  if (runtime.keepAlive) return 'backends.status.restarting';
  return 'backends.status.stopped';
}

/** The signal or exit code the backend last stopped with, or a dash. */
export function BackendLastExit({ runtime }: { runtime: AppBackendRuntime }) {
  const { t } = useI18n();
  return (
    <Text size="sm" c="dimmed" ff="monospace">
      {runtime.lastExitSignal ??
        (runtime.lastExitCode != null
          ? t('backends.lastExitCode', { code: runtime.lastExitCode })
          : '—')}
    </Text>
  );
}

/** Relative timestamp with the exact time in a tooltip, or a dash. */
export function BackendTime({ value }: { value: string | null }) {
  const { locale } = useI18n();
  if (!value) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Tooltip label={formatExact(value)} withArrow>
      <Text size="sm" c="dimmed" style={{ cursor: 'default' }}>
        {formatRelativeTime(value, locale)}
      </Text>
    </Tooltip>
  );
}

/**
 * Status dot + label, plus the auto-restart counter and last-error indicator
 * when present. Shared by the Backends table and the app's Operations panel
 * so both surfaces always tell the same story.
 */
export function BackendStatus({
  runtime,
  size = 'sm',
  dimmed = false,
}: {
  runtime: AppBackendRuntime;
  size?: 'xs' | 'sm';
  dimmed?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Group gap={6} wrap="nowrap">
      <StatusDot active={runtime.state === 'running'} />
      <Text size={size} c={dimmed ? 'dimmed' : undefined}>
        {t(backendStatusLabel(runtime))}
      </Text>
      {runtime.restartCount > 0 && (
        <Tooltip
          label={t('backends.autoRestarted', { count: runtime.restartCount })}
          withArrow
        >
          <Badge size="xs" variant="light" color="yellow">
            ×{runtime.restartCount}
          </Badge>
        </Tooltip>
      )}
      {runtime.drainingInstances > 0 && (
        <Tooltip
          label={t('backends.drainingHint', {
            count: runtime.drainingInstances,
          })}
          withArrow
          multiline
          maw={360}
        >
          <Badge size="xs" variant="light" color="gray">
            {t('backends.draining', { count: runtime.drainingInstances })}
          </Badge>
        </Tooltip>
      )}
      {runtime.lastError && (
        <Tooltip label={runtime.lastError} withArrow multiline maw={360}>
          <ThemeIcon size="xs" variant="transparent" color="red">
            <IconAlertTriangle size={14} stroke={1.8} />
          </ThemeIcon>
        </Tooltip>
      )}
    </Group>
  );
}

/**
 * Start / Stop / Restart controls for one app backend. Owns the mutations and
 * refreshes both the Backends list and the app's Operations panel whether the
 * action worked or not — a failure usually means the state changed under us.
 */
export function BackendControls({
  appId,
  runtime,
  name,
  size = 'md',
  runtimeSupported = true,
}: {
  appId: string;
  runtime: AppBackendRuntime;
  /** App name for the action labels; without it they name "backend". */
  name?: string;
  /** Icon button size; "sm" fits inline in a section header. */
  size?: 'sm' | 'md';
  /** Unsupported deployments may be stopped, but cannot start or restart. */
  runtimeSupported?: boolean;
}) {
  const { t } = useI18n();
  const iconSize = size === 'sm' ? 14 : 16;
  const qc = useQueryClient();
  const settled = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: appBackendsQueryOptions.queryKey }),
      qc.invalidateQueries({ queryKey: appOpsQueryOptions(appId).queryKey }),
    ]);

  const start = useMutation({
    mutationFn: () => startAppBackendFn({ data: appId }),
    onSettled: settled,
    onSuccess: () => toast.success(t('backends.toast.started')),
  });
  const stop = useMutation({
    mutationFn: (force: boolean) =>
      stopAppBackendFn({ data: { id: appId, force } }),
    onSettled: settled,
    onSuccess: (_result, force) =>
      toast.success(
        t(force ? 'backends.toast.forceStopped' : 'backends.toast.stopped'),
      ),
  });
  const restart = useMutation({
    mutationFn: () => restartAppBackendFn({ data: appId }),
    onSettled: settled,
    onSuccess: () => toast.success(t('backends.toast.restarted')),
  });

  const pending = start.isPending || stop.isPending || restart.isPending;
  const running = runtime.state === 'running';
  // Stop also cancels a boot in progress (starting) and a crashed keep-alive
  // backend's pending auto-restart (stopped but still marked keep-alive).
  const stoppable = runtime.state !== 'stopped' || runtime.keepAlive;
  // A stop is graceful: retired instances keep finishing the requests they
  // hold. Once nothing else is left to stop, the same button ends those too.
  const forceStop = !stoppable && runtime.drainingInstances > 0;

  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip
        label={t(
          runtimeSupported
            ? 'backends.action.start'
            : 'backends.action.startUnsupported',
        )}
        withArrow
      >
        <ActionIcon
          variant="subtle"
          color="teal"
          size={size}
          loading={start.isPending}
          disabled={
            !runtimeSupported ||
            pending ||
            running ||
            runtime.state === 'starting'
          }
          onClick={() => start.mutate()}
          aria-label={
            name
              ? t('backends.action.startNamed', { name })
              : t('backends.action.startBackend')
          }
        >
          <IconPlayerPlay size={iconSize} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
      <Tooltip
        label={t(
          forceStop
            ? 'backends.action.forceStopHint'
            : !running && stoppable
              ? 'backends.action.stopCancelsRestart'
              : 'backends.action.stop',
        )}
        withArrow
      >
        <ActionIcon
          variant="subtle"
          color="red"
          size={size}
          loading={stop.isPending}
          disabled={pending || (!stoppable && !forceStop)}
          onClick={() => stop.mutate(forceStop)}
          aria-label={
            forceStop
              ? name
                ? t('backends.action.forceStopNamed', { name })
                : t('backends.action.forceStopBackend')
              : name
                ? t('backends.action.stopNamed', { name })
                : t('backends.action.stopBackend')
          }
        >
          <IconPlayerStop size={iconSize} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
      <Tooltip
        label={t(
          runtimeSupported
            ? 'backends.action.restart'
            : 'backends.action.restartUnsupported',
        )}
        withArrow
      >
        <ActionIcon
          variant="subtle"
          color="gray"
          size={size}
          loading={restart.isPending}
          disabled={!runtimeSupported || pending}
          onClick={() => restart.mutate()}
          aria-label={
            name
              ? t('backends.action.restartNamed', { name })
              : t('backends.action.restartBackend')
          }
        >
          <IconRefresh size={iconSize} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
