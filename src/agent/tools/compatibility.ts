import type { DeploymentCompatibility } from '~/deployment-compatibility';

/** App deployment compatibility copy shown to the Agent. */
const SKILL_NAME = 'app-compatibility';

export function compatibilityListSummary(
  compatibility: DeploymentCompatibility,
): string {
  if (compatibility.isLatest) return '';
  if (compatibility.isSupported) {
    return ` (update available; read the \`${SKILL_NAME}\` Skill)`;
  }
  return compatibility.version > compatibility.latestVersion
    ? ' (runtime disabled; update the platform before running this deployment)'
    : ` (runtime disabled; read the \`${SKILL_NAME}\` Skill before updating and redeploying)`;
}

export function compatibilityDetailGuidance(
  compatibility: DeploymentCompatibility,
): string {
  if (compatibility.isSupported) {
    return compatibility.isLatest
      ? ''
      : ` — read the \`${SKILL_NAME}\` Skill, then redeploy to update`;
  }
  return compatibility.version > compatibility.latestVersion
    ? ' — runtime disabled; update the platform before running this deployment'
    : ` — runtime disabled; read the \`${SKILL_NAME}\` Skill before updating and redeploying`;
}

export function compatibilityRollbackWarning(
  compatibility: DeploymentCompatibility,
): string {
  if (!compatibility.isSupported) {
    if (compatibility.version > compatibility.latestVersion) {
      return (
        `Warning: compatibility v${compatibility.version} is newer than this ` +
        `platform's latest supported v${compatibility.latestVersion}. This ` +
        `App cannot run until the platform is updated.`
      );
    }
    return (
      `Warning: compatibility v${compatibility.version} is below the platform ` +
      `minimum v${compatibility.minimumSupportedVersion}; read the ` +
      `\`${SKILL_NAME}\` Skill. This App cannot run ` +
      'until it is updated and redeployed.'
    );
  }
  return compatibility.isLatest
    ? ''
    : `Compatibility v${compatibility.version} is older than latest v${compatibility.latestVersion}; read the \`${SKILL_NAME}\` Skill, then redeploy to update it.`;
}
