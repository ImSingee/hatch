import { Alert } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { AppCompatibilityNotice } from '~components/apps/app-compatibility-notice';
import { useI18n } from '~i18n';
import type { AppDetail } from '~server/apps';

/**
 * Why an App's tasks cannot run right now, or null when they can: not
 * deployed, archived, blocked by compatibility, or no tasks declared.
 */
export function TaskAvailabilityNotice({
  app,
  hasTasks,
}: {
  app: AppDetail;
  hasTasks: boolean;
}) {
  const { t } = useI18n();
  if (app.status === 'archived') {
    return (
      <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
        {t('tasks.notice.archived')}
      </Alert>
    );
  }
  if (app.compatibility && !app.compatibility.isSupported) {
    return <AppCompatibilityNotice compatibility={app.compatibility} />;
  }
  if (!app.deploymentRevision) {
    return (
      <Alert
        color="primary"
        variant="light"
        icon={<IconInfoCircle size={16} />}
      >
        {t('tasks.notice.notDeployed')}
      </Alert>
    );
  }
  if (!hasTasks) {
    return (
      <Alert
        color="primary"
        variant="light"
        icon={<IconInfoCircle size={16} />}
      >
        {t('tasks.notice.noTasks')}
      </Alert>
    );
  }
  return null;
}
