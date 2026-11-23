/**
 * Releasing a device login request claimed by the wrong account.
 *
 * Better Auth claims a pending request for whoever reads it first while signed
 * in (`GET /api/auth/device`) and offers no way back. The approval page claims
 * as soon as a verification link opens, so a browser signed in to another
 * account would strand the request. Releasing returns it to unclaimed so the
 * intended account can claim it after switching.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSession } from '~server/auth';
import { releaseDeviceClaimForUser } from './device-claim-store';

/**
 * Browser-session-bound: the approval page calls it before switching account.
 * It answers the same whether or not anything changed, so it reveals nothing
 * about codes the caller has not claimed.
 */
export const releaseDeviceClaim = createServerFn({ method: 'POST' })
  .validator(z.object({ userCode: z.string().regex(/^[A-Z0-9]{8}$/) }))
  .handler(async ({ data: { userCode } }) => {
    const session = await requireSession();
    await releaseDeviceClaimForUser(session.user.id, userCode);
  });
