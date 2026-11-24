export type RollbackResult = {
  version: number;
  dataSchemaMismatch: boolean;
};

export function rollbackNotification(result: RollbackResult): {
  tone: 'success' | 'warning';
  /** Catalog key; takes the restored `version`. */
  key: 'deployments.restored' | 'deployments.restoredSchemaMismatch';
} {
  if (result.dataSchemaMismatch) {
    return { tone: 'warning', key: 'deployments.restoredSchemaMismatch' };
  }
  return { tone: 'success', key: 'deployments.restored' };
}

export function requiresDataSchemaConfirmation(
  deployment: { dataSchemaMismatch: boolean } | undefined,
): boolean {
  return deployment?.dataSchemaMismatch === true;
}
