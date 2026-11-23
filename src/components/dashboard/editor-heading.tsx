import { Button, Group, Loader, Text } from '@mantine/core';
import { IconAlertCircle, IconCheck, IconPencil } from '@tabler/icons-react';
import type { DashboardBreakpoint } from '~/lib/dashboard-layout';
import { DashboardLayoutPreview } from './dashboard-layout-preview';
import { refreshText } from './desk-toolbar';
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
  return (
    <div className={classes.root} role="toolbar" aria-label="Dashboard editor">
      <div className={classes.text}>
        <span className={classes.eyebrow}>
          <IconPencil size={13} stroke={2.4} aria-hidden />
          Editing
        </span>
        <h1 className={classes.title}>Edit desk layout</h1>
        <span className={classes.hint}>
          Drag a widget by its handle, switch its size or remove it with the
          corner button. {widgetCount}{' '}
          {widgetCount === 1 ? 'widget is' : 'widgets are'} on this desk.
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
          Done
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
  if (
    status.state === 'conflict' ||
    status.state === 'error' ||
    status.state === 'unknown'
  )
    return (
      <Group gap="xs" className={classes.draftError} wrap="nowrap" role="alert">
        <IconAlertCircle size={16} stroke={1.8} />
        <Text size="sm" fw={600}>
          {status.message}
        </Text>
        {status.state === 'unknown' ? (
          <Button
            type="button"
            variant="subtle"
            color="red"
            size="compact-xs"
            onClick={onCheckStatus}
          >
            Check status
          </Button>
        ) : null}
      </Group>
    );
  if (status.state === 'checking')
    return (
      <Group gap={6} className={classes.draftStatus} aria-live="polite">
        <Loader size={14} />
        <Text size="sm" fw={600}>
          Checking save status
        </Text>
      </Group>
    );
  return null;
}
