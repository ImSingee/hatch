import { appAccessAllows } from '~server/apps/manifest';
import {
  DATA_REQUEST_MAX_BYTES,
  mutateDataTable,
  queryDataTable,
} from '~server/apps/data-table/service';
import { readCappedText } from '~server/http-body';
import { dataErrorResponse } from '../data-errors';
import type { AccessContext } from './index';
import { accessError, capabilityMissing, notGranted } from './errors';

type Access = { table: string; access: 'read' | 'write' };

/** The tables a Data request touches, or null when it names none clearly. */
function touchedTables(action: string, body: unknown): Access[] | null {
  if (!body || typeof body !== 'object') return null;
  if (action === 'query') {
    const table = (body as { table?: unknown }).table;
    return typeof table === 'string' ? [{ table, access: 'read' }] : null;
  }
  const operations = (body as { operations?: unknown }).operations;
  if (!Array.isArray(operations) || operations.length === 0) return null;
  const tables: Access[] = [];
  for (const operation of operations) {
    const table = (operation as { table?: unknown } | null)?.table;
    if (typeof table !== 'string') return null;
    tables.push({ table, access: 'write' });
  }
  return tables;
}

/**
 * Query or mutate the target's Data Tables, with the same request and
 * response shapes as its own Data API. Realtime events and raw SQL are not
 * relayed.
 */
export async function handleDataAccess(
  context: AccessContext,
): Promise<Response> {
  const { request, target, grant } = context;
  const action = context.rest.slice(1);
  if (action !== 'query' && action !== 'mutate') {
    return accessError(
      404,
      'not_found',
      'Data access supports only /data/query and /data/mutate.',
    );
  }
  if (request.method !== 'POST') {
    return accessError(405, 'invalid_argument', 'Use POST.');
  }
  if (!target.capabilities.dataTable) {
    return capabilityMissing(target.id, 'Data Tables');
  }
  const raw = await readCappedText(request, DATA_REQUEST_MAX_BYTES);
  if (raw === null) {
    return accessError(413, 'resource_exhausted', 'Payload too large.');
  }
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return accessError(400, 'invalid_argument', 'Invalid JSON body.');
  }
  const tables = touchedTables(action, body);
  if (!tables) {
    return accessError(
      400,
      'invalid_argument',
      action === 'query'
        ? 'A query names its table.'
        : 'A mutation lists operations that each name a table.',
    );
  }
  for (const { table, access } of tables) {
    if (!appAccessAllows(grant, { kind: 'data', table, access })) {
      return notGranted(
        `${access === 'read' ? 'Reading' : 'Writing'} ${table}`,
      );
    }
  }
  const options = { expectedDeploymentId: target.currentDeploymentId };
  try {
    return Response.json(
      action === 'query'
        ? await queryDataTable(target.id, body, options)
        : await mutateDataTable(target.id, body, options),
    );
  } catch (error) {
    const response = dataErrorResponse(error);
    if (response.status === 503) response.headers.set('retry-after', '1');
    return response;
  }
}
