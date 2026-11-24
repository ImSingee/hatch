/** Pure rollback policy shared by deployment summaries and execution guards. */

export const APP_DATABASE_ROLLBACK_BLOCKED_REASON =
  "The app database was permanently deleted. Restore this deployment tag's " +
  'files onto current master, commit them, and deploy as a new release to ' +
  'provision a new database.';

export const APP_DATA_TABLE_ROLLBACK_BLOCKED_REASON =
  'The Data Table database was permanently deleted. Restore this deployment ' +
  "tag's files onto current master, commit them, and deploy as a new release " +
  'to provision a new Data Table database.';

export const APP_DATABASES_ROLLBACK_BLOCKED_REASON =
  'The app database and Data Table database were permanently deleted. ' +
  "Restore this deployment tag's files onto current master, commit them, and " +
  'deploy as a new release to provision new databases.';

/** True only for a persisted normalized manifest that explicitly needs DB. */
export function deploymentRequiresDatabase(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  return (capabilities as { database?: unknown }).database === true;
}

/** True only for a persisted normalized manifest that enables Data Tables. */
export function deploymentRequiresDataTable(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  return (capabilities as { dataTable?: unknown }).dataTable === true;
}

/**
 * Which permanently deleted resource makes a rollback unsafe. The Web UI
 * translates this; the CLI, RPC and Agent read the English reason.
 */
export type RollbackBlockedCode = 'database' | 'dataTable' | 'databases';

const ROLLBACK_BLOCKED_REASONS: Record<RollbackBlockedCode, string> = {
  database: APP_DATABASE_ROLLBACK_BLOCKED_REASON,
  dataTable: APP_DATA_TABLE_ROLLBACK_BLOCKED_REASON,
  databases: APP_DATABASES_ROLLBACK_BLOCKED_REASON,
};

/** Combine missing persistent resources into the single rollback blocker. */
export function deploymentRollbackBlockedCode(
  resources: {
    dbName: string | null | undefined;
    dataDbName: string | null | undefined;
    dataDbPasswordCiphertext: string | null | undefined;
  },
  manifest: unknown,
): RollbackBlockedCode | null {
  const database = !resources.dbName && deploymentRequiresDatabase(manifest);
  const dataTable =
    !(resources.dataDbName && resources.dataDbPasswordCiphertext) &&
    deploymentRequiresDataTable(manifest);
  if (database && dataTable) return 'databases';
  if (database) return 'database';
  return dataTable ? 'dataTable' : null;
}

/** The English explanation of a rollback blocker (the wire field). */
export function rollbackBlockedReason(
  code: RollbackBlockedCode | null,
): string | null {
  return code ? ROLLBACK_BLOCKED_REASONS[code] : null;
}
