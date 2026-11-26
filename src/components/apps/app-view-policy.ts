import type { AppStatus } from '~/db/schema';

export function getAppViewState({
  status,
  deploymentRevision,
  hasFrontend,
  runtimeSupported,
}: {
  status: AppStatus;
  deploymentRevision: string | null;
  hasFrontend: boolean;
  runtimeSupported: boolean;
}) {
  const hasLiveDeployment =
    status !== 'archived' && deploymentRevision !== null;
  const isCompatibilityBlocked = hasLiveDeployment && !runtimeSupported;
  return {
    hasLiveDeployment,
    isCompatibilityBlocked,
    canOpen: hasLiveDeployment && hasFrontend && runtimeSupported,
  };
}

/** Whether the App's live deployment can run its frontend here. */
export function canRunApp(app: {
  status: AppStatus;
  deploymentRevision: string | null;
  capabilities?: { frontend?: boolean } | null;
  compatibility?: { isSupported: boolean } | null;
}) {
  return getAppViewState({
    status: app.status,
    deploymentRevision: app.deploymentRevision,
    hasFrontend: Boolean(app.capabilities?.frontend),
    runtimeSupported: app.compatibility?.isSupported ?? false,
  }).canOpen;
}
