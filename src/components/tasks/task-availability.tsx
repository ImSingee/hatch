import { Alert } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { AppCompatibilityNotice } from '~components/apps/app-compatibility-notice';
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
  if (app.status === 'archived') {
    return (
      <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
        This App is archived. Restore it from Manage to run its tasks again.
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
        This App isn&apos;t deployed yet. Deploy it from the Agent to run its
        tasks.
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
        The active deployment declares no tasks. Ask the Agent to add a task (a
        backend RPC method with run history) and redeploy.
      </Alert>
    );
  }
  return null;
}
