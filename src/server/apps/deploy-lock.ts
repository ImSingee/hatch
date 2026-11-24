import { createDeployLock } from '~server/deploy-lock';

/** Shared App lifecycle lock; advisory-lock namespace 1. */
export const appDeployLock = createDeployLock(1);
