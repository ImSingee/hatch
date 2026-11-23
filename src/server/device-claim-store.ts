/**
 * Server-only: release a device login request's claim. Only the
 * `releaseDeviceClaim` Server Function handler imports it, so it never reaches
 * the client bundle.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '~/db';

/**
 * Clear `userId`'s claim on the pending request with `userCode`.
 *
 * Only the claiming account's own pending claim changes: another account's
 * claim and decided requests are left as they are. Better Auth's approve and
 * deny write the deciding account back with the decision, so a release racing
 * a decision ends either decided by that account or pending and unclaimed.
 */
export async function releaseDeviceClaimForUser(
  userId: string,
  userCode: string,
): Promise<void> {
  const { deviceCode } = schema;
  await db
    .update(deviceCode)
    .set({ userId: null })
    .where(
      and(
        eq(deviceCode.userCode, userCode),
        eq(deviceCode.userId, userId),
        eq(deviceCode.status, 'pending'),
      ),
    );
}
