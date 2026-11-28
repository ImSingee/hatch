/**
 * Relay-owned failures, in the Connect error shape every SDK reads. Failures
 * from the target capability keep that capability's own responses.
 */
export function accessError(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { code, message },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export function notGranted(what: string): Response {
  return accessError(
    403,
    'permission_denied',
    `${what} is not granted by this App's appAccess.`,
  );
}

export function capabilityMissing(appId: string, capability: string): Response {
  return accessError(
    503,
    'unavailable',
    `App "${appId}" does not enable ${capability}.`,
  );
}
