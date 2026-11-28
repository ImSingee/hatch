import { appAccessAllows, isRpcMethodPath } from '~server/apps/manifest';
import {
  BackendDeploymentChangedError,
  proxyAppRequest,
} from '~server/apps/runtime';
import type { AccessContext } from './index';
import { accessError, capabilityMissing, notGranted } from './errors';

/** Forward one Connect call to a granted method of the target backend. */
export async function handleRpcAccess(
  context: AccessContext,
): Promise<Response> {
  const { request, target, grant } = context;
  const method = context.rest.slice(1);
  if (!isRpcMethodPath(method)) {
    return accessError(
      404,
      'not_found',
      'Name the method as <package.Service>/<Method>.',
    );
  }
  if (!appAccessAllows(grant, { kind: 'rpc', method })) {
    return notGranted(`RPC method ${method}`);
  }
  if (!target.capabilities.backend) {
    return capabilityMissing(target.id, 'a backend');
  }
  try {
    return await proxyAppRequest(target.id, request, context.base, '', {
      expectedDeploymentId: target.currentDeploymentId,
      caller: { appId: context.callerId, secret: target.signingSecret },
    });
  } catch (error) {
    if (error instanceof BackendDeploymentChangedError && context.retry) {
      return context.retry();
    }
    return accessError(502, 'unavailable', 'App backend unavailable.');
  }
}
