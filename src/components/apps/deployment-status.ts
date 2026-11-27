/** How each deployment request state is shown, and which can be canceled. */
import type { PlainTranslationKey } from '~i18n';

export const STATUS: Record<
  string,
  { label: PlainTranslationKey; color: string; active: boolean }
> = {
  queued: {
    label: 'deployments.request.status.queued',
    color: 'gray',
    active: true,
  },
  awaiting_artifact: {
    label: 'deployments.request.status.awaitingArtifact',
    color: 'gray',
    active: true,
  },
  building: {
    label: 'deployments.request.status.building',
    color: 'blue',
    active: true,
  },
  verifying: {
    label: 'deployments.request.status.verifying',
    color: 'blue',
    active: true,
  },
  releasing: {
    label: 'deployments.request.status.releasing',
    color: 'blue',
    active: true,
  },
  ready: {
    label: 'deployments.request.status.ready',
    color: 'primary',
    active: false,
  },
  failed: {
    label: 'deployments.request.status.failed',
    color: 'red',
    active: false,
  },
  canceled: {
    label: 'deployments.request.status.canceled',
    color: 'gray',
    active: false,
  },
  superseded: {
    label: 'deployments.request.status.superseded',
    color: 'gray',
    active: false,
  },
};

export const CANCELABLE = new Set(['queued', 'awaiting_artifact', 'building']);
