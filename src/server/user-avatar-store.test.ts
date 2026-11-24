import { readdir, rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/hatch-avatar-test-${process.pid}-${Date.now()}`;
  process.env.HATCH_DATA_DIR = dir;
  return dir;
});

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { clearUserAvatar, getUserAvatar, readUserAvatar, setUserAvatar } =
  await import('./user-avatar-store');
const { removePlatformUser } = await import('./users-store');
const { USER_AVATAR_SIZES, userAvatarSrc } = await import('~lib/user-avatar');
const { userAvatarDir } = await import('~agent/paths');

const USER_ID = 'avatarUser1';
const OTHER_ID = 'avatarUser2';
const image = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#2F9E68' } })
    .jpeg()
    .toBuffer();
const storedImage = async (id: string) =>
  (
    await db.query.user.findFirst({
      where: { id },
      columns: { image: true },
    })
  )?.image ?? null;

beforeEach(async () => {
  await db.delete(schema.user);
  const now = new Date();
  await db.insert(schema.user).values(
    [USER_ID, OTHER_ID].map((id) => ({
      id,
      name: id,
      email: `${id}@test.local`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await rm(dataDir, { recursive: true, force: true });
});

afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe('user avatars', () => {
  it('points user.image at the current avatar and keeps only its files', async () => {
    const first = await setUserAvatar(USER_ID, await image(300, 200));
    const second = await setUserAvatar(USER_ID, await image(200, 200));

    expect(second.key).not.toBe(first.key);
    expect(second.path).toBe(`/api/users/${USER_ID}/avatar?v=${second.key}`);
    expect(await storedImage(USER_ID)).toBe(second.path);
    expect(await getUserAvatar(USER_ID)).toEqual(second);
    expect((await readdir(userAvatarDir(USER_ID))).sort()).toEqual(
      USER_AVATAR_SIZES.map((size) => `${second.key}-${size}.png`).sort(),
    );
    const served = await readUserAvatar(USER_ID, 64);
    expect(served?.key).toBe(second.key);
    expect((await sharp(served!.body).metadata()).width).toBe(64);
  });

  it('clears the avatar, its files and user.image', async () => {
    await setUserAvatar(USER_ID, await image(128, 128));

    expect(await clearUserAvatar(USER_ID)).toEqual({
      key: null,
      path: null,
      sizes: [],
    });
    expect(await storedImage(USER_ID)).toBeNull();
    expect(await readUserAvatar(USER_ID, 64)).toBeNull();
    expect(await readdir(userAvatarDir(USER_ID))).toEqual([]);
  });

  it('rejects images that are not bounded PNG, JPEG or WebP', async () => {
    const cases: [Buffer, number][] = [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 415],
      [await image(32, 32), 400],
    ];
    for (const [bytes, status] of cases)
      await expect(setUserAvatar(USER_ID, bytes)).rejects.toMatchObject({
        status,
      });
    expect(await storedImage(USER_ID)).toBeNull();
  });

  it('shows nothing for an image value the platform did not write', async () => {
    const own = await setUserAvatar(USER_ID, await image(128, 128));
    // Another user's path or an external URL is not this user's avatar.
    for (const value of [own.path, 'https://example.com/a.png'])
      await db
        .update(schema.user)
        .set({ image: value })
        .where(eq(schema.user.id, OTHER_ID));
    expect(await readUserAvatar(OTHER_ID, 64)).toBeNull();
    expect(userAvatarSrc(OTHER_ID, own.path, 32)).toBeNull();
    expect(userAvatarSrc(USER_ID, own.path, 32)).toBe(`${own.path}&size=64`);
  });

  it('removes the avatar files when the user is deleted', async () => {
    await setUserAvatar(OTHER_ID, await image(128, 128));
    await removePlatformUser(OTHER_ID, USER_ID);
    await expect(readdir(userAvatarDir(OTHER_ID))).rejects.toThrow('ENOENT');
  });

  it('rejects unknown users and ids that could escape the avatar root', async () => {
    const png = await image(128, 128);
    for (const id of ['missing-user', '../escape', 'a/b']) {
      await expect(setUserAvatar(id, png)).rejects.toMatchObject({
        status: 404,
      });
      expect(await readUserAvatar(id, 64)).toBeNull();
    }
  });
});
