import { db } from '~/db';

/**
 * Whether a backend built for a superseded deployment may keep using the
 * Data Table API.
 *
 * A deploy or rollback retires the previous backend instances but lets them
 * finish the requests they already hold. Those requests are served against
 * the schema snapshot stored in the App's Data database, whose hash is the
 * App's `dataSchemaHash`. A superseded deployment recorded with that same
 * hash was built for exactly the schema that is live, so its calls stay
 * valid; any other deployment would run old code against a migrated schema
 * and is rejected as stale.
 */
export async function supersededDeploymentSharesDataSchema(
  id: string,
  deploymentId: string,
  currentDataSchemaHash: string | null | undefined,
): Promise<boolean> {
  if (!deploymentId || !currentDataSchemaHash) return false;
  const deployment = await db.query.deployments.findFirst({
    where: { id: deploymentId, appId: id },
    columns: { dataSchemaHash: true },
  });
  return deployment?.dataSchemaHash === currentDataSchemaHash;
}
