/**
 * Server-only: lease tokens of builds handed to a Builder. A token names one
 * build, the Builder holding it and the lease attempt, so a Builder can only
 * act on the build it was given, and only for as long as it holds it.
 */
import { createHmac } from 'node:crypto';
import { getPlatformEnv } from '~env';
import { secretsMatch } from '../secrets';

function key(): string {
  return createHmac('sha256', getPlatformEnv().secret)
    .update('hatch-build-lease-token')
    .digest('hex');
}

export function buildLeaseToken(lease: {
  buildId: string;
  builderId: string;
  attempt: number;
}): string {
  const payload = Buffer.from(
    JSON.stringify([lease.buildId, lease.builderId, lease.attempt]),
  ).toString('base64url');
  const signature = createHmac('sha256', key())
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

/** The lease a token names, if its signature is valid. */
export function readBuildLeaseToken(
  token: string | undefined,
): { buildId: string; builderId: string; attempt: number } | null {
  const [payload, signature] = (token ?? '').split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', key())
    .update(payload)
    .digest('base64url');
  if (!secretsMatch(signature, expected)) return null;
  try {
    const [buildId, builderId, attempt] = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as [string, string, number];
    return typeof buildId === 'string' &&
      typeof builderId === 'string' &&
      Number.isSafeInteger(attempt)
      ? { buildId, builderId, attempt }
      : null;
  } catch {
    return null;
  }
}
