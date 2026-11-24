import { Button, Group, Loader, Text } from '@mantine/core';
import { IconAlertCircle, IconCheck, IconPencil } from '@tabler/icons-react';
import type { DashboardBreakpoint } from '~/lib/dashboard-layout';
import { DashboardLayoutPreview } from './dashboard-layout-preview';
import { useI18n } from '~i18n';
import { useRefreshText } from './desk-toolbar';
import type { DashboardDraftStatus } from './use-dashboard-draft';
import classes from './editor-heading.module.css';

/** The layout editor's heading, in place of the greeting while editing. */
export function EditorHeading({
  dashboardName,
  autoRefreshSeconds,
  widgetCount,
  previewBreakpoint,
  onPreviewChange,
  status,
  onCheckStatus,
  onDone,
  doneDisabled,
}: {
  dashboardName: string;
  autoRefreshSeconds: number;
  widgetCount: number;
  previewBreakpoint: DashboardBreakpoint;
  onPreviewChange: (value: DashboardBreakpoint) => void;
  status: DashboardDraftStatus;
  onCheckStatus: () => void;
  onDone: () => void;
  doneDisabled: boolean;
}) {
  const { t } = useI18n();
  const refreshText = useRefreshText();
  return (
    <div
      className={classes.root}
      role="toolbar"
      aria-label={t('dashboard.editor.label')}
    >
      <div className={classes.text}>
        <span className={classes.eyebrow}>
          <IconPencil size={13} stroke={2.4} aria-hidden />
          {t('dashboard.editor.eyebrow')}
        </span>
        <h1 className={classes.title}>{t('dashboard.editor.title')}</h1>
        <span className={classes.hint}>
          {t('dashboard.editor.hint', { count: widgetCount })}
        </span>
      </div>
      <div className={classes.controls}>
        <DashboardLayoutPreview
          value={previewBreakpoint}
          onChange={onPreviewChange}
        />
        <Text component="span" size="sm" c="dimmed" fw={600}>
          {dashboardName} · {refreshText(autoRefreshSeconds)}
        </Text>
        <DraftStatus status={status} onCheckStatus={onCheckStatus} />
        <Button
          type="button"
          size="md"
          leftSection={<IconCheck size={16} stroke={2.2} />}
          loading={status.state === 'saving'}
          disabled={doneDisabled}
          onClick={onDone}
        >
          {t('common.done')}
        </Button>
      </div>
    </div>
  );
}

function DraftStatus({
  status,
  onCheckStatus,
}: {
  status: DashboardDraftStatus;
  onCheckStatus: () => void;
}) {
  const { t } = useI18n();
  if (
    status.state === 'conflict' ||
    status.state === 'error' ||
    status.state === 'unknown'
  )
    return (
      <Group gap="xs" className={classes.draftError} wrap="nowrap" role="alert">
        <IconAlertCircle size={16} stroke={1.8} />
        <Text size="sm" fw={600}>
          {t(status.messageKey)}
        </Text>
        {status.state === 'unknown' ? (
          <Button
            type="button"
            variant="subtle"
            color="red"
            size="compact-xs"
            onClick={onCheckStatus}
          >
            {t('dashboard.editor.checkStatus')}
          </Button>
        ) : null}
      </Group>
    );
  if (status.state === 'checking')
    return (
      <Group gap={6} className={classes.draftStatus} aria-live="polite">
        <Loader size={14} />
        <Text size="sm" fw={600}>
          {t('dashboard.editor.checking')}
        </Text>
      </Group>
    );
  return null;
}
