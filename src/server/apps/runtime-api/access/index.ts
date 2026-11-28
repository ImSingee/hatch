/**
 * App-to-App relay: `/api/app/<caller>/access/<target>/<kind>/<rest>`.
 *
 * Only the caller's backend can use it: it signs time, its own id, the method
 * and the path with its signing secret (see `appAccessSignaturePayload`).
 * Browser and platform credentials are refused, so a frontend has to go
 * through its own backend. What may be reached is the `appAccess` declared by
 * the caller's current deployment.
 */
import { db } from '~/db';
import type { AppCapabilities } from '~/db/schema';
import { assertSupportedDeployment } from '~server/apps/compatibility';
import {
  type AppAccessGrant,
  findAppAccessGrant,
  type NormalizedManifest,
} from '~server/apps/manifest';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  appAccessSignaturePayload,
  verifyHatchSignature,
} from '~server/secrets';
import { accessError } from './errors';
import { handleDataAccess } from './data';
import { handleHookAccess } from './hook';
import { handleRpcAccess } from './rpc';
import { handleTaskAccess } from './tasks';

export type AccessKind = 'rpc' | 'data' | 'tasks' | 'hook';

export type AccessContext = {
  request: Request;
  callerId: string;
  target: {
    id: string;
    signingSecret: string;
    currentDeploymentId: string;
    capabilities: Partial<AppCapabilities>;
  };
  grant: AppAccessGrant;
  /** `/api/app/<caller>/access/<target>/<kind>`, stripped before forwarding. */
  base: string;
  /** The path below `base`: empty or starting with `/`. */
  rest: string;
  /** Serve the request again once, after a deploy raced the forward. */
  retry: (() => Promise<Response>) | null;
};

const KINDS = new Set<AccessKind>(['rpc', 'data', 'tasks', 'hook']);
const PATH_RE =
  /^\/api\/app\/([^/]+)\/access\/([^/]+)\/(rpc|data|tasks|hook)(\/.*)?$/;

export async function handleAppAccessRequest(
  { request }: { request: Request },
  retried = false,
): Promise<Response> {
  for (const header of ['cookie', 'authorization', 'x-api-key']) {
    if (request.headers.has(header)) {
      return accessError(
        403,
        'permission_denied',
        'App access is for App backends only; browser and platform credentials are refused. Call your own backend and let it relay.',
      );
    }
  }
  const url = new URL(request.url);
  const match = PATH_RE.exec(url.pathname);
  if (!match || !KINDS.has(match[3] as AccessKind)) {
    return accessError(404, 'not_found', 'Unknown App access path.');
  }
  const [, callerId, target, kindName, restPath = ''] = match;
  const kind = kindName as AccessKind;

  const caller = await db.query.apps.findFirst({
    where: { id: callerId },
    columns: { status: true, currentDeploymentId: true, signingSecret: true },
  });
  const prefix = `/api/app/${callerId}/access`;
  const verified =
    caller?.signingSecret &&
    verifyHatchSignature({
      secret: caller.signingSecret,
      timestamp: request.headers.get(HATCH_TIMESTAMP_HEADER),
      signature: request.headers.get(HATCH_SIGNATURE_HEADER),
      payload: appAccessSignaturePayload(
        callerId,
        request.method,
        `${url.pathname.slice(prefix.length)}${url.search}`,
      ),
    });
  if (
    !caller ||
    !verified ||
    caller.status === 'archived' ||
    !caller.currentDeploymentId
  ) {
    return accessError(
      401,
      'unauthenticated',
      'The App access signature is missing, stale or invalid.',
    );
  }

  const deployment = await db.query.deployments.findFirst({
    where: { id: caller.currentDeploymentId, appId: callerId },
    columns: { manifestNormalized: true },
  });
  const grants = (deployment?.manifestNormalized as NormalizedManifest | null)
    ?.appAccess;
  const grant = findAppAccessGrant(grants, decodeURIComponent(target));
  if (!grant) {
    return accessError(
      403,
      'permission_denied',
      `"${target}" is not listed in this App's appAccess.`,
    );
  }

  const app = await db.query.apps.findFirst({
    where: { id: grant.app },
    columns: {
      id: true,
      status: true,
      currentDeploymentId: true,
      signingSecret: true,
      capabilities: true,
    },
  });
  if (!app || app.status === 'archived' || !app.currentDeploymentId) {
    return accessError(404, 'not_found', `App "${grant.app}" is not deployed.`);
  }
  if (!app.signingSecret) {
    return accessError(
      503,
      'unavailable',
      `App "${grant.app}" must be redeployed before other Apps can reach it.`,
    );
  }
  try {
    await assertSupportedDeployment(app.currentDeploymentId);
  } catch {
    return accessError(
      503,
      'unavailable',
      `App "${grant.app}" cannot run on this platform.`,
    );
  }

  const context: AccessContext = {
    request,
    callerId,
    target: {
      id: app.id,
      signingSecret: app.signingSecret,
      currentDeploymentId: app.currentDeploymentId,
      capabilities: app.capabilities ?? {},
    },
    grant,
    base: `${prefix}/${target}/${kind}`,
    rest: restPath,
    retry: retried ? null : () => handleAppAccessRequest({ request }, true),
  };
  switch (kind) {
    case 'rpc':
      return handleRpcAccess(context);
    case 'hook':
      return handleHookAccess(context);
    case 'data':
      return handleDataAccess(context);
    case 'tasks':
      return handleTaskAccess(context);
  }
}
