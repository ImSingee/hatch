/**
 * Server-only: a user's avatar.
 *
 * The only persisted state is `user.image`, which holds the versioned path
 * of the current avatar (see `~lib/user-avatar`), and the re-encoded PNGs
 * under the user's avatar directory. Only this module writes `user.image`;
 * Better Auth's own endpoints reject it (`src/auth/server.ts`).
 */
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { userAvatarDir } from '~agent/paths';
import { db, schema } from '~/db';
import {
  USER_AVATAR_SIZES,
  userAvatarKey,
  userAvatarPath,
  type UserAvatarSize,
} from '~lib/user-avatar';
import { AppError } from '~server/errors';
import {
  encodeSquareImage,
  readSquareImage,
  removeSquareImageKey,
  writeSquareImage,
} from '~server/images/square-image';

export type UserAvatarView = {
  /** Null when the user shows initials. */
  key: string | null;
  /** Authenticated path; append `&size=64|128|256` (default 128). */
  path: string | null;
  sizes: number[];
};

function avatarView(userId: string, key: string | null): UserAvatarView {
  return {
    key,
    path: key ? userAvatarPath(userId, key) : null,
    sizes: key ? [...USER_AVATAR_SIZES] : [],
  };
}

/** The user's avatar directory, or null for an id that is not a path segment. */
function avatarDir(userId: string): string | null {
  try {
    return userAvatarDir(userId);
  } catch {
    return null;
  }
}

async function findUser(userId: string) {
  return avatarDir(userId)
    ? db.query.user.findFirst({
        where: { id: userId },
        columns: { id: true, image: true },
      })
    : undefined;
}

export async function getUserAvatar(userId: string): Promise<UserAvatarView> {
  const user = await findUser(userId);
  if (!user) throw new AppError('User not found.', 404);
  return avatarView(user.id, userAvatarKey(user.id, user.image));
}

/**
 * Point the user at `key` (or at no avatar) and return the key it replaces.
 *
 * The row lock makes concurrent set/clear calls agree on one order, so each
 * caller learns exactly which key it superseded and removes only those files.
 * Returns `undefined` when the user no longer exists.
 */
async function swapAvatarKey(
  userId: string,
  key: string | null,
): Promise<string | null | undefined> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ image: schema.user.image })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .for('update');
    if (!current) return undefined;
    await tx
      .update(schema.user)
      .set({
        image: key ? userAvatarPath(userId, key) : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.user.id, userId));
    return userAvatarKey(userId, current.image);
  });
}

function removeAvatarKeyFiles(dir: string, key: string | null) {
  return removeSquareImageKey(dir, key, USER_AVATAR_SIZES);
}

export async function setUserAvatar(
  userId: string,
  bytes: Buffer,
): Promise<UserAvatarView> {
  const dir = avatarDir(userId);
  if (!dir || !(await findUser(userId)))
    throw new AppError('User not found.', 404);
  const encoded = await encodeSquareImage(bytes, 'Avatar', USER_AVATAR_SIZES);
  const key = await writeSquareImage(dir, encoded);
  const previous = await swapAvatarKey(userId, key);
  if (previous === undefined) {
    // The user was deleted meanwhile; leave nothing behind.
    await removeAvatarKeyFiles(dir, key);
    throw new AppError('User not found.', 404);
  }
  await removeAvatarKeyFiles(dir, previous);
  return avatarView(userId, key);
}

export async function clearUserAvatar(userId: string): Promise<UserAvatarView> {
  const dir = avatarDir(userId);
  const previous = dir ? await swapAvatarKey(userId, null) : undefined;
  if (!dir || previous === undefined)
    throw new AppError('User not found.', 404);
  await removeAvatarKeyFiles(dir, previous);
  return avatarView(userId, null);
}

/** Delete every stored avatar file of a user (used when the user is removed). */
export async function removeUserAvatarFiles(userId: string): Promise<void> {
  const dir = avatarDir(userId);
  if (dir) await rm(dir, { recursive: true, force: true });
}

export async function readUserAvatar(
  userId: string,
  size: UserAvatarSize,
): Promise<{ key: string; body: Buffer } | null> {
  const user = await findUser(userId);
  const dir = avatarDir(userId);
  if (!user || !dir) return null;
  return readSquareImage(dir, userAvatarKey(user.id, user.image), size);
}
