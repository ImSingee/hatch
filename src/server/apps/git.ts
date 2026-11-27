/** Server-only: Git-backed source storage for Hatch apps. */
import { appRepoDir } from '~agent/paths';
import {
  DEPLOY_TAG_PREFIX,
  SOURCE_BRANCH,
  createGitSource,
  type PublishedSource,
} from '../source-git';

export const APP_SOURCE_BRANCH = SOURCE_BRANCH;
export { DEPLOY_TAG_PREFIX };
export type { PublishedSource };

const core = createGitSource({
  noun: 'app',
  repoDir: appRepoDir,
});

export const ensureAppRepo = core.ensureRepo;
export const appMasterCommit = core.masterCommit;
export const archiveAppCommit = core.archiveCommit;
export const checkoutAppCommit = core.checkoutCommitInto;
export const appCommitOnMaster = core.commitOnMaster;
export const resolveDeployCommit = core.resolveDeployCommit;
export const publishDeploymentSource = core.publishDeploymentSource;
export const deleteDeploymentTag = core.deleteDeploymentTag;
export const moveMasterToDeploymentTag = core.moveMasterToDeploymentTag;
