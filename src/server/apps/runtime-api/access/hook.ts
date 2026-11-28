import { appAccessAllows, isCanonicalWebhookPath } from '~server/apps/manifest';
import {
  BackendDeploymentChangedError,
  proxyAppRequest,
} from '~server/apps/runtime';
import type { AccessContext } from './index';
import { accessError, capabilityMissing, notGranted } from './errors';

/**
 * Forward to the target's webhook handler (`/__webhook/<path>`), whatever its
 * `webhook.auth`: the platform has authenticated the calling App. The target
 * tells the two apart with `verifyPlatformRequest`.
 */
export async function handleHookAccess(
  context: AccessContext,
): Promise<Response> {
  const { request, target, grant } = context;
  const path = context.rest || '/';
  if (!isCanonicalWebhookPath(path)) {
    return accessError(
      400,
      'invalid_argument',
      'Webhook paths use plain segments without "..", "." or encoded bytes.',
    );
  }
  if (!appAccessAllows(grant, { kind: 'webhook', path })) {
    return notGranted(`Webhook path ${path}`);
  }
  if (!target.capabilities.webhook || !target.capabilities.backend) {
    return capabilityMissing(target.id, 'a webhook');
  }
  try {
    return await proxyAppRequest(
      target.id,
      request,
      context.base,
      '/__webhook',
      {
        expectedDeploymentId: target.currentDeploymentId,
        caller: { appId: context.callerId, secret: target.signingSecret },
      },
    );
  } catch (error) {
    if (error instanceof BackendDeploymentChangedError && context.retry) {
      return context.retry();
    }
    return accessError(502, 'unavailable', 'App backend unavailable.');
  }
}
