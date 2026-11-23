import { eq } from 'drizzle-orm';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { releaseDeviceClaimForUser } = await import('./device-claim-store');

const expiresAt = new Date(Date.now() + 600_000);

async function grant(userCode: string, status: string, userId: string | null) {
  await db.insert(schema.deviceCode).values({
    id: userCode,
    deviceCode: `device-${userCode}`,
    userCode,
    userId,
    status,
    expiresAt,
  });
}

async function claimOf(userCode: string) {
  const [row] = await db
    .select({ userId: schema.deviceCode.userId })
    .from(schema.deviceCode)
    .where(eq(schema.deviceCode.userCode, userCode));
  return row?.userId;
}

beforeEach(async () => {
  await db.delete(schema.deviceCode);
  await db.delete(schema.user);
  const now = new Date();
  await db.insert(schema.user).values(
    ['owner', 'other'].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })),
  );
});

test('releases only the caller’s own pending claim', async () => {
  await grant('OWNPEND1', 'pending', 'owner');
  await grant('OTHPEND1', 'pending', 'other');
  await grant('OWNAPPR1', 'approved', 'owner');
  await grant('OWNDENY1', 'denied', 'owner');

  for (const code of ['OWNPEND1', 'OTHPEND1', 'OWNAPPR1', 'OWNDENY1'])
    await releaseDeviceClaimForUser('owner', code);

  expect(await claimOf('OWNPEND1')).toBeNull();
  expect(await claimOf('OTHPEND1')).toBe('other');
  expect(await claimOf('OWNAPPR1')).toBe('owner');
  expect(await claimOf('OWNDENY1')).toBe('owner');
});
