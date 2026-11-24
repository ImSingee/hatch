/**
 * User avatar URLs, shared by the server and the browser.
 *
 * `user.image` holds only a path the platform wrote for an uploaded avatar:
 * `/api/users/<id>/avatar?v=<key>`. Any other value (for example one written
 * before uploads existed) is treated as no avatar.
 */

export const USER_AVATAR_SIZES = [64, 128, 256] as const;
export type UserAvatarSize = (typeof USER_AVATAR_SIZES)[number];

const PATH_RE = /^\/api\/users\/([^/?#]+)\/avatar\?v=([0-9a-z]{26})$/;

export function userAvatarPath(userId: string, key: string): string {
  return `/api/users/${encodeURIComponent(userId)}/avatar?v=${key}`;
}

/** The avatar key `image` names for `userId`, or null when it names none. */
export function userAvatarKey(
  userId: string,
  image: string | null | undefined,
): string | null {
  const match = image ? PATH_RE.exec(image) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) === userId ? match[2] : null;
  } catch {
    return null;
  }
}

/**
 * Image source for an avatar shown at `displaySize` CSS pixels: the smallest
 * stored size that stays sharp on a 2x screen. Null when there is no avatar.
 */
export function userAvatarSrc(
  userId: string,
  image: string | null | undefined,
  displaySize: number,
): string | null {
  if (!userAvatarKey(userId, image)) return null;
  const size =
    USER_AVATAR_SIZES.find((value) => value >= displaySize * 2) ??
    USER_AVATAR_SIZES[USER_AVATAR_SIZES.length - 1];
  return `${image}&size=${size}`;
}
